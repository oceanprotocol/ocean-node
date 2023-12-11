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
import {
  CustomNodeLogger,
  LOGGER_MODULE_NAMES,
  LOG_LEVELS_STR,
  defaultConsoleTransport,
  getCustomLoggerForModule
} from '../../utils/logging/Logger.js'
import ERC721Template from '@oceanprotocol/contracts/artifacts/contracts/templates/ERC721Template.sol/ERC721Template.json' assert { type: 'json' }
import ERC20Template from '@oceanprotocol/contracts/artifacts/contracts/templates/ERC20TemplateEnterprise.sol/ERC20TemplateEnterprise.json' assert { type: 'json' }
import { getConfig } from '../../utils/config.js'
import { Database } from '../database/index.js'
import { OceanNodeConfig } from '../../@types/OceanNode.js'
export const INDEXER_LOGGER: CustomNodeLogger = getCustomLoggerForModule(
  LOGGER_MODULE_NAMES.INDEXER,
  LOG_LEVELS_STR.LEVEL_INFO,
  defaultConsoleTransport
)

let config: OceanNodeConfig
// Lazy load configuration
async function getConfiguration(): Promise<OceanNodeConfig> {
  if (!config) {
    config = await getConfig()
  }
  return config
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

    INDEXER_LOGGER.logMessage(
      `Processed new DDO data ${ddo.id} with txHash ${event.transactionHash} from block ${event.blockNumber}`,
      true
    )
    return ddo
  } catch (error) {
    INDEXER_LOGGER.log(
      LOG_LEVELS_STR.LEVEl_ERROR,
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
  const config = await getConfiguration()
  const dbconn = await new Database(config.dbConfig)
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
    const ddo = await dbconn.ddo.retrieve(did)
    if (!ddo) {
      INDEXER_LOGGER.logMessage(
        `Detected MetadataState changed for ${did}, but it does not exists.`
      )
      return
    }
    if ('nft' in ddo && ddo.nft.state !== metadataState) {
      ddo.nft.state = metadataState
    } else {
      // Still update until we validate and polish schemas for DDO.
      // But it should update ONLY if first condition is met.
      // Check https://github.com/oceanprotocol/aquarius/blob/84a560ea972485e46dd3c2cfc3cdb298b65d18fa/aquarius/events/processors.py#L663
      ddo.nft = {
        state: metadataState
      }
    }
    INDEXER_LOGGER.logMessage(`Found did ${did} for state updating on network ${chainId}`)
    return ddo
  } catch (err) {
    INDEXER_LOGGER.log(LOG_LEVELS_STR.LEVEl_ERROR, `Error retrieving DDO: ${err}`, true)
  }
}

export const processOrderStartedEvent = async (
  event: ethers.Log,
  chainId: number,
  provider: JsonRpcApiProvider
) => {
  INDEXER_LOGGER.logMessage(`Entering OrderStarted processing`)
  const receipt = await provider.getTransactionReceipt(event.transactionHash)
  INDEXER_LOGGER.logMessage(`Tx receipt OrderStarted processing: ${receipt}`)
  const iface = new Interface(ERC20Template.abi)
  const eventObj = {
    topics: receipt.logs[0].topics as string[],
    data: receipt.logs[0].data
  }
  const decodedEventData = iface.parseLog(eventObj)
  INDEXER_LOGGER.logMessage(`Decoded data OrderStarted processing: ${receipt}`)
  const serviceIndex = parseInt(decodedEventData.args[3].toString())
  const timestamp = parseInt(decodedEventData.args[4].toString())
  // const consumer = toUtf8String(getBytes(decodedEventData.args[0]))
  // INDEXER_LOGGER.logMessage(`Consumer for the order: ${consumer}`)
  // const payer = toUtf8String(getBytes(decodedEventData.args[1]))
  // INDEXER_LOGGER.logMessage(`Payer for the order: ${payer}`)
  INDEXER_LOGGER.logMessage(
    `Processed new order for service index ${serviceIndex} at ${timestamp}`,
    true
  )
  const config = await getConfiguration()
  const dbconn = await new Database(config.dbConfig)
  INDEXER_LOGGER.logMessage(`Datatoken address: ${event.address}`)
  const datatokenContract = new Contract(
    event.address,
    ERC20Template.abi,
    await provider.getSigner()
  )
  const nftAddress = await datatokenContract.getERC721Address()
  INDEXER_LOGGER.logMessage(`NFT address in processing OrderStarted: ${nftAddress}`, true)
  const did =
    'did:op:' +
    createHash('sha256')
      .update(getAddress(nftAddress) + chainId.toString(10))
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
    INDEXER_LOGGER.logMessage(
      `Datatoken ${ddo.services[serviceIndex].datatoken}. Event address: ${event.address}`
    )
    if ('stats' in ddo && ddo.services[serviceIndex].datatoken === event.address) {
      ddo.stats.orders += 1
    } else {
      // Still update until we validate and polish schemas for DDO.
      // But it should update ONLY if first condition is met.
      INDEXER_LOGGER.logMessage(`First OrderStarted changed for ${did}.`)
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
  const datatokenContract = new Contract(event.address, ERC20Template.abi, provider)
  const nftAddress = await datatokenContract.getERC721Address()
  INDEXER_LOGGER.logMessage(`NFT address: ${nftAddress}`, true)
  const did =
    'did:op:' +
    createHash('sha256')
      .update(getAddress(nftAddress) + chainId.toString(10))
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
