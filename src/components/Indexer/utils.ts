import { ethers, getAddress } from 'ethers'
import localAdressFile from '@oceanprotocol/contracts/addresses/address.json' assert { type: 'json' }
import ERC721Factory from '@oceanprotocol/contracts/artifacts/contracts/ERC721Factory.sol/ERC721Factory.json' assert { type: 'json' }
import ERC721Template from '@oceanprotocol/contracts/artifacts/contracts/templates/ERC721Template.sol/ERC721Template.json' assert { type: 'json' }
import fs from 'fs'
import { EVENTS, EVENT_HASHES } from '../../utils/index.js'
import { BlocksEvents, NetworkEvent, ProcessingEvents } from '../../@types/blockchain.js'
import {
  CustomNodeLogger,
  LOGGER_MODULE_NAMES,
  LOG_LEVELS_STR,
  defaultConsoleTransport,
  getCustomLoggerForModule
} from '../../utils/logging/Logger.js'
import { processMetadataCreatedEvent } from './eventProcessor.js'
import { inspect } from 'node:util'

type Topic = `0x${string & { length: 64 }}`

export const INDEXER_LOGGER: CustomNodeLogger = getCustomLoggerForModule(
  LOGGER_MODULE_NAMES.INDEXER,
  LOG_LEVELS_STR.LEVEL_INFO,
  defaultConsoleTransport
)

export const getDeployedContractBlock = async (network: number) => {
  let deployedBlock: number
  const addressFile = process.env.ADDRESS_FILE
    ? JSON.parse(
        // eslint-disable-next-line security/detect-non-literal-fs-filename
        fs.readFileSync('process.env.ADDRESS_FILE', 'utf8')
      )
    : localAdressFile
  const networkKeys = Object.keys(addressFile)
  networkKeys.forEach((key) => {
    if (addressFile[key].chainId === network) {
      deployedBlock = addressFile[key].startBlock
    }
  })
  return deployedBlock || 57
}

export const getNetworkHeight = async (provider: ethers.Provider) => {
  const networkHeight = await provider.getBlockNumber()

  return networkHeight
}

export const processBlocks = async (
  provider: ethers.Provider,
  network: number,
  startIndex: number,
  count: number
): Promise<ProcessingEvents> => {
  try {
    const eventHashes = Object.keys(EVENT_HASHES)
    const topics: Topic[] = eventHashes as Topic[]
    INDEXER_LOGGER.logMessage(`from block --> ${inspect(startIndex)} `, true)
    INDEXER_LOGGER.logMessage(`to Block --> ${inspect(startIndex + count)} `, true)
    INDEXER_LOGGER.logMessage(`topics --> ${inspect(topics)} `, true)
    const blockLogs = await provider.getLogs({
      fromBlock: startIndex,
      toBlock: startIndex + count
      // topics
    })
    INDEXER_LOGGER.logMessage(`blockLogs --> ${inspect(blockLogs)} `, true)
    const events = await processChunkLogs(blockLogs, provider, network)
    INDEXER_LOGGER.logMessage(`events --> ${inspect(events)} `, true)

    return {
      lastBlock: startIndex + count,
      foundEvents: events
    }
  } catch (error) {
    console.error('error == ', error)
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
  provider: ethers.Provider,
  chainId: number
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
        storeEvents[event.type] = await processMetadataEvents(
          log,
          event.type,
          provider,
          chainId
        )
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

const processMetadataEvents = async (
  log: ethers.Log,
  eventType: string,
  provider: ethers.Provider,
  chainId: number
): Promise<any> => {
  if (eventType === EVENTS.METADATA_CREATED) {
    try {
      return await processMetadataCreatedEvent(log, chainId, provider)
    } catch (e) {
      INDEXER_LOGGER.log(LOG_LEVELS_STR.LEVEl_ERROR, `Error proccessing metadata: ${e}`)
    }
  }
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

export const getNFTContract = (
  provider: ethers.Provider,
  address: string
): ethers.Contract => {
  address = getAddress(address)
  return getContract(provider, 'ERC721Template', address)
}

export const getNFTFactory = (
  provider: ethers.Provider,
  address: string
): ethers.Contract => {
  address = getAddress(address)
  return getContract(provider, 'ERC721Factory', address)
}

function getContract(
  provider: ethers.Provider,
  contractName: string,
  address: string
): ethers.Contract {
  const abi = getContractDefinition(contractName)
  return new ethers.Contract(getAddress(address), abi, provider)
}

function getContractDefinition(contractName: string): any {
  switch (contractName) {
    case 'ERC721Factory':
      return ERC721Factory.abi
    case 'ERC721Template':
      return ERC721Template.abi
    default:
      return ERC721Factory.abi
  }
}
