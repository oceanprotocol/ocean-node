import { JsonRpcApiProvider, ethers, getAddress } from 'ethers'
import localAdressFile from '@oceanprotocol/contracts/addresses/address.json' assert { type: 'json' }
import ERC721Factory from '@oceanprotocol/contracts/artifacts/contracts/ERC721Factory.sol/ERC721Factory.json' assert { type: 'json' }
import ERC721Template from '@oceanprotocol/contracts/artifacts/contracts/templates/ERC721Template.sol/ERC721Template.json' assert { type: 'json' }
import fs from 'fs'
import { homedir } from 'os'
import { EVENTS, EVENT_HASHES } from '../../utils/index.js'
import { BlocksEvents, NetworkEvent, ProcessingEvents } from '../../@types/blockchain.js'
import {
  CustomNodeLogger,
  LOGGER_MODULE_NAMES,
  LOG_LEVELS_STR,
  defaultConsoleTransport,
  getCustomLoggerForModule
} from '../../utils/logging/Logger.js'
import { processMetadataEvents, processMetadataStateEvent } from './eventProcessor.js'

export const INDEXER_LOGGER: CustomNodeLogger = getCustomLoggerForModule(
  LOGGER_MODULE_NAMES.INDEXER,
  LOG_LEVELS_STR.LEVEL_INFO,
  defaultConsoleTransport
)

export const getDeployedContractBlock = async (network: number) => {
  let deployedBlock: number
  const addressFile =
    process.env.ADDRESS_FILE || network === 8996
      ? JSON.parse(
          // eslint-disable-next-line security/detect-non-literal-fs-filename
          fs.readFileSync(
            process.env.ADDRESS_FILE ||
              `${homedir}/.ocean/ocean-contracts/artifacts/address.json`,
            'utf8'
          )
        )
      : localAdressFile
  const networkKeys = Object.keys(addressFile)
  networkKeys.forEach((key) => {
    if (addressFile[key].chainId === network) {
      deployedBlock = addressFile[key].startBlock
    }
  })
  return deployedBlock
}

export const getNetworkHeight = async (provider: JsonRpcApiProvider) => {
  const networkHeight = await provider.getBlockNumber()

  return networkHeight
}

export const processBlocks = async (
  provider: JsonRpcApiProvider,
  network: number,
  lastIndexedBlock: number,
  count: number
): Promise<ProcessingEvents> => {
  try {
    const eventHashes = Object.keys(EVENT_HASHES)
    const startIndex = lastIndexedBlock + 1
    const blockLogs = await provider.getLogs({
      fromBlock: startIndex,
      toBlock: lastIndexedBlock + count,
      topics: [eventHashes]
    })
    const events = await processChunkLogs(blockLogs, provider, network)

    return {
      lastBlock: lastIndexedBlock + count,
      foundEvents: events
    }
  } catch (error) {
    throw new Error('error processing chunk of blocks events')
  }
}

function findEventByKey(keyToFind: string): NetworkEvent {
  for (const [key, value] of Object.entries(EVENT_HASHES)) {
    if (key === keyToFind) {
      return value
    }
  }
  return null
}

export const processChunkLogs = async (
  logs: readonly ethers.Log[],
  provider: JsonRpcApiProvider,
  chainId: number
): Promise<BlocksEvents> => {
  const storeEvents: BlocksEvents = {}
  if (logs.length > 0) {
    for (const log of logs) {
      const event = findEventByKey(log.topics[0])
      if (
        event &&
        (event.type === EVENTS.METADATA_CREATED || event.type === EVENTS.METADATA_UPDATED)
      ) {
        INDEXER_LOGGER.logMessage(`-- ${event.type} triggered`, true)
        storeEvents[event.type] = await processMetadataEvents(log, chainId, provider)
      } else if (event && event.type === EVENTS.METADATA_STATE) {
        INDEXER_LOGGER.logMessage(`-- ${event.type} triggered`, true)
        storeEvents[event.type] = await processMetadataStateEvent(log, chainId, provider)
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

export const getNFTContract = async (
  provider: JsonRpcApiProvider,
  address: string
): Promise<ethers.Contract> => {
  address = getAddress(address)
  return getContract(provider, 'ERC721Template', address)
}

export const getNFTFactory = async (
  provider: JsonRpcApiProvider,
  address: string
): Promise<ethers.Contract> => {
  address = getAddress(address)
  return await getContract(provider, 'ERC721Factory', address)
}

async function getContract(
  provider: JsonRpcApiProvider,
  contractName: string,
  address: string
): Promise<ethers.Contract> {
  const abi = getContractDefinition(contractName)
  return new ethers.Contract(getAddress(address), abi, await provider.getSigner())
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
