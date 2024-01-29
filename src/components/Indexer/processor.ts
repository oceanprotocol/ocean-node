import {
  Contract,
  Interface,
  JsonRpcApiProvider,
  ethers,
  getAddress,
  getBytes,
  toUtf8String
} from 'ethers'
import { createHash } from 'crypto'
import { LOG_LEVELS_STR } from '../../utils/logging/Logger.js'
import ERC721Template from '@oceanprotocol/contracts/artifacts/contracts/templates/ERC721Template.sol/ERC721Template.json' assert { type: 'json' }
import ERC20Template from '@oceanprotocol/contracts/artifacts/contracts/templates/ERC20TemplateEnterprise.sol/ERC20TemplateEnterprise.json' assert { type: 'json' }
import { getDatabase } from '../../utils/database.js'
import {
  DecryptDDOCommand,
  EVENTS,
  MetadataStates,
  PROTOCOL_COMMANDS
} from '../../utils/constants.js'
import { INDEXER_LOGGER } from '../../utils/logging/common.js'
import axios from 'axios'
import { getConfiguration } from '../../utils/index.js'
import { OceanNode } from '../../OceanNode.js'
import { streamToString } from '../../utils/util.js'
import { Readable } from 'node:stream'

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

  protected async createOrUpdateDDO(ddo: any, method: string): Promise<any> {
    try {
      const { ddo: ddoDatabase } = await getDatabase()
      const saveDDO = await ddoDatabase.update({ ...ddo })
      INDEXER_LOGGER.logMessage(
        `Saved or updated DDO  : ${saveDDO.id} from network: ${this.networkId} triggered by: ${method}`
      )
      return saveDDO
    } catch (err) {
      INDEXER_LOGGER.log(
        LOG_LEVELS_STR.LEVEL_ERROR,
        `Error found on ${this.networkId} triggered by: ${method} while creating or updating DDO: ${err}`,
        true
      )
    }
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
    if (flag === '0x02') {
      INDEXER_LOGGER.logMessage(
        `Decrypting DDO  from network: ${this.networkId} created by: ${eventCreator} ecnrypted by: ${decryptorURL}`
      )
      const nonce = Number(Date.now().toString())
      const { keys } = await getConfiguration()
      const nodeId = keys.peerId.toString()

      const wallet: ethers.Wallet = new ethers.Wallet(process.env.PRIVATE_KEY as string)

      // const message = String(
      //   txId + contractAddress + keys.ethAddress + chainId.toString() + nonce
      // )
      // const consumerMessage = ethers.solidityPackedKeccak256(
      //   ['bytes'],
      //   [ethers.hexlify(ethers.toUtf8Bytes(message))]
      // )
      const message = String(
        txId + contractAddress + keys.ethAddress + chainId.toString() + nonce
      )
      const consumerMessage = ethers.solidityPackedKeccak256(
        ['bytes'],
        [ethers.hexlify(ethers.toUtf8Bytes(message))]
      )
      const messageHashBytes = ethers.toBeArray(consumerMessage)
      const signature = await wallet.signMessage(messageHashBytes)
      console.log('keys.ethAddress == ', keys.ethAddress)
      console.log('wallet address == ', await wallet.getAddress())
      const addressSignature = ethers.verifyMessage(consumerMessage, signature)
      console.log('addressSignature == ', addressSignature)

      if (nodeId === decryptorURL) {
        const node = OceanNode.getInstance(await getDatabase())
        const decryptDDOTask: DecryptDDOCommand = {
          command: PROTOCOL_COMMANDS.DECRYPT_DDO,
          transactionId: txId,
          decrypterAddress: keys.ethAddress,
          chainId,
          encryptedDocument: metadata,
          documentHash: metadataHash,
          dataNftAddress: contractAddress,
          signature,
          nonce: nonce.toString()
        }
        const response = await node
          .getCoreHandlers()
          .getHandler(PROTOCOL_COMMANDS.DECRYPT_DDO)
          .handle(decryptDDOTask)
        console.log('response status == ', response.status)
        ddo = await streamToString(response.stream as Readable)
      } else {
        try {
          const payload = {
            transactionId: txId,
            chainId,
            decrypterAddress: keys.ethAddress,
            dataNftAddress: contractAddress,
            signature,
            nonce: nonce.toString()
          }
          console.log('payload == ', payload)
          const response = await axios({
            method: 'post',
            url: `${decryptorURL}/api/services/decrypt`,
            data: payload
          })
          console.log('response == ', response)
          if (response.status !== 201) {
            const message = `Provider exception on decrypt DDO. Status: ${response.status}, ${response.statusText}`
            INDEXER_LOGGER.log(LOG_LEVELS_STR.LEVEL_ERROR, message)
            throw new Error(message)
          }
          const encodedResponse = createHash('sha256').update(response.data).digest('hex')
          if (encodedResponse !== metadataHash) {
            const msg = `Hash check failed: response=${response.data}, encoded response=${encodedResponse}\n metadata hash=${metadataHash}`
            INDEXER_LOGGER.log(LOG_LEVELS_STR.LEVEL_ERROR, msg)
            throw new Error(msg)
          }
          ddo = response.data.decode('utf-8')
        } catch (err) {
          const message = `Provider exception on decrypt DDO. Status: ${err.message}`
          INDEXER_LOGGER.log(LOG_LEVELS_STR.LEVEL_ERROR, message)
          throw new Error(message)
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
    provider: JsonRpcApiProvider,
    eventName: string
  ): Promise<any> {
    try {
      const decodedEventData = await this.getEventData(
        provider,
        event.transactionHash,
        ERC721Template.abi
      )
      const ddo = await this.decryptDDO(
        decodedEventData.args[2],
        decodedEventData.args[3],
        decodedEventData.args[0],
        event.address,
        chainId,
        event.transactionHash,
        decodedEventData.args[5],
        decodedEventData.args[4]
      )
      ddo.datatokens = this.getTokenInfo(ddo.services)
      INDEXER_LOGGER.logMessage(
        `Processed new DDO data ${ddo.id} with txHash ${event.transactionHash} from block ${event.blockNumber}`,
        true
      )
      const saveDDO = this.createOrUpdateDDO(ddo, eventName)
      return saveDDO
    } catch (error) {
      INDEXER_LOGGER.log(
        LOG_LEVELS_STR.LEVEL_ERROR,
        `Error processMetadataEvents: ${error}`,
        true
      )
    }
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
            '@context': null,
            id: ddo.id,
            version: null,
            chainId: null,
            metadata: null,
            services: null,
            event: null,
            stats: null,
            purgatory: null,
            datatokens: null,
            accessDetails: null,
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
    const datatokenContract = new Contract(
      event.address,
      ERC20Template.abi,
      await provider.getSigner()
    )
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
      if ('stats' in ddo && ddo.services[serviceIndex].datatoken === event.address) {
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
        payer
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

    const datatokenContract = new Contract(
      event.address,
      ERC20Template.abi,
      await provider.getSigner()
    )
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
