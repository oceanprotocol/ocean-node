import EventEmitter from 'node:events'
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
import { getConfig } from '../../utils/config.js'
import { Database } from '../database/index.js'
import { OceanNodeConfig } from '../../@types/OceanNode.js'
import { EVENTS, MetadataStates } from '../../utils/constants.js'
import { INDEXER_LOGGER } from './index.js'

// emmit events for node
export const INDEXER_DDO_EVENT_EMITTER = new EventEmitter()

class BaseEventProcessor {
  protected config: OceanNodeConfig
  protected dbConn: Database
  protected networkId: number

  constructor(chainId: number) {
    this.config = null
    this.dbConn = null
    this.networkId = chainId
    this.getConfiguration().then(async () => {
      this.dbConn = await this.getDatabase()
    })
  }

  protected async getConfiguration(): Promise<OceanNodeConfig> {
    if (!this.config) {
      this.config = await getConfig()
    }
    return this.config
  }

  protected async getDatabase(): Promise<Database> {
    if (!this.dbConn) {
      this.dbConn = new Database(this.config.dbConfig)
    }
    return this.dbConn
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
    const receipt = await provider.getTransactionReceipt(transactionHash)
    const iface = new Interface(abi)
    const eventObj = {
      topics: receipt.logs[0].topics as string[],
      data: receipt.logs[0].data
    }
    return iface.parseLog(eventObj)
  }

  public async createOrUpdateDDO(ddo: any, method: string): Promise<void> {
    try {
      const saveDDO = await this.dbConn.ddo.update({ ...ddo })
      INDEXER_LOGGER.logMessage(
        `Saved or updated DDO  : ${saveDDO.id} from network: ${this.networkId} `
      )
      // emit event
      if (method === EVENTS.METADATA_CREATED) {
        INDEXER_DDO_EVENT_EMITTER.emit(EVENTS.METADATA_CREATED, saveDDO.id)
      }
    } catch (err) {
      INDEXER_LOGGER.log(
        LOG_LEVELS_STR.LEVEL_ERROR,
        `Error retrieving & storing DDO: ${err}`,
        true
      )
    }
  }
}

export class MetadataEventProcessor extends BaseEventProcessor {
  async processEvent(
    event: ethers.Log,
    chainId: number,
    provider: JsonRpcApiProvider
  ): Promise<void> {
    try {
      const decodedEventData = await this.getEventData(
        provider,
        event.transactionHash,
        ERC721Template.abi
      )
      const byteArray = getBytes(decodedEventData.args[4])
      const utf8String = toUtf8String(byteArray)
      const ddo = JSON.parse(utf8String)
      ddo.datatokens = this.getTokenInfo(ddo.services)
      INDEXER_LOGGER.logMessage(
        `Processed new DDO data ${ddo.id} with txHash ${event.transactionHash} from block ${event.blockNumber}`,
        true
      )
      this.createOrUpdateDDO(ddo, EVENTS.ORDER_REUSED)
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
  ): Promise<void> {
    INDEXER_LOGGER.logMessage(`Processing metadata state event...`, true)
    const decodedEventData = await this.getEventData(
      provider,
      event.transactionHash,
      ERC20Template.abi
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
      let ddo = await this.dbConn.ddo.retrieve(did)
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
      this.createOrUpdateDDO(ddo, EVENTS.METADATA_STATE)
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
  ): Promise<void> {
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
      const ddo = await this.dbConn.ddo.retrieve(did)
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
      await this.dbConn.order.create(
        event.transactionHash,
        'startOrder',
        timestamp,
        consumer,
        payer
      )
      INDEXER_LOGGER.logMessage(
        `Found did ${did} for order starting on network ${chainId}`
      )
      this.createOrUpdateDDO(ddo, EVENTS.ORDER_STARTED)
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
  ): Promise<void> {
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
      const ddo = await this.dbConn.ddo.retrieve(did)
      if (!ddo) {
        INDEXER_LOGGER.logMessage(
          `Detected OrderReused changed for ${did}, but it does not exists.`
        )
        return
      }
      ddo.stats.orders += 1

      try {
        const startOrder = await this.dbConn.order.retrieve(startOrderId)
        if (!startOrder) {
          INDEXER_LOGGER.logMessage(
            `Detected OrderReused changed for order ${startOrderId}, but it does not exists.`
          )
          return
        }
        await this.dbConn.order.create(
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

      this.createOrUpdateDDO(ddo, EVENTS.ORDER_REUSED)
    } catch (err) {
      INDEXER_LOGGER.log(LOG_LEVELS_STR.LEVEL_ERROR, `Error retrieving DDO: ${err}`, true)
    }
  }
}
