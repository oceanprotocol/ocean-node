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
import { MetadataStates } from '../../utils/constants.js'
import { INDEXER_LOGGER } from './index.js'

let config: OceanNodeConfig
// Lazy load configuration
async function getConfiguration(): Promise<OceanNodeConfig> {
  if (!config) {
    config = await getConfig()
  }
  return config
}

function getTokenInfo(services: any[]): any[] {
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

export const processMetadataEvents = async (
  event: ethers.Log,
  chainId: number,
  provider: JsonRpcApiProvider
) => {
  try {
    const receipt = await provider.getTransactionReceipt(event.transactionHash)
    const iface = new Interface(ERC721Template.abi)
    const eventObj = {
      topics: receipt.logs[0].topics as string[],
      data: receipt.logs[0].data
    }
    const decodedEventData = iface.parseLog(eventObj)
    const byteArray = getBytes(decodedEventData.args[4])
    const utf8String = toUtf8String(byteArray)
    const ddo = JSON.parse(utf8String)
    ddo.datatokens = getTokenInfo(ddo.services)
    INDEXER_LOGGER.logMessage(
      `Processed new DDO data ${ddo.id} with txHash ${event.transactionHash} from block ${event.blockNumber}`,
      true
    )
    return ddo
  } catch (error) {
    INDEXER_LOGGER.log(
      LOG_LEVELS_STR.LEVEL_ERROR,
      `Error processMetadataEvents : ${error}`,
      true
    )
  }
}

export const processMetadataStateEvent = async (
  event: ethers.Log,
  chainId: number,
  provider: JsonRpcApiProvider
) => {
  INDEXER_LOGGER.logMessage(`Processing metadata state event...`, true)
  const iface = new Interface(ERC721Template.abi)
  const receipt = await provider.getTransactionReceipt(event.transactionHash)
  const eventObj = {
    topics: receipt.logs[0].topics as string[],
    data: receipt.logs[0].data
  }
  const decodedEventData = iface.parseLog(eventObj)
  const metadataState = parseInt(decodedEventData.args[1].toString())
  INDEXER_LOGGER.logMessage(`Processed new metadata state ${metadataState} `, true)
  const dbconn = await new Database(await (await getConfiguration()).dbConfig)
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
    let ddo = null
    try {
      ddo = await dbconn.ddo.retrieve(did)
    } catch (err) {
      INDEXER_LOGGER.log(LOG_LEVELS_STR.LEVEL_ERROR, `Error retrieving DDO: ${err}`, true)
    }
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
    INDEXER_LOGGER.logMessage(`Found did ${did} for state updating on network ${chainId}`)
    return ddo
  } catch (err) {
    INDEXER_LOGGER.log(LOG_LEVELS_STR.LEVEL_ERROR, `Error retrieving DDO: ${err}`, true)
  }
}

export const processOrderStartedEvent = async (
  event: ethers.Log,
  chainId: number,
  provider: JsonRpcApiProvider
) => {
  const receipt = await provider.getTransactionReceipt(event.transactionHash)
  const iface = new Interface(ERC20Template.abi)
  const eventObj = {
    topics: receipt.logs[0].topics as string[],
    data: receipt.logs[0].data
  }
  const decodedEventData = iface.parseLog(eventObj)
  const serviceIndex = parseInt(decodedEventData.args[3].toString())
  const timestamp = parseInt(decodedEventData.args[4].toString())
  const consumer = decodedEventData.args[0].toString()
  const payer = decodedEventData.args[1].toString()
  INDEXER_LOGGER.logMessage(
    `Processed new order for service index ${serviceIndex} at ${timestamp}`,
    true
  )
  const config = await getConfiguration()
  const dbconn = await new Database(config.dbConfig)
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
    let ddo = null
    try {
      ddo = await dbconn.ddo.retrieve(did)
    } catch (err) {
      INDEXER_LOGGER.log(LOG_LEVELS_STR.LEVEL_ERROR, `Error retrieving DDO: ${err}`, true)
    }
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
    await dbconn.order.create(
      event.transactionHash,
      'startOrder',
      timestamp,
      consumer,
      payer
    )
    INDEXER_LOGGER.logMessage(`Found did ${did} for order starting on network ${chainId}`)
    return ddo
  } catch (err) {
    INDEXER_LOGGER.log(LOG_LEVELS_STR.LEVEL_ERROR, `Error retrieving DDO: ${err}`, true)
  }
}

export const processOrderReusedEvent = async (
  event: ethers.Log,
  chainId: number,
  provider: JsonRpcApiProvider
) => {
  const receipt = await provider.getTransactionReceipt(event.transactionHash)
  const iface = new Interface(ERC20Template.abi)
  const eventObj = {
    topics: receipt.logs[0].topics as string[],
    data: receipt.logs[0].data
  }
  const decodedEventData = iface.parseLog(eventObj)
  const startOrderId = decodedEventData.args[0].toString()
  const timestamp = parseInt(decodedEventData.args[2].toString())
  const payer = decodedEventData.args[1].toString()
  INDEXER_LOGGER.logMessage(`Processed reused order at ${timestamp}`, true)
  const config = await getConfiguration()
  const dbconn = await new Database(config.dbConfig)
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
    let ddo = null
    try {
      ddo = await dbconn.ddo.retrieve(did)
    } catch (err) {
      INDEXER_LOGGER.log(LOG_LEVELS_STR.LEVEL_ERROR, `Error retrieving DDO: ${err}`, true)
    }
    if (!ddo) {
      INDEXER_LOGGER.logMessage(
        `Detected OrderReused changed for ${did}, but it does not exists.`
      )
      return
    }
    ddo.stats.orders += 1

    try {
      const startOrder = await dbconn.order.retrieve(startOrderId)
      if (!startOrder) {
        INDEXER_LOGGER.logMessage(
          `Detected OrderReused changed for order ${startOrderId}, but it does not exists.`
        )
        return
      }
      await dbconn.order.create(
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

    return ddo
  } catch (err) {
    INDEXER_LOGGER.log(LOG_LEVELS_STR.LEVEL_ERROR, `Error retrieving DDO: ${err}`, true)
  }
}
