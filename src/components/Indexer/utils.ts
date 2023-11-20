import { ethers } from 'ethers'
import fs from 'fs'
import { EVENTS, EVENT_HASHES } from '../../utils/constants.js'
import { BlocksEvents, NetworkEvent, ProcessingEvents } from '../../@types/blockchain.js'
import {
  CustomNodeLogger,
  LOGGER_MODULE_NAMES,
  LOG_LEVELS_STR,
  defaultConsoleTransport,
  getCustomLoggerForModule
} from '../../utils/logging/Logger.js'

export const INDEXER_LOGGER: CustomNodeLogger = getCustomLoggerForModule(
  LOGGER_MODULE_NAMES.INDEXER,
  LOG_LEVELS_STR.LEVEL_INFO,
  defaultConsoleTransport
)

export const getDeployedContractBlock = async (network: number) => {
  let deployedBlock: number
  const addressFile = JSON.parse(
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    fs.readFileSync(process.env.ADDRESS_FILE || '../../../data/address.json', 'utf8')
  )
  const networkKeys = Object.keys(addressFile)
  networkKeys.forEach((key) => {
    if (addressFile[key].chainId === network) {
      deployedBlock = addressFile[key].startBlock
    }
  })
  return deployedBlock
}

export const getNetworkHeight = async (provider: ethers.Provider) => {
  const networkHeight = await provider.getBlockNumber()

  return networkHeight
}

export const processBlocks = async (
  provider: ethers.Provider,
  startIndex: number,
  count: number
): Promise<ProcessingEvents> => {
  try {
    const blockLogs = await provider.getLogs({
      fromBlock: startIndex,
      toBlock: startIndex + count
    })

    const events = await processChunkLogs(blockLogs, provider)

    return {
      lastBlock: startIndex + count,
      foundEvents: events
    }
  } catch (error) {
    throw new Error('error processing chunk of blocks events')
  }
}

function findEventByKey(keyToFind: string): NetworkEvent {
  for (const [key, value] of Object.entries(EVENT_HASHES)) {
    if (key === keyToFind) {
      INDEXER_LOGGER.logMessage(`Found event with key '${key}':  ${value}`, true)
      return value
    }
  }
  return null
}

export const processChunkLogs = async (
  logs: readonly ethers.Log[],
  provider?: ethers.Provider
): Promise<BlocksEvents> => {
  const storeEvents: BlocksEvents = {}
  if (logs.length > 0) {
    for (const log of logs) {
      const event = findEventByKey(log.topics[0])
      if (
        event &&
        (event.type === EVENTS.METADATA_CREATED ||
          event.type === EVENTS.METADATA_UPDATED ||
          event.type === EVENTS.METADATA_STATE)
      ) {
        INDEXER_LOGGER.logMessage(
          'METADATA_CREATED || METADATA_UPDATED || METADATA_STATE   -- ',
          true
        )
        storeEvents[event.type] = await processMetadataEvents()
      } else if (event && event.type === EVENTS.EXCHANGE_CREATED) {
        INDEXER_LOGGER.logMessage('-- EXCHANGE_CREATED -- ', true)
        storeEvents[event.type] = await procesExchangeCreated()
      } else if (event && event.type === EVENTS.EXCHANGE_RATE_CHANGED) {
        INDEXER_LOGGER.logMessage('-- EXCHANGE_RATE_CHANGED -- ', true)
        storeEvents[event.type] = await processExchangeRateChanged()
      } else if (event && event.type === EVENTS.ORDER_STARTED) {
        INDEXER_LOGGER.logMessage('-- ORDER_STARTED -- ', true)
        storeEvents[event.type] = await procesOrderStarted()
      } else if (event && event.type === EVENTS.TOKEN_URI_UPDATE) {
        INDEXER_LOGGER.logMessage('-- TOKEN_URI_UPDATE -- ', true)
        storeEvents[event.type] = await processTokenUriUpadate()
      }
    }
    return storeEvents
  }

  return {}
}

const processMetadataEvents = async (): Promise<string> => {
  return 'METADATA_CREATED'
}

const procesExchangeCreated = async (): Promise<string> => {
  return 'EXCHANGE_CREATED'
}

const processExchangeRateChanged = async (): Promise<string> => {
  return 'EXCHANGE_RATE_CHANGED'
}

const procesOrderStarted = async (): Promise<string> => {
  return 'ORDER_STARTED'
}

const processTokenUriUpadate = async (): Promise<string> => {
  return 'TOKEN_URI_UPDATE'
}
