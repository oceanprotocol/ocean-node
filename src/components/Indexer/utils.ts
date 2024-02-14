import { JsonRpcApiProvider, Signer, ethers, getAddress } from 'ethers'
import localAdressFile from '@oceanprotocol/contracts/addresses/address.json' assert { type: 'json' }
import ERC721Factory from '@oceanprotocol/contracts/artifacts/contracts/ERC721Factory.sol/ERC721Factory.json' assert { type: 'json' }
import ERC721Template from '@oceanprotocol/contracts/artifacts/contracts/templates/ERC721Template.sol/ERC721Template.json' assert { type: 'json' }
import fs from 'fs'
import { homedir } from 'os'
import {
  ENVIRONMENT_VARIABLES,
  EVENTS,
  EVENT_HASHES,
  existsEnvironmentVariable
} from '../../utils/index.js'
import { BlocksEvents, NetworkEvent, ProcessingEvents } from '../../@types/blockchain.js'
import {
  MetadataEventProcessor,
  MetadataStateEventProcessor,
  OrderReusedEventProcessor,
  OrderStartedEventProcessor
} from './processor.js'
import { INDEXER_LOGGER } from '../../utils/logging/common.js'
let metadataEventProccessor: MetadataEventProcessor
let metadataStateEventProcessor: MetadataStateEventProcessor
let orderReusedEventProcessor: OrderReusedEventProcessor
let orderStartedEventProcessor: OrderStartedEventProcessor

async function getMetadataEventProcessor(
  chainId: number
): Promise<MetadataEventProcessor> {
  if (!metadataEventProccessor) {
    metadataEventProccessor = new MetadataEventProcessor(chainId)
  }
  return metadataEventProccessor
}

async function getMetadataStateEventProcessor(
  chainId: number
): Promise<MetadataStateEventProcessor> {
  if (!metadataStateEventProcessor) {
    metadataStateEventProcessor = new MetadataStateEventProcessor(chainId)
  }
  return metadataStateEventProcessor
}

async function getOrderReusedEventProcessor(
  chainId: number
): Promise<OrderReusedEventProcessor> {
  if (!orderReusedEventProcessor) {
    orderReusedEventProcessor = new OrderReusedEventProcessor(chainId)
  }
  return orderReusedEventProcessor
}

async function getOrderStartedEventProcessor(
  chainId: number
): Promise<OrderStartedEventProcessor> {
  if (!orderStartedEventProcessor) {
    orderStartedEventProcessor = new OrderStartedEventProcessor(chainId)
  }
  return orderStartedEventProcessor
}

export const getAddressFile = (chainId: number) => {
  return process.env.ADDRESS_FILE || chainId === 8996
    ? JSON.parse(
        // eslint-disable-next-line security/detect-non-literal-fs-filename
        fs.readFileSync(
          process.env.ADDRESS_FILE ||
            `${homedir}/.ocean/ocean-contracts/artifacts/address.json`,
          'utf8'
        )
      )
    : localAdressFile
}

export const getContractAddress = (chainId: number, contractName: string): string => {
  const addressFile = getAddressFile(chainId)
  const networkKeys = Object.keys(addressFile)
  for (const key of networkKeys) {
    if (addressFile[key].chainId === chainId && contractName in addressFile[key]) {
      return getAddress(addressFile[key][contractName])
    }
  }
}

export const getDeployedContractBlock = async (network: number) => {
  let deployedBlock: number
  const addressFile = getAddressFile(network)
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
  signer: Signer,
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
    const events = await processChunkLogs(blockLogs, signer, provider, network)

    return {
      lastBlock: lastIndexedBlock + count,
      foundEvents: events
    }
  } catch (error) {
    throw new Error(` Error processing chunk of blocks events ${error.message}`)
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
  signer: Signer,
  provider: JsonRpcApiProvider,
  chainId: number
): Promise<BlocksEvents> => {
  const storeEvents: BlocksEvents = {}
  if (logs.length > 0) {
    for (const log of logs) {
      const event = findEventByKey(log.topics[0])

      if (event && Object.values(EVENTS).includes(event.type)) {
        // only log & process the ones we support
        INDEXER_LOGGER.logMessage(
          `-- ${event.type} -- triggered for ${log.transactionHash}`,
          true
        )
        if (
          event.type === EVENTS.METADATA_CREATED ||
          event.type === EVENTS.METADATA_UPDATED
        ) {
          const processor = await getMetadataEventProcessor(chainId)
          const rets = await processor.processEvent(
            log,
            chainId,
            signer,
            provider,
            event.type
          )
          if (rets) storeEvents[event.type] = rets
        } else if (event.type === EVENTS.METADATA_STATE) {
          const processor = await getMetadataStateEventProcessor(chainId)
          storeEvents[event.type] = await processor.processEvent(log, chainId, provider)
        } else if (event.type === EVENTS.EXCHANGE_CREATED) {
          storeEvents[event.type] = await procesExchangeCreated()
        } else if (event.type === EVENTS.EXCHANGE_RATE_CHANGED) {
          storeEvents[event.type] = await processExchangeRateChanged()
        } else if (event.type === EVENTS.ORDER_STARTED) {
          const processor = await getOrderStartedEventProcessor(chainId)
          storeEvents[event.type] = await processor.processEvent(log, chainId, provider)
        } else if (event.type === EVENTS.ORDER_REUSED) {
          const processor = await getOrderReusedEventProcessor(chainId)
          storeEvents[event.type] = await processor.processEvent(log, chainId, provider)
        } else if (event.type === EVENTS.TOKEN_URI_UPDATE) {
          storeEvents[event.type] = await processTokenUriUpadate()
        }
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

const processTokenUriUpadate = async (): Promise<string> => {
  return 'TOKEN_URI_UPDATE'
}

export const getNFTContract = async (
  signer: Signer,
  address: string
): Promise<ethers.Contract> => {
  address = getAddress(address)
  return getContract(signer, 'ERC721Template', address)
}

export const getNFTFactory = async (
  signer: Signer,
  address: string
): Promise<ethers.Contract> => {
  address = getAddress(address)
  return await getContract(signer, 'ERC721Factory', address)
}

async function getContract(
  signer: Signer,
  contractName: string,
  address: string
): Promise<ethers.Contract> {
  const abi = getContractDefinition(contractName)
  return new ethers.Contract(getAddress(address), abi, signer) // was provider.getSigner() => thow no account
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

// default in seconds
const DEFAULT_INDEXER_CRAWLING_INTERVAL = 1000 * 30 // 30 seconds
export const getCrawlingInterval = (): number => {
  if (existsEnvironmentVariable(ENVIRONMENT_VARIABLES.INDEXER_INTERVAL)) {
    const number: any = process.env.INDEXER_INTERVAL
    if (!isNaN(number) && number > 0) {
      return number
    }
  }
  return DEFAULT_INDEXER_CRAWLING_INTERVAL
}
