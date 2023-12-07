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
import { getConfig } from '../../utils/config.js'
import { Database } from '../database/index.js'

export const INDEXER_LOGGER: CustomNodeLogger = getCustomLoggerForModule(
  LOGGER_MODULE_NAMES.INDEXER,
  LOG_LEVELS_STR.LEVEL_INFO,
  defaultConsoleTransport
)

const config = await getConfig()

export const processMetadataEvents = async (
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

  INDEXER_LOGGER.logMessage(
    `Processed new DDO data ${ddo.id} with txHash ${event.transactionHash} from block ${event.blockNumber}`,
    true
  )
  return ddo
}

export const processMetadataStateEvent = async (
  event: ethers.Log,
  chainId: number,
  provider: JsonRpcApiProvider
) => {
  INDEXER_LOGGER.logMessage(`Processing metadata state event...`, true)
  const iface = new Interface(ERC721Template.abi)
  const receipt = await provider.getTransactionReceipt(event.transactionHash)
  INDEXER_LOGGER.logMessage(`Tx receipt for MetadataState event: ${receipt} `, true)
  const eventObj = {
    topics: receipt.logs[0].topics as string[],
    data: receipt.logs[0].data
  }
  const decodedEventData = iface.parseLog(eventObj)
  const metadataState = parseInt(decodedEventData.args[1].toString())
  INDEXER_LOGGER.logMessage(`Processed new metadata state ${metadataState} `, true)
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
        `Detected MetadataState changed for ${did}, but it does not exists.`
      )
      return
    }
    INDEXER_LOGGER.logMessage(`Found did ${did} on network ${chainId}`)
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
