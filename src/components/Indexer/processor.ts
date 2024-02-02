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
import { EVENTS, MetadataStates } from '../../utils/constants.js'
import { getNFTFactory, getContractAddress } from './utils.js'
import { INDEXER_LOGGER } from '../../utils/logging/common.js'
import { Purgatory } from './purgatory.js'

class BaseEventProcessor {
  protected networkId: number
  protected purgatory: Purgatory

  constructor(chainId: number) {
    this.networkId = chainId
    if (this.purgatory === null) {
      this.initPurgatory()
    }
  }

  async initPurgatory() {
    this.purgatory = new Purgatory(await getDatabase())
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

  public async createOrUpdateDDO(ddo: any, method: string): Promise<any> {
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
}

export class MetadataEventProcessor extends BaseEventProcessor {
  async processEvent(
    event: ethers.Log,
    chainId: number,
    provider: JsonRpcApiProvider,
    eventName: string
  ): Promise<any> {
    try {
      const nftFactoryAddress = getContractAddress(chainId, 'ERC721Factory')
      const nftFactoryContract = await getNFTFactory(provider, nftFactoryAddress)
      if (
        getAddress(await nftFactoryContract.erc721List(event.address)) !==
        getAddress(event.address)
      ) {
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
      const byteArray = getBytes(decodedEventData.args[4])
      const utf8String = toUtf8String(byteArray)
      const ddo = JSON.parse(utf8String)
      ddo.datatokens = this.getTokenInfo(ddo.services)
      INDEXER_LOGGER.logMessage(
        `Processed new DDO data ${ddo.id} with txHash ${event.transactionHash} from block ${event.blockNumber}`,
        true
      )
      const previousDdo = await (await getDatabase()).ddo.retrieve(ddo.id)
      if (eventName === 'MetadataCreated') {
        if (previousDdo && previousDdo.nft.state === MetadataStates.ACTIVE) {
          INDEXER_LOGGER.logMessage(
            `DDO ${ddo.did} is already registered as active`,
            true
          )
          return
        }
      }
      if (eventName === 'MetadataUpdated') {
        if (!previousDdo) {
          INDEXER_LOGGER.logMessage(
            `Previous DDO with did ${ddo.id} was not found the database. Maybe it was deleted/hidden to some violation issues`,
            true
          )
          return
        }
        const [isUpdateable, error] = this.isUpdateable(
          previousDdo,
          event.transactionHash,
          event.blockNumber
        )
        if (!isUpdateable) {
          INDEXER_LOGGER.logMessage(
            `Error encountered when checking if the asset is eligiable for update: ${error}`,
            true
          )
          return
        }
      }
      const from = decodedEventData.args[0]
      if (
        (await this.purgatory.isBannedAsset(ddo.id)) ||
        (await this.purgatory.isBannedAccount(from))
      ) {
        ddo.purgatory = {
          state: true
        }
      } else {
        ddo.purgatory = {
          state: false
        }
        const saveDDO = this.createOrUpdateDDO(ddo, eventName)
        return saveDDO
      }
    } catch (error) {
      INDEXER_LOGGER.log(
        LOG_LEVELS_STR.LEVEL_ERROR,
        `Error processMetadataEvents: ${error}`,
        true
      )
    }
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
