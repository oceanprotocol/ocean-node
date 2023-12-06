import {
  Interface,
  JsonRpcApiProvider,
  ethers,
  getAddress,
  getBytes,
  toUtf8String
} from 'ethers'
import { createHash } from 'crypto'
import {
  CustomNodeLogger,
  LOGGER_MODULE_NAMES,
  LOG_LEVELS_STR,
  defaultConsoleTransport,
  getCustomLoggerForModule
} from '../../utils/logging/Logger.js'
import ERC721Template from '@oceanprotocol/contracts/artifacts/contracts/templates/ERC721Template.sol/ERC721Template.json' assert { type: 'json' }
import ERC20Template from '@oceanprotocol/contracts/artifacts/contracts/templates/ERC20Template.sol/ERC20Template.json' assert { type: 'json' }
import { getConfig } from '../../utils/config.js'
import { Database } from '../database/index.js'
export const INDEXER_LOGGER: CustomNodeLogger = getCustomLoggerForModule(
  LOGGER_MODULE_NAMES.INDEXER,
  LOG_LEVELS_STR.LEVEL_INFO,
  defaultConsoleTransport
)

const config = await getConfig()

export const processMetadataCreatedEvent = async (
  event: ethers.Log,
  chainId: number,
  provider: JsonRpcApiProvider
) => {
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
  INDEXER_LOGGER.logMessage(`Processed new DDO data ${ddo} `, true)
  return ddo
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
  INDEXER_LOGGER.logMessage(
    `Processed new order for service index ${serviceIndex} at ${timestamp}`,
    true
  )
  const dbconn = await new Database(config.dbConfig)
  const did =
    'did:op:' +
    createHash('sha256')
      .update(getAddress(event.address) + chainId.toString(10))
      .digest('hex')
  try {
    const ddo = await dbconn.ddo.retrieve(did)
    if (!ddo) {
      INDEXER_LOGGER.logMessage(
        `Detected OrderStarted changed for ${did}, but it does not exists.`
      )
      return
    }
    INDEXER_LOGGER.logMessage(`Found did ${did} on network ${chainId}`)
    if ('stats' in ddo && ddo.services[serviceIndex].datatoken === event.address) {
      ddo.stats.orders += 1
    } else {
      // Still update until we validate and polish schemas for DDO.
      // But it should update ONLY if first condition is met.
      ddo.stats = {
        orders: 1
      }
    }
    INDEXER_LOGGER.logMessage(`Found did ${did} for order starting on network ${chainId}`)
    return ddo
  } catch (err) {
    INDEXER_LOGGER.log(LOG_LEVELS_STR.LEVEl_ERROR, `Error retrieving DDO: ${err}`, true)
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
  const byteArray = getBytes(decodedEventData.args[0])
  const orderTxId = toUtf8String(byteArray)
  const timestamp = parseInt(decodedEventData.args[2].toString())
  INDEXER_LOGGER.logMessage(
    `Processed reused order for order ${orderTxId} at ${timestamp}`,
    true
  )
  const dbconn = await new Database(config.dbConfig)
  const did =
    'did:op:' +
    createHash('sha256')
      .update(getAddress(event.address) + chainId.toString(10))
      .digest('hex')
  try {
    const ddo = await dbconn.ddo.retrieve(did)
    if (!ddo) {
      INDEXER_LOGGER.logMessage(
        `Detected OrderReused changed for ${did}, but it does not exists.`
      )
      return
    }
    INDEXER_LOGGER.logMessage(`Found did ${did} on network ${chainId}`)
    ddo.stats.orders += 1
    INDEXER_LOGGER.logMessage(`Found did ${did} for order starting on network ${chainId}`)
    return ddo
  } catch (err) {
    INDEXER_LOGGER.log(LOG_LEVELS_STR.LEVEl_ERROR, `Error retrieving DDO: ${err}`, true)
  }
}
