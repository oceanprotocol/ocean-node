import { CommandHandler } from './handler.js'
import { EVENTS, MetadataStates, PROTOCOL_COMMANDS } from '../../../utils/constants.js'
import { P2PCommandResponse, FindDDOResponse } from '../../../@types/index.js'
import { Readable } from 'stream'
import { decrypt, create256Hash } from '../../../utils/crypt.js'
import {
  hasCachedDDO,
  sortFindDDOResults,
  findDDOLocally,
  formatService
} from '../utils/findDdoHandler.js'
import { toString as uint8ArrayToString } from 'uint8arrays/to-string'
import { GENERIC_EMOJIS, LOG_LEVELS_STR } from '../../../utils/logging/Logger.js'
import { sleep, readStream, isDefined } from '../../../utils/util.js'
import { DDO } from '../../../@types/DDO/DDO.js'
import { CORE_LOGGER } from '../../../utils/logging/common.js'
import { Blockchain, getBlockchainHandler } from '../../../utils/blockchain.js'
import { ethers, isAddress } from 'ethers'
import ERC721Template from '@oceanprotocol/contracts/artifacts/contracts/templates/ERC721Template.sol/ERC721Template.json' assert { type: 'json' }
import AccessListContract from '@oceanprotocol/contracts/artifacts/contracts/accesslists/AccessList.sol/AccessList.json' assert { type: 'json' }
// import lzma from 'lzma-native'
import lzmajs from 'lzma-purejs-requirejs'
import {
  getNftPermissions,
  getValidationSignature,
  makeDid,
  validateObject
} from '../utils/validateDdoHandler.js'
import { getConfiguration, hasP2PInterface } from '../../../utils/config.js'
import {
  GetDdoCommand,
  FindDDOCommand,
  DecryptDDOCommand,
  ValidateDDOCommand
} from '../../../@types/commands.js'
import { EncryptMethod } from '../../../@types/fileObject.js'
import {
  ValidateParams,
  buildInvalidRequestMessage,
  validateCommandParameters
} from '../../httpRoutes/validateCommands.js'
import {
  findEventByKey,
  getNetworkHeight,
  wasNFTDeployedByOurFactory
} from '../../Indexer/utils.js'
import { checkNonce } from '../utils/nonceHandler.js'
import {
  checkCredentialOnAccessList,
  existsAccessListConfigurationForChain
} from '../../../utils/credentials.js'
import { deleteIndexedMetadataIfExists, validateDDOHash } from '../../../utils/asset.js'

const MAX_NUM_PROVIDERS = 5
// after 60 seconds it returns whatever info we have available
const MAX_RESPONSE_WAIT_TIME_SECONDS = 60
// wait time for reading the next getDDO command
const MAX_WAIT_TIME_SECONDS_GET_DDO = 5

export class DecryptDdoHandler extends CommandHandler {
  validate(command: DecryptDDOCommand): ValidateParams {
    const validation = validateCommandParameters(command, [
      'decrypterAddress',
      'chainId',
      'nonce',
      'signature'
    ])
    if (validation.valid) {
      if (!isAddress(command.decrypterAddress)) {
        return buildInvalidRequestMessage(
          'Parameter : "decrypterAddress" is not a valid web3 address'
        )
      }
    }
    return validation
  }

  async handle(task: DecryptDDOCommand): Promise<P2PCommandResponse> {
    const validationResponse = await this.verifyParamsAndRateLimits(task)
    if (this.shouldDenyTaskHandling(validationResponse)) {
      return validationResponse
    }
    try {
      let decrypterAddress: string
      try {
        decrypterAddress = ethers.getAddress(task.decrypterAddress)
      } catch (error) {
        CORE_LOGGER.logMessage(`Decrypt DDO: error ${error}`, true)
        return {
          stream: null,
          status: {
            httpStatus: 400,
            error: 'Decrypt DDO: invalid parameter decrypterAddress'
          }
        }
      }

      const nonce = Number(task.nonce)
      if (isNaN(nonce)) {
        CORE_LOGGER.logMessage(
          `Decrypt DDO: error ${task.nonce} value is not a number`,
          true
        )
        return {
          stream: null,
          status: {
            httpStatus: 400,
            error: `Decrypt DDO: nonce value is not a number`
          }
        }
      }

      const node = this.getOceanNode()
      const dbNonce = node.getDatabase().nonce
      const existingNonce = await dbNonce.retrieve(decrypterAddress)

      if (existingNonce && existingNonce.nonce === nonce) {
        CORE_LOGGER.logMessage(`Decrypt DDO: error ${task.nonce} duplicate nonce`, true)
        return {
          stream: null,
          status: {
            httpStatus: 400,
            error: `Decrypt DDO: duplicate nonce`
          }
        }
      }

      await dbNonce.update(decrypterAddress, nonce)
      const chainId = String(task.chainId)
      const config = await getConfiguration()
      const supportedNetwork = config.supportedNetworks[chainId]

      // check if supported chainId
      if (!supportedNetwork) {
        CORE_LOGGER.logMessage(`Decrypt DDO: Unsupported chain id ${chainId}`, true)
        return {
          stream: null,
          status: {
            httpStatus: 400,
            error: `Decrypt DDO: Unsupported chain id`
          }
        }
      }

      if (config.authorizedDecrypters.length > 0) {
        // allow if on authorized list or it is own node
        if (
          !config.authorizedDecrypters
            .map((address) => address?.toLowerCase())
            .includes(decrypterAddress?.toLowerCase()) &&
          decrypterAddress?.toLowerCase() !== config.keys.ethAddress?.toLowerCase()
        ) {
          CORE_LOGGER.logMessage('Decrypt DDO: Decrypter not authorized', true)
          return {
            stream: null,
            status: {
              httpStatus: 403,
              error: 'Decrypt DDO: Decrypter not authorized'
            }
          }
        }
      }

      const blockchain = new Blockchain(
        supportedNetwork.rpc,
        supportedNetwork.network,
        supportedNetwork.chainId,
        supportedNetwork.fallbackRPCs
      )
      const { ready, error } = await blockchain.isNetworkReady()
      if (!ready) {
        return {
          stream: null,
          status: {
            httpStatus: 400,
            error: `Decrypt DDO: ${error}`
          }
        }
      }

      const provider = blockchain.getProvider()
      const signer = blockchain.getSigner()
      // note: "getOceanArtifactsAdresses()"" is broken for at least optimism sepolia
      // if we do: artifactsAddresses[supportedNetwork.network]
      // because on the contracts we have "optimism_sepolia" instead of "optimism-sepolia"
      // so its always safer to use the chain id to get the correct network and artifacts addresses

      const dataNftAddress = ethers.getAddress(task.dataNftAddress)
      const wasDeployedByUs = await wasNFTDeployedByOurFactory(
        supportedNetwork.chainId,
        signer,
        dataNftAddress
      )

      if (!wasDeployedByUs) {
        CORE_LOGGER.logMessage(
          'Decrypt DDO: Asset not deployed by the data NFT factory',
          true
        )
        return {
          stream: null,
          status: {
            httpStatus: 400,
            error: 'Decrypt DDO: Asset not deployed by the data NFT factory'
          }
        }
      }

      // access lit checks, needs blockchain connection
      const { authorizedDecryptersList } = config
      if (authorizedDecryptersList && Object.keys(authorizedDecryptersList).length > 0) {
        // check accessList
        const chainsListed = Object.keys(authorizedDecryptersList)
        // check the access lists for this chain
        if (chainsListed.length > 0 && chainsListed.includes(chainId)) {
          let isAllowed = false
          for (const accessListAddress of authorizedDecryptersList[chainId]) {
            // instantiate contract and check balanceOf
            const accessListContract = new ethers.Contract(
              accessListAddress,
              AccessListContract.abi,
              blockchain.getSigner()
            )

            // check access list contract
            const balance = await accessListContract.balanceOf(
              await blockchain.getSigner().getAddress()
            )
            if (Number(balance) > 0) {
              isAllowed = true
              break
            }
          }

          if (!isAllowed) {
            CORE_LOGGER.logMessage(
              'Decrypt DDO: Decrypter not authorized per access list',
              true
            )
            return {
              stream: null,
              status: {
                httpStatus: 403,
                error: 'Decrypt DDO: Decrypter not authorized per access list'
              }
            }
          }
        }
      }

      const transactionId = task.transactionId ? String(task.transactionId) : ''
      let encryptedDocument: Uint8Array
      let flags: number
      let documentHash: string

      if (transactionId) {
        try {
          const receipt = await provider.getTransactionReceipt(transactionId)
          if (!receipt.logs.length) {
            throw new Error('receipt logs 0')
          }
          const abiInterface = new ethers.Interface(ERC721Template.abi)
          const eventObject = {
            topics: receipt.logs[0].topics as string[],
            data: receipt.logs[0].data
          }
          const eventData = abiInterface.parseLog(eventObject)
          if (
            eventData.name !== EVENTS.METADATA_CREATED &&
            eventData.name !== EVENTS.METADATA_UPDATED
          ) {
            throw new Error(`event name ${eventData.name}`)
          }
          flags = parseInt(eventData.args[3], 16)
          encryptedDocument = ethers.getBytes(eventData.args[4])
          documentHash = eventData.args[5]
        } catch (error) {
          CORE_LOGGER.logMessage(`Decrypt DDO: error ${error}`, true)
          return {
            stream: null,
            status: {
              httpStatus: 400,
              error: 'Decrypt DDO: Failed to process transaction id'
            }
          }
        }
      } else {
        try {
          encryptedDocument = ethers.getBytes(task.encryptedDocument)
          flags = Number(task.flags)
          documentHash = task.documentHash
        } catch (error) {
          CORE_LOGGER.logMessage(`Decrypt DDO: error ${error}`, true)
          return {
            stream: null,
            status: {
              httpStatus: 400,
              error: 'Decrypt DDO: Failed to convert input args to bytes'
            }
          }
        }
      }

      const templateContract = new ethers.Contract(
        dataNftAddress,
        ERC721Template.abi,
        signer
      )
      const metaData = await templateContract.getMetaData()
      const metaDataState = Number(metaData[2])
      if (
        [
          MetadataStates.END_OF_LIFE,
          MetadataStates.DEPRECATED,
          MetadataStates.REVOKED
        ].includes(metaDataState)
      ) {
        CORE_LOGGER.logMessage(`Decrypt DDO: error metadata state ${metaDataState}`, true)
        return {
          stream: null,
          status: {
            httpStatus: 403,
            error: 'Decrypt DDO: invalid metadata state'
          }
        }
      }

      if (
        ![
          MetadataStates.ACTIVE,
          MetadataStates.ORDERING_DISABLED,
          MetadataStates.UNLISTED
        ].includes(metaDataState)
      ) {
        CORE_LOGGER.logMessage(`Decrypt DDO: error metadata state ${metaDataState}`, true)
        return {
          stream: null,
          status: {
            httpStatus: 400,
            error: 'Decrypt DDO: invalid metadata state'
          }
        }
      }

      let decryptedDocument: Buffer
      // check if DDO is ECIES encrypted
      if (flags & 2) {
        try {
          decryptedDocument = await decrypt(encryptedDocument, EncryptMethod.ECIES)
        } catch (error) {
          CORE_LOGGER.logMessage(`Decrypt DDO: error ${error}`, true)
          return {
            stream: null,
            status: {
              httpStatus: 400,
              error: 'Decrypt DDO: Failed to decrypt'
            }
          }
        }
      }

      if (flags & 1) {
        try {
          decryptedDocument = lzmajs.decompressFile(decryptedDocument)
          /*
          lzma.decompress(
            decryptedDocument,
            { synchronous: true },
            (decompressedResult: any) => {
              decryptedDocument = decompressedResult
            }
          )
          */
        } catch (error) {
          CORE_LOGGER.logMessage(`Decrypt DDO: error ${error}`, true)
          return {
            stream: null,
            status: {
              httpStatus: 400,
              error: 'Decrypt DDO: Failed to lzma decompress'
            }
          }
        }
      }

      // did matches
      const ddo = JSON.parse(decryptedDocument.toString())
      const clonedDdo = structuredClone(ddo)
      const updatedDdo = deleteIndexedMetadataIfExists(clonedDdo)
      if (updatedDdo.id !== makeDid(dataNftAddress, chainId)) {
        CORE_LOGGER.error(`Decrypted DDO ID is not matching the generated hash for DID.`)
        return {
          stream: null,
          status: {
            httpStatus: 400,
            error: 'Decrypt DDO: did does not match'
          }
        }
      }

      // checksum matches
      const decryptedDocumentHash = create256Hash(decryptedDocument.toString())
      if (decryptedDocumentHash !== documentHash) {
        CORE_LOGGER.logMessage(
          `Decrypt DDO: error checksum does not match ${decryptedDocumentHash} with ${documentHash}`,
          true
        )
        return {
          stream: null,
          status: {
            httpStatus: 400,
            error: 'Decrypt DDO: checksum does not match'
          }
        }
      }

      // check signature
      try {
        const message = String(
          transactionId + dataNftAddress + decrypterAddress + chainId + nonce
        )
        const messageHash = ethers.solidityPackedKeccak256(
          ['bytes'],
          [ethers.hexlify(ethers.toUtf8Bytes(message))]
        )
        const addressFromHashSignature = ethers.verifyMessage(messageHash, task.signature)
        const messageHashBytes = ethers.toBeArray(messageHash)
        const addressFromBytesSignature = ethers.verifyMessage(
          messageHashBytes,
          task.signature
        )

        if (
          addressFromHashSignature?.toLowerCase() !== decrypterAddress?.toLowerCase() &&
          addressFromBytesSignature?.toLowerCase() !== decrypterAddress?.toLowerCase()
        ) {
          throw new Error('address does not match')
        }
      } catch (error) {
        CORE_LOGGER.logMessage(`Decrypt DDO: error signature ${error}`, true)
        return {
          stream: null,
          status: {
            httpStatus: 400,
            error: 'Decrypt DDO: invalid signature or does not match'
          }
        }
      }

      return {
        stream: Readable.from(decryptedDocument.toString()),
        status: { httpStatus: 200 }
      }
    } catch (error) {
      CORE_LOGGER.logMessage(`Decrypt DDO: error ${error}`, true)
      return {
        stream: null,
        status: { httpStatus: 500, error: `Decrypt DDO: Unknown error ${error}` }
      }
    }
  }
}

export class GetDdoHandler extends CommandHandler {
  validate(command: GetDdoCommand): ValidateParams {
    let validation = validateCommandParameters(command, ['id'])
    if (validation.valid) {
      validation = validateDDOIdentifier(command.id)
    }

    return validation
  }

  async handle(task: GetDdoCommand): Promise<P2PCommandResponse> {
    const validationResponse = await this.verifyParamsAndRateLimits(task)
    if (this.shouldDenyTaskHandling(validationResponse)) {
      return validationResponse
    }
    try {
      const ddo = await this.getOceanNode().getDatabase().ddo.retrieve(task.id)
      if (!ddo) {
        return {
          stream: null,
          status: { httpStatus: 404, error: 'Not found' }
        }
      }
      return {
        stream: Readable.from(JSON.stringify(ddo)),
        status: { httpStatus: 200 }
      }
    } catch (error) {
      CORE_LOGGER.error(`Get DDO error: ${error}`)
      return {
        stream: null,
        status: { httpStatus: 500, error: 'Unknown error: ' + error.message }
      }
    }
  }
}

export class FindDdoHandler extends CommandHandler {
  validate(command: FindDDOCommand): ValidateParams {
    let validation = validateCommandParameters(command, ['id'])
    if (validation.valid) {
      validation = validateDDOIdentifier(command.id)
    }

    return validation
  }

  async handle(task: FindDDOCommand): Promise<P2PCommandResponse> {
    const validationResponse = await this.verifyParamsAndRateLimits(task)
    if (this.shouldDenyTaskHandling(validationResponse)) {
      return validationResponse
    }
    try {
      const node = this.getOceanNode()
      const p2pNode = node.getP2PNode()

      // if not P2P node just look on local DB
      if (!hasP2PInterface || !p2pNode) {
        // Checking locally only...
        const ddoInf = await findDDOLocally(node, task.id)
        const result = ddoInf ? [ddoInf] : []
        return {
          stream: Readable.from(JSON.stringify(result, null, 4)),
          status: { httpStatus: 200 }
        }
      }

      let updatedCache = false
      // result list
      const resultList: FindDDOResponse[] = []
      // if we have the result cached recently we return that result
      if (hasCachedDDO(task, p2pNode)) {
        // 'found cached DDO'
        CORE_LOGGER.logMessage('Found local cached version for DDO id: ' + task.id, true)
        resultList.push(p2pNode.getDDOCache().dht.get(task.id))
        return {
          stream: Readable.from(JSON.stringify(resultList, null, 4)),
          status: { httpStatus: 200 }
        }
      }
      // otherwise we need to contact other providers and get DDO from them
      // ids of available providers
      const providerIds: string[] = []
      let processed = 0
      let toProcess = 0

      const configuration = await getConfiguration()

      // Checking locally...
      const ddoInfo = await findDDOLocally(node, task.id)
      if (ddoInfo) {
        // node has ddo
        // add to the result list anyway
        resultList.push(ddoInfo)

        updatedCache = true
      }

      // sink fn
      const sink = async function (source: any) {
        const chunks: string[] = []
        let first = true
        try {
          for await (const chunk of source) {
            if (first) {
              first = false
              const str = uint8ArrayToString(chunk.subarray()) // Obs: we need to specify the length of the subarrays
              const decoded = JSON.parse(str)
              if (decoded.httpStatus !== 200) {
                processed++
                break
              }
            } else {
              const str = uint8ArrayToString(chunk.subarray())
              chunks.push(str)
            }
          } // end for chunk

          const ddo: any = JSON.parse(chunks.toString())

          chunks.length = 0
          // process it
          if (providerIds.length > 0) {
            const peer = providerIds.pop()
            const isResponseLegit = await checkIfDDOResponseIsLegit(ddo)
            if (isResponseLegit) {
              const ddoInfo: FindDDOResponse = {
                id: ddo.id,
                lastUpdateTx: ddo.indexedMetadata.event.tx,
                lastUpdateTime: ddo.metadata.updated,
                provider: peer
              }
              resultList.push(ddoInfo)

              CORE_LOGGER.logMessage(
                `Succesfully processed DDO info, id: ${ddo.id} from remote peer: ${peer}`,
                true
              )

              // is it cached?
              const ddoCache = p2pNode.getDDOCache()
              if (ddoCache.dht.has(ddo.id)) {
                const localValue: FindDDOResponse = ddoCache.dht.get(ddo.id)
                if (
                  new Date(ddoInfo.lastUpdateTime) > new Date(localValue.lastUpdateTime)
                ) {
                  // update cached version
                  ddoCache.dht.set(ddo.id, ddoInfo)
                }
              } else {
                // just add it to the list
                ddoCache.dht.set(ddo.id, ddoInfo)
              }
              updatedCache = true
              // also store it locally on db
              if (configuration.hasIndexer) {
                const ddoExistsLocally = await node.getDatabase().ddo.retrieve(ddo.id)
                if (!ddoExistsLocally) {
                  p2pNode.storeAndAdvertiseDDOS([ddo])
                }
              }
            } else {
              CORE_LOGGER.warn(
                `Cannot confirm validity of ${ddo.id} fetch from remote node, skipping it...`
              )
            }
          }
          processed++
        } catch (err) {
          CORE_LOGGER.logMessageWithEmoji(
            'FindDDO: Error on sink function: ' + err.message,
            true,
            GENERIC_EMOJIS.EMOJI_CROSS_MARK,
            LOG_LEVELS_STR.LEVEL_ERROR
          )
          processed++
        }
      }
      // end sink

      // if something goes really bad then exit after 60 secs
      const fnTimeout = setTimeout(() => {
        CORE_LOGGER.log(LOG_LEVELS_STR.LEVEL_DEBUG, 'FindDDO: Timeout reached: ', true)
        return {
          stream: Readable.from(JSON.stringify(sortFindDDOResults(resultList), null, 4)),
          status: { httpStatus: 200 }
        }
      }, 1000 * MAX_RESPONSE_WAIT_TIME_SECONDS)

      // check other providers for this ddo
      const providers = await p2pNode.getProvidersForDid(task.id)
      // check if includes self and exclude from check list
      if (providers.length > 0) {
        // exclude this node from the providers list if present
        const filteredProviders = providers.filter((provider: any) => {
          return provider.id.toString() !== p2pNode.getPeerId()
        })

        // work with the filtered list only
        if (filteredProviders.length > 0) {
          toProcess = filteredProviders.length
          // only process a maximum of 5 provider entries per DDO (might never be that much anyway??)
          if (toProcess > MAX_NUM_PROVIDERS) {
            filteredProviders.slice(0, MAX_NUM_PROVIDERS)
            toProcess = MAX_NUM_PROVIDERS
          }

          let doneLoop = 0
          do {
            // eslint-disable-next-line no-unmodified-loop-condition
            for (let i = 0; i < toProcess && doneLoop < toProcess; i++) {
              const provider = filteredProviders[i]
              const peer = provider.id.toString()
              const getCommand: GetDdoCommand = {
                id: task.id,
                command: PROTOCOL_COMMANDS.GET_DDO
              }
              // NOTE: do not push to response until we verify that it is legitimate
              providerIds.push(peer)

              try {
                // problem here is that even if we get the P2PCommandResponse right after await(), we still don't know
                // exactly when the chunks are written/processed/received on the sink function
                // so, better to wait/sleep some small amount of time before proceeding to the next one
                const response: P2PCommandResponse = await p2pNode.sendTo(
                  peer,
                  JSON.stringify(getCommand),
                  sink
                )
                if (response.status.httpStatus !== 200) {
                  providerIds.pop() // move to the next one
                  processed++
                }
              } catch (innerException) {
                providerIds.pop() // ignore this one
                processed++
              }
              // 'sleep 5 seconds...'
              CORE_LOGGER.logMessage(
                `Sleeping for: ${MAX_WAIT_TIME_SECONDS_GET_DDO} seconds, while getting DDO info remote peer...`,
                true
              )
              await sleep(MAX_WAIT_TIME_SECONDS_GET_DDO * 1000) // await 5 seconds before proceeding to next one
              // if the ddo is not cached, the very 1st request will take a bit longer
              // cause it needs to get the response from all the other providers call getDDO()
              // otherwise is immediate as we just return the cached version, once the cache expires we
              // repeat the procedure and query the network again, updating cache at the end
            }
            doneLoop += 1
          } while (processed < toProcess)

          if (updatedCache) {
            p2pNode.getDDOCache().updated = new Date().getTime()
          }

          // house cleaning
          clearTimeout(fnTimeout)
          return {
            stream: Readable.from(
              JSON.stringify(sortFindDDOResults(resultList), null, 4)
            ),
            status: { httpStatus: 200 }
          }
        } else {
          // could empty list
          clearTimeout(fnTimeout)
          return {
            stream: Readable.from(
              JSON.stringify(sortFindDDOResults(resultList), null, 4)
            ),
            status: { httpStatus: 200 }
          }
        }
      } else {
        // could be empty list
        clearTimeout(fnTimeout)
        return {
          stream: Readable.from(JSON.stringify(sortFindDDOResults(resultList), null, 4)),
          status: { httpStatus: 200 }
        }
      }
    } catch (error) {
      // 'FindDDO big error: '
      CORE_LOGGER.logMessageWithEmoji(
        `Error: '${error.message}' was caught while getting DDO info for id: ${task.id}`,
        true,
        GENERIC_EMOJIS.EMOJI_CROSS_MARK,
        LOG_LEVELS_STR.LEVEL_ERROR
      )
      return {
        stream: null,
        status: { httpStatus: 500, error: 'Unknown error: ' + error.message }
      }
    }
  }

  // Function to use findDDO and get DDO in desired format
  async findAndFormatDdo(ddoId: string, force: boolean = false): Promise<DDO | null> {
    const node = this.getOceanNode()
    // First try to find the DDO Locally if findDDO is not enforced
    if (!force) {
      try {
        const ddo = await node.getDatabase().ddo.retrieve(ddoId)
        return ddo as DDO
      } catch (error) {
        CORE_LOGGER.logMessage(
          `Unable to find DDO locally. Proceeding to call findDDO`,
          true
        )
      }
    }
    try {
      const task: FindDDOCommand = {
        id: ddoId,
        command: PROTOCOL_COMMANDS.FIND_DDO,
        force
      }
      const response: P2PCommandResponse = await this.handle(task)

      if (response && response?.status?.httpStatus === 200 && response?.stream) {
        const streamData = await readStream(response.stream)
        const ddoList = JSON.parse(streamData)

        // Assuming the first DDO in the list is the one we want
        const ddoData = ddoList[0]
        if (!ddoData) {
          return null
        }

        // Format each service according to the Service interface
        const formattedServices = ddoData.services.map(formatService)

        // Map the DDO data to the DDO interface
        const ddo: DDO = {
          '@context': ddoData['@context'],
          id: ddoData.id,
          version: ddoData.version,
          nftAddress: ddoData.nftAddress,
          chainId: ddoData.chainId,
          metadata: ddoData.metadata,
          services: formattedServices,
          credentials: ddoData.credentials,
          indexedMetadata: {
            stats: ddoData.indexedMetadata.stats,
            event: ddoData.indexedMetadata.event,
            nft: ddoData.indexedMetadata.nft
          }
        }

        return ddo
      }

      return null
    } catch (error) {
      CORE_LOGGER.log(
        LOG_LEVELS_STR.LEVEL_ERROR,
        `Error finding DDO: ${error.message}`,
        true
      )
      return null
    }
  }
}

export class ValidateDDOHandler extends CommandHandler {
  validate(command: ValidateDDOCommand): ValidateParams {
    let validation = validateCommandParameters(command, ['ddo'])
    if (validation.valid) {
      validation = validateDDOIdentifier(command.ddo.id)
    }

    return validation
  }

  async handle(task: ValidateDDOCommand): Promise<P2PCommandResponse> {
    const validationResponse = await this.verifyParamsAndRateLimits(task)
    if (this.shouldDenyTaskHandling(validationResponse)) {
      return validationResponse
    }
    try {
      const validation = await validateObject(
        task.ddo,
        task.ddo.chainId,
        task.ddo.nftAddress
      )
      if (validation[0] === false) {
        CORE_LOGGER.logMessageWithEmoji(
          `Validation failed with error: ${validation[1]}`,
          true,
          GENERIC_EMOJIS.EMOJI_CROSS_MARK,
          LOG_LEVELS_STR.LEVEL_ERROR
        )
        return {
          stream: null,
          status: { httpStatus: 400, error: `Validation error: ${validation[1]}` }
        }
      }

      // command contains optional parameter publisherAddress
      // command contains optional parameter nonce and nonce is valid for publisherAddress
      // command contains optional parameter signature which is the signed message based on nonce by publisherAddress
      // ddo.nftAddress exists and it's valid (done above on validateObject())
      // publisherAddress has updateMetadata role on ddo.nftAddress contract
      // publisherAddress has publishing rights on this node (see #815) (TODO needs other PR merged first)

      if (task.publisherAddress && task.nonce && task.signature) {
        const nonceDB = this.getOceanNode().getDatabase().nonce
        const nonceValid = await checkNonce(
          nonceDB,
          task.publisherAddress,
          Number(task.nonce),
          task.signature,
          task.ddo.id + task.nonce
        )

        if (!nonceValid.valid) {
          // BAD NONCE OR SIGNATURE
          return {
            stream: null,
            status: { httpStatus: 403, error: 'Invalid nonce' }
          }
        }

        const chain = String(task.ddo.chainId)
        // has publishing rights on this node?
        const { authorizedPublishers, authorizedPublishersList, supportedNetworks } =
          await getConfiguration()
        const validChain = isDefined(supportedNetworks[chain])
        // first check if chain is valid
        if (validChain) {
          const blockChain = getBlockchainHandler(supportedNetworks[chain])

          // check also NFT permissions
          const hasUpdateMetadataPermissions = await (
            await getNftPermissions(
              blockChain.getSigner(),
              task.ddo.nftAddress,
              ERC721Template.abi,
              task.publisherAddress
            )
          ).updateMetadata
          console.log('hasUpdateMetadataPermissions:', hasUpdateMetadataPermissions)

          if (!hasUpdateMetadataPermissions) {
            // Has no update metadata permissions
            return {
              stream: null,
              status: {
                httpStatus: 400,
                error: `Validation error: Publisher: ${task.publisherAddress} does not have "updateMetadata" permissions`
              }
            }
          }

          let hasPublisherRights = false

          // 1 ) check if publisher address is part of AUTHORIZED_PUBLISHERS
          const isAuthorizedPublisher =
            authorizedPublishers.length > 0 &&
            authorizedPublishers.filter(
              (publisher) =>
                publisher.toLowerCase() === task.publisherAddress.toLowerCase()
            ).length > 0

          if (isAuthorizedPublisher) {
            hasPublisherRights = true
          } else {
            // 2 ) check if there is an access list for this chain: AUTHORIZED_PUBLISHERS_LIST
            const existsAccessList = existsAccessListConfigurationForChain(
              authorizedPublishersList,
              chain
            )
            if (existsAccessList) {
              // check access list contracts
              hasPublisherRights = await checkCredentialOnAccessList(
                authorizedPublishersList,
                chain,
                task.publisherAddress,
                await blockChain.getSigner()
              )
            }
          }

          if (!hasPublisherRights) {
            return {
              stream: null,
              status: {
                httpStatus: 400,
                error: `Validation error: publisher address is invalid for this node`
              }
            }
          }
        } else {
          // the chain is not supported, so we can't validate on this node
          return {
            stream: null,
            status: {
              httpStatus: 400,
              error: `Validation error: DDO chain is invalid for this node`
            }
          }
        }

        // ALL GOOD - ADD SIGNATURE
        const signature = await getValidationSignature(JSON.stringify(task.ddo))
        return {
          stream: Readable.from(JSON.stringify(signature)),
          status: { httpStatus: 200 }
        }
      }
      // Missing signature, nonce or publisher address
      // DDO is a valid object, but we cannot verify the signatures
      // const msg =
      //   'Partial validation: DDO is valid, but none of "publisher address", "signature" or "nonce" are present. Cannot add validation signature'
      // return {
      //   stream: Readable.from(JSON.stringify(msg)),
      //   status: {
      //     httpStatus: 200,
      //     error: msg
      //   }
      // }
      return {
        stream: null,
        status: {
          httpStatus: 400,
          error: `Validation error: Either publisher address is missing or there is an invalid signature/nonce`
        }
      }
    } catch (error) {
      CORE_LOGGER.logMessageWithEmoji(
        `Error occurred on validateDDO command: ${error}`,
        true,
        GENERIC_EMOJIS.EMOJI_CROSS_MARK,
        LOG_LEVELS_STR.LEVEL_ERROR
      )
      return {
        stream: null,
        status: { httpStatus: 500, error: 'Unknown error: ' + error.message }
      }
    }
  }
}

export function validateDDOIdentifier(identifier: string): ValidateParams {
  const valid = identifier && identifier.length > 0 && identifier.startsWith('did:op')
  if (!valid) {
    return {
      valid: false,
      status: 400,
      reason: ' Missing or invalid required parameter "id'
    }
  }
  return {
    valid: true
  }
}

/**
 * Checks if the response is legit
 * @param ddo the DDO
 * @returns validation result
 */
async function checkIfDDOResponseIsLegit(ddo: any): Promise<boolean> {
  const clonedDdo = structuredClone(ddo)
  const { indexedMetadata } = clonedDdo
  const updatedDdo = deleteIndexedMetadataIfExists(ddo)
  const { nftAddress, chainId } = updatedDdo
  let isValid = validateDDOHash(updatedDdo.id, nftAddress, chainId)
  // 1) check hash sha256(nftAddress + chainId)
  if (!isValid) {
    CORE_LOGGER.error(`Asset ${updatedDdo.id} does not have a valid hash`)
    return false
  }

  // 2) check event
  if (!event) {
    return false
  }

  // 3) check if we support this network
  const config = await getConfiguration()
  const network = config.supportedNetworks[chainId.toString()]
  if (!network) {
    CORE_LOGGER.error(
      `We do not support the newtwork ${chainId}, cannot confirm validation.`
    )
    return false
  }
  // 4) check if was deployed by our factory
  const blockchain = new Blockchain(
    network.rpc,
    network.network,
    chainId,
    network.fallbackRPCs
  )
  const signer = blockchain.getSigner()

  const wasDeployedByUs = await wasNFTDeployedByOurFactory(
    chainId as number,
    signer,
    ethers.getAddress(nftAddress)
  )

  if (!wasDeployedByUs) {
    CORE_LOGGER.error(`Asset ${updatedDdo.id} not deployed by the data NFT factory`)
    return false
  }

  // 5) check block & events
  const networkBlock = await getNetworkHeight(blockchain.getProvider())
  if (
    !indexedMetadata.event.block ||
    indexedMetadata.event.block < 0 ||
    networkBlock < indexedMetadata.event.block
  ) {
    CORE_LOGGER.error(
      `Event block: ${indexedMetadata.event.block} is either missing or invalid`
    )
    return false
  }

  // check events on logs
  const txId: string = indexedMetadata.event.tx // NOTE: DDO is txid, Asset is tx
  if (!txId) {
    CORE_LOGGER.error(`DDO event missing tx data, cannot confirm transaction`)
    return false
  }
  const receipt = await blockchain.getProvider().getTransactionReceipt(txId)
  let foundEvents = false
  if (receipt) {
    const { logs } = receipt
    for (const log of logs) {
      const event = findEventByKey(log.topics[0])
      if (event && Object.values(EVENTS).includes(event.type)) {
        if (
          event.type === EVENTS.METADATA_CREATED ||
          event.type === EVENTS.METADATA_UPDATED
        ) {
          foundEvents = true
          break
        }
      }
    }
    isValid = foundEvents
  } else {
    isValid = false
  }

  return isValid
}
