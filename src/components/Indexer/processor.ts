import {
  Interface,
  JsonRpcApiProvider,
  Signer,
  ethers,
  getAddress,
  getBytes,
  hexlify,
  toUtf8Bytes,
  toUtf8String
} from 'ethers'
import { createHash } from 'crypto'
import { Readable } from 'node:stream'
import axios from 'axios'
import { toString as uint8ArrayToString } from 'uint8arrays/to-string'
import { LOG_LEVELS_STR } from '../../utils/logging/Logger.js'
import ERC721Template from '@oceanprotocol/contracts/artifacts/contracts/templates/ERC721Template.sol/ERC721Template.json' assert { type: 'json' }
import ERC20Template from '@oceanprotocol/contracts/artifacts/contracts/templates/ERC20TemplateEnterprise.sol/ERC20TemplateEnterprise.json' assert { type: 'json' }
import { getDatabase } from '../../utils/database.js'
import { PROTOCOL_COMMANDS, EVENTS, MetadataStates } from '../../utils/constants.js'
import { getDtContract, wasNFTDeployedByOurFactory } from './utils.js'
import { INDEXER_LOGGER } from '../../utils/logging/common.js'
import { Purgatory } from './purgatory.js'
import { getConfiguration, timestampToDateTime } from '../../utils/index.js'
import { OceanNode } from '../../OceanNode.js'
import { asyncCallWithTimeout, streamToString } from '../../utils/util.js'
import { DecryptDDOCommand } from '../../@types/commands.js'
import { create256Hash } from '../../utils/crypt.js'
import { URLUtils } from '../../utils/url.js'
import { makeDid } from '../core/utils/validateDdoHandler.js'
import { PolicyServer } from '../policyServer/index.js'
class BaseEventProcessor {
  protected networkId: number

  constructor(chainId: number) {
    this.networkId = chainId
  }

  protected getTokenInfo(services: any[]): any[] {
    const datatokens: any[] = []
    services.forEach((service) => {
      datatokens.push({
        address: service.datatokenAddress,
        name: 'Datatoken',
        symbol: 'DT1',
        serviceId: service.id
      })
    })
    return datatokens
  }

  protected async getEventData(
    provider: JsonRpcApiProvider,
    transactionHash: string,
    abi: any
  ): Promise<ethers.LogDescription> {
    const iface = new Interface(abi)
    const receipt = await provider.getTransactionReceipt(transactionHash)
    const eventObj = {
      topics: receipt.logs[0].topics as string[],
      data: receipt.logs[0].data
    }
    return iface.parseLog(eventObj)
  }

  protected async getNFTInfo(
    nftAddress: string,
    signer: Signer,
    owner: string,
    timestamp: number
  ): Promise<any> {
    const nftContract = new ethers.Contract(nftAddress, ERC721Template.abi, signer)
    const state = parseInt((await nftContract.getMetaData())[2])
    const id = parseInt(await nftContract.getId())
    const tokenURI = await nftContract.tokenURI(id)
    return {
      state,
      address: nftAddress,
      name: await nftContract.name(),
      symbol: await nftContract.symbol(),
      owner,
      created: timestampToDateTime(timestamp),
      tokenURI
    }
  }

  protected async createOrUpdateDDO(ddo: any, method: string): Promise<any> {
    try {
      const { ddo: ddoDatabase, ddoState } = await getDatabase()
      const saveDDO = await ddoDatabase.update({ ...ddo })
      await ddoState.update(
        this.networkId,
        saveDDO.id,
        saveDDO.nftAddress,
        saveDDO.event?.tx,
        true
      )
      INDEXER_LOGGER.logMessage(
        `Saved or updated DDO  : ${saveDDO.id} from network: ${this.networkId} triggered by: ${method}`
      )
      return saveDDO
    } catch (err) {
      const { ddoState } = await getDatabase()
      await ddoState.update(
        this.networkId,
        ddo.id,
        ddo.nftAddress,
        ddo.event?.tx,
        true,
        err.message
      )
      INDEXER_LOGGER.log(
        LOG_LEVELS_STR.LEVEL_ERROR,
        `Error found on ${this.networkId} triggered by: ${method} while creating or updating DDO: ${err}`,
        true
      )
    }
  }

  protected checkDdoHash(decryptedDocument: any, documentHashFromContract: any): boolean {
    const utf8Bytes = toUtf8Bytes(JSON.stringify(decryptedDocument))
    const expectedMetadata = hexlify(utf8Bytes)
    if (create256Hash(expectedMetadata.toString()) !== documentHashFromContract) {
      INDEXER_LOGGER.error(`DDO checksum does not match.`)
      return false
    }
    return true
  }

  protected async decryptDDO(
    decryptorURL: string,
    flag: string,
    eventCreator: string,
    contractAddress: string,
    chainId: number,
    txId: string,
    metadataHash: string,
    metadata: any
  ): Promise<any> {
    let ddo
    if (parseInt(flag) === 2) {
      INDEXER_LOGGER.logMessage(
        `Decrypting DDO  from network: ${this.networkId} created by: ${eventCreator} encrypted by: ${decryptorURL}`
      )
      const nonce = Math.floor(Date.now() / 1000).toString()
      const { keys } = await getConfiguration()
      const nodeId = keys.peerId.toString()

      const wallet: ethers.Wallet = new ethers.Wallet(process.env.PRIVATE_KEY as string)

      const message = String(
        txId + contractAddress + keys.ethAddress + chainId.toString() + nonce
      )
      const consumerMessage = ethers.solidityPackedKeccak256(
        ['bytes'],
        [ethers.hexlify(ethers.toUtf8Bytes(message))]
      )
      const signature = await wallet.signMessage(consumerMessage)

      if (URLUtils.isValidUrl(decryptorURL)) {
        try {
          const payload = {
            transactionId: txId,
            chainId,
            decrypterAddress: keys.ethAddress,
            dataNftAddress: contractAddress,
            signature,
            nonce
          }
          const response = await axios({
            method: 'post',
            url: `${decryptorURL}/api/services/decrypt`,
            data: payload
          })
          if (response.status !== 200) {
            const message = `bProvider exception on decrypt DDO. Status: ${response.status}, ${response.statusText}`
            INDEXER_LOGGER.log(LOG_LEVELS_STR.LEVEL_ERROR, message)
            throw new Error(message)
          }

          let responseHash
          if (response.data instanceof Object) {
            responseHash = create256Hash(JSON.stringify(response.data))
            ddo = response.data
          } else {
            ddo = JSON.parse(response.data)
            responseHash = create256Hash(ddo)
          }
          if (responseHash !== metadataHash) {
            const msg = `Hash check failed: response=${ddo}, decrypted ddo hash=${responseHash}\n metadata hash=${metadataHash}`
            INDEXER_LOGGER.log(LOG_LEVELS_STR.LEVEL_ERROR, msg)
            throw new Error(msg)
          }
        } catch (err) {
          const message = `Provider exception on decrypt DDO. Status: ${err.message}`
          INDEXER_LOGGER.log(LOG_LEVELS_STR.LEVEL_ERROR, message)
          throw new Error(message)
        }
      } else {
        const node = OceanNode.getInstance(await getDatabase())
        if (nodeId === decryptorURL) {
          const decryptDDOTask: DecryptDDOCommand = {
            command: PROTOCOL_COMMANDS.DECRYPT_DDO,
            transactionId: txId,
            decrypterAddress: keys.ethAddress,
            chainId,
            encryptedDocument: metadata,
            documentHash: metadataHash,
            dataNftAddress: contractAddress,
            signature,
            nonce
          }
          try {
            const response = await node
              .getCoreHandlers()
              .getHandler(PROTOCOL_COMMANDS.DECRYPT_DDO)
              .handle(decryptDDOTask)
            ddo = JSON.parse(await streamToString(response.stream as Readable))
          } catch (error) {
            const message = `Node exception on decrypt DDO. Status: ${error.message}`
            INDEXER_LOGGER.log(LOG_LEVELS_STR.LEVEL_ERROR, message)
            throw new Error(message)
          }
        } else {
          try {
            const p2pNode = await node.getP2PNode()
            let isBinaryContent = false
            const sink = async function (source: any) {
              let first = true
              for await (const chunk of source) {
                if (first) {
                  first = false
                  try {
                    const str = uint8ArrayToString(chunk.subarray()) // Obs: we need to specify the length of the subarrays
                    const decoded = JSON.parse(str)
                    if ('headers' in decoded) {
                      if (str?.toLowerCase().includes('application/octet-stream')) {
                        isBinaryContent = true
                      }
                    }
                    if (decoded.httpStatus !== 200) {
                      INDEXER_LOGGER.logMessage(
                        `Error in sink method  : ${decoded.httpStatus} errro: ${decoded.error}`
                      )
                      throw new Error('Error in sink method', decoded.error)
                    }
                  } catch (e) {
                    INDEXER_LOGGER.logMessage(
                      `Error in sink method  } error: ${e.message}`
                    )
                    throw new Error(`Error in sink method ${e.message}`)
                  }
                } else {
                  if (isBinaryContent) {
                    return chunk.subarray()
                  } else {
                    const str = uint8ArrayToString(chunk.subarray())
                    return str
                  }
                }
              }
            }
            const message = {
              command: PROTOCOL_COMMANDS.DECRYPT_DDO,
              transactionId: txId,
              decrypterAddress: keys.ethAddress,
              chainId,
              encryptedDocument: metadata,
              documentHash: metadataHash,
              dataNftAddress: contractAddress,
              signature,
              nonce
            }
            const response = await p2pNode.sendTo(
              decryptorURL,
              JSON.stringify(message),
              sink
            )
            ddo = JSON.parse(await streamToString(response.stream as Readable))
          } catch (error) {
            const message = `Node exception on decrypt DDO. Status: ${error.message}`
            INDEXER_LOGGER.log(LOG_LEVELS_STR.LEVEL_ERROR, message)
            throw new Error(message)
          }
        }
      }
    } else {
      INDEXER_LOGGER.logMessage(
        `Decompressing DDO  from network: ${this.networkId} created by: ${eventCreator} ecnrypted by: ${decryptorURL}`
      )
      const byteArray = getBytes(metadata)
      const utf8String = toUtf8String(byteArray)
      ddo = JSON.parse(utf8String)
    }

    return ddo
  }
}

export class MetadataEventProcessor extends BaseEventProcessor {
  async processEvent(
    event: ethers.Log,
    chainId: number,
    signer: Signer,
    provider: JsonRpcApiProvider,
    eventName: string
  ): Promise<any> {
    let did = 'did:op'
    try {
      const { ddo: ddoDatabase, ddoState } = await getDatabase()
      const wasDeployedByUs = await wasNFTDeployedByOurFactory(
        chainId,
        signer,
        getAddress(event.address)
      )

      if (!wasDeployedByUs) {
        INDEXER_LOGGER.log(
          LOG_LEVELS_STR.LEVEL_ERROR,
          `NFT not deployed by OPF factory`,
          true
        )
        return
      }
      const decodedEventData = await this.getEventData(
        provider,
        event.transactionHash,
        ERC721Template.abi
      )
      const metadata = decodedEventData.args[4]
      const metadataHash = decodedEventData.args[5]
      const flag = decodedEventData.args[3]
      const owner = decodedEventData.args[0]
      const ddo = await this.decryptDDO(
        decodedEventData.args[2],
        flag,
        owner,
        event.address,
        chainId,
        event.transactionHash,
        metadataHash,
        metadata
      )
      if (ddo.id !== makeDid(event.address, chainId.toString(10))) {
        INDEXER_LOGGER.error(
          `Decrypted DDO ID is not matching the generated hash for DID.`
        )
        return
      }
      // for unencrypted DDOs
      if (parseInt(flag) !== 2 && !this.checkDdoHash(ddo, metadataHash)) {
        return
      }

      did = ddo.id
      // stuff that we overwrite
      ddo.chainId = chainId
      ddo.nftAddress = event.address
      ddo.datatokens = this.getTokenInfo(ddo.services)
      ddo.nft = await this.getNFTInfo(
        ddo.nftAddress,
        signer,
        owner,
        parseInt(decodedEventData.args[6])
      )

      INDEXER_LOGGER.logMessage(
        `Processed new DDO data ${ddo.id} with txHash ${event.transactionHash} from block ${event.blockNumber}`,
        true
      )

      const previousDdo = await ddoDatabase.retrieve(ddo.id)
      if (eventName === EVENTS.METADATA_CREATED) {
        if (previousDdo && previousDdo.nft.state === MetadataStates.ACTIVE) {
          INDEXER_LOGGER.logMessage(`DDO ${ddo.id} is already registered as active`, true)
          await ddoState.update(
            this.networkId,
            did,
            event.address,
            event.transactionHash,
            false,
            `DDO ${ddo.id} is already registered as active`
          )
          return
        }
      }

      if (eventName === EVENTS.METADATA_UPDATED) {
        if (!previousDdo) {
          INDEXER_LOGGER.logMessage(
            `Previous DDO with did ${ddo.id} was not found the database. Maybe it was deleted/hidden to some violation issues`,
            true
          )
          await ddoState.update(
            this.networkId,
            did,
            event.address,
            event.transactionHash,
            false,
            `Previous DDO with did ${ddo.id} was not found the database. Maybe it was deleted/hidden to some violation issues`
          )
          return
        }
        const [isUpdateable, error] = this.isUpdateable(
          previousDdo,
          event.transactionHash,
          event.blockNumber
        )
        if (!isUpdateable) {
          INDEXER_LOGGER.error(
            `Error encountered when checking if the asset is eligiable for update: ${error}`
          )
          await ddoState.update(
            this.networkId,
            did,
            event.address,
            event.transactionHash,
            false,
            error
          )
          return
        }
      }
      const from = decodedEventData.args[0]

      // we need to store the event data (either metadata created or update and is updatable)
      if ([EVENTS.METADATA_CREATED, EVENTS.METADATA_UPDATED].includes(eventName)) {
        if (!ddo.event) {
          ddo.event = {}
        }
        ddo.event.tx = event.transactionHash
        ddo.event.from = from
        ddo.event.contract = event.address
        if (event.blockNumber) {
          ddo.event.block = event.blockNumber
          // try get block & timestamp from block (only wait 2.5 secs maximum)
          const promiseFn = provider.getBlock(event.blockNumber)
          const result = await asyncCallWithTimeout(promiseFn, 2500)
          if (result.data !== null && !result.timeout) {
            ddo.event.datetime = new Date(result.data.timestamp * 1000).toJSON()
          }
        } else {
          ddo.event.block = -1
        }

        // policyServer check
        const policyServer = new PolicyServer()
        let policyStatus
        if (eventName === EVENTS.METADATA_UPDATED)
          policyStatus = await policyServer.checkUpdateDDO(
            ddo,
            this.networkId,
            event.transactionHash,
            event
          )
        else
          policyStatus = await policyServer.checknewDDO(
            ddo,
            this.networkId,
            event.transactionHash,
            event
          )
        if (!policyStatus.success) {
          await ddoState.update(
            this.networkId,
            did,
            event.address,
            event.transactionHash,
            false,
            policyStatus.message
          )
          return
        }
      }
      // always call, but only create instance once
      const purgatory = await Purgatory.getInstance()
      // if purgatory is disabled just return false
      const updatedDDO = await this.updatePurgatoryStateDdo(ddo, from, purgatory)
      if (updatedDDO.purgatory.state === false) {
        // TODO: insert in a different collection for purgatory DDOs
        const saveDDO = this.createOrUpdateDDO(ddo, eventName)
        return saveDDO
      }
    } catch (error) {
      const { ddoState } = await getDatabase()
      await ddoState.update(
        this.networkId,
        did,
        event.address,
        event.transactionHash,
        false,
        error.message
      )
      INDEXER_LOGGER.log(
        LOG_LEVELS_STR.LEVEL_ERROR,
        `Error processMetadataEvents: ${error}`,
        true
      )
    }
  }

  async updatePurgatoryStateDdo(
    ddo: any,
    owner: string,
    purgatory: Purgatory
  ): Promise<any> {
    if (purgatory.isEnabled()) {
      const state: boolean =
        (await purgatory.isBannedAsset(ddo.id)) ||
        (await purgatory.isBannedAccount(owner))
      ddo.purgatory = {
        state
      }
    } else {
      ddo.purgatory = {
        state: false
      }
    }
    return ddo
  }

  isUpdateable(previousDdo: any, txHash: string, block: number): [boolean, string] {
    let errorMsg: string
    const ddoTxId = previousDdo.event.tx
    // do not update if we have the same txid
    if (txHash === ddoTxId) {
      errorMsg = `Previous DDO has the same tx id, no need to update: event-txid=${txHash} <> asset-event-txid=${ddoTxId}`
      INDEXER_LOGGER.log(LOG_LEVELS_STR.LEVEL_DEBUG, errorMsg, true)
      return [false, errorMsg]
    }
    const ddoBlock = previousDdo.event.block
    // do not update if we have the same block
    if (block === ddoBlock) {
      errorMsg = `Asset was updated later (block: ${ddoBlock}) vs transaction block: ${block}`
      INDEXER_LOGGER.log(LOG_LEVELS_STR.LEVEL_DEBUG, errorMsg, true)
      return [false, errorMsg]
    }

    return [true, '']
  }
}

export class MetadataStateEventProcessor extends BaseEventProcessor {
  async processEvent(
    event: ethers.Log,
    chainId: number,
    provider: JsonRpcApiProvider
  ): Promise<any> {
    INDEXER_LOGGER.logMessage(`Processing metadata state event...`, true)
    const decodedEventData = await this.getEventData(
      provider,
      event.transactionHash,
      ERC721Template.abi
    )
    const metadataState = parseInt(decodedEventData.args[1].toString())
    INDEXER_LOGGER.logMessage(`Processed new metadata state ${metadataState} `, true)
    INDEXER_LOGGER.logMessage(
      `NFT address in processing MetadataState: ${event.address} `,
      true
    )
    const did =
      'did:op:' +
      createHash('sha256')
        .update(getAddress(event.address) + chainId.toString(10))
        .digest('hex')
    try {
      const { ddo: ddoDatabase } = await getDatabase()
      let ddo = await ddoDatabase.retrieve(did)
      if (!ddo) {
        INDEXER_LOGGER.logMessage(
          `Detected MetadataState changed for ${did}, but it does not exists.`
        )
        return
      }
      INDEXER_LOGGER.logMessage(`Found did ${did} on network ${chainId}`)

      if ('nft' in ddo && ddo.nft.state !== metadataState) {
        let shortVersion = null

        if (
          ddo.nft.state === MetadataStates.ACTIVE &&
          [MetadataStates.REVOKED, MetadataStates.DEPRECATED].includes(metadataState)
        ) {
          INDEXER_LOGGER.logMessage(
            `DDO became non-visible from ${ddo.nft.state} to ${metadataState}`
          )
          shortVersion = {
            id: ddo.id,
            chainId,
            nftAddress: ddo.nftAddress,
            nft: {
              state: metadataState
            }
          }
        }

        // We should keep it here, because in further development we'll store
        // the previous structure of the non-visible DDOs (full version)
        // in case their state changes back to active.
        ddo.nft.state = metadataState
        if (shortVersion) {
          ddo = shortVersion
        }
      } else {
        // Still update until we validate and polish schemas for DDO.
        // But it should update ONLY if the first condition is met.
        // Check https://github.com/oceanprotocol/aquarius/blob/84a560ea972485e46dd3c2cfc3cdb298b65d18fa/aquarius/events/processors.py#L663
        ddo.nft = {
          state: metadataState
        }
      }
      INDEXER_LOGGER.logMessage(
        `Found did ${did} for state updating on network ${chainId}`
      )
      const savedDDO = this.createOrUpdateDDO(ddo, EVENTS.METADATA_STATE)
      return savedDDO
    } catch (err) {
      INDEXER_LOGGER.log(LOG_LEVELS_STR.LEVEL_ERROR, `Error retrieving DDO: ${err}`, true)
    }
  }
}

export class OrderStartedEventProcessor extends BaseEventProcessor {
  async processEvent(
    event: ethers.Log,
    chainId: number,
    signer: Signer,
    provider: JsonRpcApiProvider
  ): Promise<any> {
    const decodedEventData = await this.getEventData(
      provider,
      event.transactionHash,
      ERC20Template.abi
    )
    const serviceIndex = parseInt(decodedEventData.args[3].toString())
    const timestamp = parseInt(decodedEventData.args[4].toString())
    const consumer = decodedEventData.args[0].toString()
    const payer = decodedEventData.args[1].toString()
    INDEXER_LOGGER.logMessage(
      `Processed new order for service index ${serviceIndex} at ${timestamp}`,
      true
    )
    const datatokenContract = getDtContract(signer, event.address)

    const nftAddress = await datatokenContract.getERC721Address()
    const did =
      'did:op:' +
      createHash('sha256')
        .update(getAddress(nftAddress) + chainId.toString(10))
        .digest('hex')
    try {
      const { ddo: ddoDatabase, order: orderDatabase } = await getDatabase()
      const ddo = await ddoDatabase.retrieve(did)
      if (!ddo) {
        INDEXER_LOGGER.logMessage(
          `Detected OrderStarted changed for ${did}, but it does not exists.`
        )
        return
      }
      if (
        'stats' in ddo &&
        ddo.services[serviceIndex].datatokenAddress?.toLowerCase() ===
          event.address?.toLowerCase()
      ) {
        ddo.stats.orders += 1
      } else {
        // Still update until we validate and polish schemas for DDO.
        // But it should update ONLY if first condition is met.
        ddo.stats = {
          orders: 1
        }
      }
      await orderDatabase.create(
        event.transactionHash,
        'startOrder',
        timestamp,
        consumer,
        payer,
        ddo.services[serviceIndex].datatokenAddress,
        nftAddress,
        did
      )
      INDEXER_LOGGER.logMessage(
        `Found did ${did} for order starting on network ${chainId}`
      )
      const savedDDO = this.createOrUpdateDDO(ddo, EVENTS.ORDER_STARTED)
      return savedDDO
    } catch (err) {
      INDEXER_LOGGER.log(LOG_LEVELS_STR.LEVEL_ERROR, `Error retrieving DDO: ${err}`, true)
    }
  }
}

export class OrderReusedEventProcessor extends BaseEventProcessor {
  async processEvent(
    event: ethers.Log,
    chainId: number,
    signer: Signer,
    provider: JsonRpcApiProvider
  ): Promise<any> {
    const decodedEventData = await this.getEventData(
      provider,
      event.transactionHash,
      ERC20Template.abi
    )
    const startOrderId = decodedEventData.args[0].toString()
    const timestamp = parseInt(decodedEventData.args[2].toString())
    const payer = decodedEventData.args[1].toString()
    INDEXER_LOGGER.logMessage(`Processed reused order at ${timestamp}`, true)

    const datatokenContract = getDtContract(signer, event.address)

    const nftAddress = await datatokenContract.getERC721Address()
    const did =
      'did:op:' +
      createHash('sha256')
        .update(getAddress(nftAddress) + chainId.toString(10))
        .digest('hex')
    try {
      const { ddo: ddoDatabase, order: orderDatabase } = await getDatabase()
      const ddo = await ddoDatabase.retrieve(did)
      if (!ddo) {
        INDEXER_LOGGER.logMessage(
          `Detected OrderReused changed for ${did}, but it does not exists.`
        )
        return
      }
      ddo.stats.orders += 1

      try {
        const startOrder = await orderDatabase.retrieve(startOrderId)
        if (!startOrder) {
          INDEXER_LOGGER.logMessage(
            `Detected OrderReused changed for order ${startOrderId}, but it does not exists.`
          )
          return
        }
        await orderDatabase.create(
          event.transactionHash,
          'reuseOrder',
          timestamp,
          startOrder.consumer,
          payer,
          ddo.services[0].datatokenAddress,
          nftAddress,
          did,
          startOrderId
        )
      } catch (error) {
        INDEXER_LOGGER.log(
          LOG_LEVELS_STR.LEVEL_ERROR,
          `Error retrieving startOrder for reuseOrder: ${error}`,
          true
        )
      }

      const savedDDO = this.createOrUpdateDDO(ddo, EVENTS.ORDER_REUSED)
      return savedDDO
    } catch (err) {
      INDEXER_LOGGER.log(LOG_LEVELS_STR.LEVEL_ERROR, `Error retrieving DDO: ${err}`, true)
    }
  }
}
