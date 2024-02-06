import { Handler } from './handler.js'
import { MetadataStates, PROTOCOL_COMMANDS } from '../../utils/constants.js'
import { P2PCommandResponse } from '../../@types'
import { Readable } from 'stream'
import {
  hasCachedDDO,
  sortFindDDOResults,
  findDDOLocally,
  formatService
} from './utils/findDdoHandler.js'
import { toString as uint8ArrayToString } from 'uint8arrays/to-string'
import { GENERIC_EMOJIS, LOG_LEVELS_STR } from '../../utils/logging/Logger.js'
import { sleep, readStream } from '../../utils/util.js'
import { DDO } from '../../@types/DDO/DDO.js'
import { FindDDOResponse } from '../../@types/index.js'
import { CORE_LOGGER } from '../../utils/logging/common.js'
import { Blockchain } from '../../utils/blockchain.js'
import ERC721Factory from '@oceanprotocol/contracts/artifacts/contracts/ERC721Factory.sol/ERC721Factory.json' assert { type: 'json' }
import { getOceanArtifactsAdresses } from '../../utils/address.js'
import { ethers, hexlify } from 'ethers'
import ERC721Template from '@oceanprotocol/contracts/artifacts/contracts/templates/ERC721Template.sol/ERC721Template.json' assert { type: 'json' }
import { decrypt } from '../../utils/crypt.js'
import { createHash } from 'crypto'
import lzma from 'lzma-native'
import { validateObject } from './utils/validateDdoHandler.js'
import { getConfiguration } from '../../utils/config.js'
import {
  GetDdoCommand,
  FindDDOCommand,
  DecryptDDOCommand,
  ValidateDDOCommand
} from '../../@types/commands.js'

const MAX_NUM_PROVIDERS = 5
// after 60 seconds it returns whatever info we have available
const MAX_RESPONSE_WAIT_TIME_SECONDS = 60
// wait time for reading the next getDDO command
const MAX_WAIT_TIME_SECONDS_GET_DDO = 5

export class DecryptDdoHandler extends Handler {
  async handle(task: DecryptDDOCommand): Promise<P2PCommandResponse> {
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

      if (!config.authorizedDecrypters.includes(decrypterAddress)) {
        CORE_LOGGER.logMessage('Decrypt DDO: Decrypter not authorized', true)
        return {
          stream: null,
          status: {
            httpStatus: 403,
            error: 'Decrypt DDO: Decrypter not authorized'
          }
        }
      }

      const blockchain = new Blockchain(supportedNetwork.rpc, supportedNetwork.chainId)
      const provider = blockchain.getProvider()
      const signer = await provider.getSigner()
      const artifactsAddresses = getOceanArtifactsAdresses()
      const factoryAddress = ethers.getAddress(
        artifactsAddresses[supportedNetwork.network].ERC721Factory
      )
      const factoryContract = new ethers.Contract(
        factoryAddress,
        ERC721Factory.abi,
        signer
      )
      const dataNftAddress = ethers.getAddress(task.dataNftAddress)
      const factoryListAddress = await factoryContract.erc721List(dataNftAddress)

      if (dataNftAddress !== factoryListAddress) {
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
          if (eventData.name !== 'MetadataCreated') {
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
          decryptedDocument = await decrypt(encryptedDocument, 'ECIES')
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
          lzma.decompress(
            decryptedDocument,
            { synchronous: true },
            (decompressedResult) => {
              decryptedDocument = decompressedResult
            }
          )
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

      // checksum matches
      const decryptedDocumentHash =
        '0x' + createHash('sha256').update(hexlify(decryptedDocument)).digest('hex')
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
          addressFromHashSignature !== decrypterAddress &&
          addressFromBytesSignature !== decrypterAddress
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
        status: { httpStatus: 201 }
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

export class GetDdoHandler extends Handler {
  async handle(task: GetDdoCommand): Promise<P2PCommandResponse> {
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
      return {
        stream: null,
        status: { httpStatus: 500, error: 'Unknown error: ' + error.message }
      }
    }
  }
}

export class FindDdoHandler extends Handler {
  async handle(task: FindDDOCommand): Promise<P2PCommandResponse> {
    try {
      const node = this.getOceanNode()
      const p2pNode = node.getP2PNode()
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
          const ddo = JSON.parse(chunks.toString())
          chunks.length = 0
          // process it
          if (providerIds.length > 0) {
            const peer = providerIds.pop()
            const ddoInfo: FindDDOResponse = {
              id: ddo.id,
              lastUpdateTx: ddo.event.tx,
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

      // Checking locally...
      const ddoInfo = await findDDOLocally(node, task.id)
      if (ddoInfo) {
        // node has ddo
        // add to the result list anyway
        resultList.push(ddoInfo)

        updatedCache = true
      }

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
  async findAndFormatDdo(ddoId: string): Promise<DDO | null> {
    const node = this.getOceanNode()
    // First try to find the DDO Locally
    try {
      const ddo = await node.getDatabase().ddo.retrieve(ddoId)
      return ddo as DDO
    } catch (error) {
      CORE_LOGGER.logMessage(
        `Unable to find DDO locally. Proceeding to call findDDO`,
        true
      )
    }
    try {
      const task: FindDDOCommand = {
        id: ddoId,
        command: PROTOCOL_COMMANDS.FIND_DDO
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
          event: ddoData.event
        }

        return ddo
      }

      return null
    } catch (error) {
      CORE_LOGGER.logMessage(`Error getting DDO: ${error}`, true)
      return null
    }
  }
}

export class ValidateDDOHandler extends Handler {
  async handle(task: ValidateDDOCommand): Promise<P2PCommandResponse> {
    try {
      const ddo = await this.getOceanNode().getDatabase().ddo.retrieve(task.id)
      if (!ddo) {
        CORE_LOGGER.logMessageWithEmoji(
          `DDO ${task.id} was not found the database.`,
          true,
          GENERIC_EMOJIS.EMOJI_CROSS_MARK,
          LOG_LEVELS_STR.LEVEL_ERROR
        )
        return {
          stream: null,
          status: { httpStatus: 404, error: 'Not found' }
        }
      }
      const validation = await validateObject(ddo, task.chainId, task.nftAddress)
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
      return {
        stream: Readable.from(JSON.stringify({})),
        status: { httpStatus: 200 }
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
