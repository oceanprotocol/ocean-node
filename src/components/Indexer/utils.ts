import { JsonRpcApiProvider, Signer, ethers, getAddress, Interface } from 'ethers'
import ERC721Factory from '@oceanprotocol/contracts/artifacts/contracts/ERC721Factory.sol/ERC721Factory.json' assert { type: 'json' }
import ERC721Template from '@oceanprotocol/contracts/artifacts/contracts/templates/ERC721Template.sol/ERC721Template.json' assert { type: 'json' }
import {
  ENVIRONMENT_VARIABLES,
  EVENTS,
  EVENT_HASHES,
  existsEnvironmentVariable,
  getAllowedValidators
} from '../../utils/index.js'
import { BlocksEvents, NetworkEvent, ProcessingEvents } from '../../@types/blockchain.js'
import {
  MetadataEventProcessor,
  MetadataStateEventProcessor,
  OrderReusedEventProcessor,
  OrderStartedEventProcessor
} from './processor.js'
import { INDEXER_LOGGER } from '../../utils/logging/common.js'
import { fetchEventFromTransaction } from '../../utils/util.js'
import ERC20Template from '@oceanprotocol/contracts/artifacts/contracts/templates/ERC20TemplateEnterprise.sol/ERC20TemplateEnterprise.json' assert { type: 'json' }
import { LOG_LEVELS_STR } from '../../utils/logging/Logger.js'
import { getOceanArtifactsAdressesByChainId } from '../../utils/address.js'
import { CommandStatus, JobStatus } from '../../@types/commands.js'
import { create256Hash } from '../../utils/crypt.js'

let metadataEventProccessor: MetadataEventProcessor
let metadataStateEventProcessor: MetadataStateEventProcessor
let orderReusedEventProcessor: OrderReusedEventProcessor
let orderStartedEventProcessor: OrderStartedEventProcessor

function getMetadataEventProcessor(chainId: number): MetadataEventProcessor {
  if (!metadataEventProccessor) {
    metadataEventProccessor = new MetadataEventProcessor(chainId)
  }
  return metadataEventProccessor
}

function getMetadataStateEventProcessor(chainId: number): MetadataStateEventProcessor {
  if (!metadataStateEventProcessor) {
    metadataStateEventProcessor = new MetadataStateEventProcessor(chainId)
  }
  return metadataStateEventProcessor
}

function getOrderReusedEventProcessor(chainId: number): OrderReusedEventProcessor {
  if (!orderReusedEventProcessor) {
    orderReusedEventProcessor = new OrderReusedEventProcessor(chainId)
  }
  return orderReusedEventProcessor
}

function getOrderStartedEventProcessor(chainId: number): OrderStartedEventProcessor {
  if (!orderStartedEventProcessor) {
    orderStartedEventProcessor = new OrderStartedEventProcessor(chainId)
  }
  return orderStartedEventProcessor
}

export const getContractAddress = (chainId: number, contractName: string): string => {
  const addressFile = getOceanArtifactsAdressesByChainId(chainId)
  if (addressFile && contractName in addressFile) {
    return getAddress(addressFile[contractName])
  }
  return ''
}

export const getDeployedContractBlock = (network: number) => {
  let deployedBlock: number
  const addressFile = getOceanArtifactsAdressesByChainId(network)
  if (addressFile) {
    deployedBlock = addressFile.startBlock
  }

  return deployedBlock
}

export const getNetworkHeight = async (provider: JsonRpcApiProvider) => {
  const networkHeight = await provider.getBlockNumber()

  return networkHeight
}

export const retrieveChunkEvents = async (
  signer: Signer,
  provider: JsonRpcApiProvider,
  network: number,
  lastIndexedBlock: number,
  count: number
): Promise<ethers.Log[]> => {
  try {
    const eventHashes = Object.keys(EVENT_HASHES)
    const startIndex = lastIndexedBlock + 1
    const blockLogs = await provider.getLogs({
      fromBlock: startIndex,
      toBlock: lastIndexedBlock + count,
      topics: [eventHashes]
    })
    return blockLogs
  } catch (error) {
    throw new Error(` Error processing chunk of blocks events ${error.message}`)
  }
}

export const processBlocks = async (
  blockLogs: ethers.Log[],
  signer: Signer,
  provider: JsonRpcApiProvider,
  network: number,
  lastIndexedBlock: number,
  count: number
): Promise<ProcessingEvents> => {
  try {
    const events: any[] | BlocksEvents =
      blockLogs && blockLogs.length > 0
        ? await processChunkLogs(blockLogs, signer, provider, network)
        : []

    return {
      lastBlock: lastIndexedBlock + count,
      foundEvents: events
    }
  } catch (error) {
    throw new Error(` Error processing chunk of blocks events ${error.message}`)
  }
}

export function findEventByKey(keyToFind: string): NetworkEvent {
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
    const allowedValidators = getAllowedValidators()
    const checkMetadataValidated = allowedValidators.length > 0
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
          event.type === EVENTS.METADATA_UPDATED ||
          event.type === EVENTS.METADATA_STATE
        ) {
          if (checkMetadataValidated) {
            const txReceipt = await provider.getTransactionReceipt(log.transactionHash)
            const metadataProofs = fetchEventFromTransaction(
              txReceipt,
              'MetadataValidated',
              new Interface(ERC20Template.abi)
            )
            if (!metadataProofs) {
              INDEXER_LOGGER.log(
                LOG_LEVELS_STR.LEVEL_ERROR,
                `Metadata Proof validator not allowed`,
                true
              )
              continue
            }
            const validators = metadataProofs.map((metadataProof) =>
              getAddress(metadataProof.args[0].toString())
            )
            const allowed = allowedValidators.filter(
              (allowedValidator) => validators.indexOf(allowedValidator) !== -1
            )
            if (!allowed.length) {
              INDEXER_LOGGER.log(
                LOG_LEVELS_STR.LEVEL_ERROR,
                `Metadata Proof validators list is empty`,
                true
              )
              continue
            }
          }
        }
        if (
          event.type === EVENTS.METADATA_CREATED ||
          event.type === EVENTS.METADATA_UPDATED
        ) {
          const processor = getMetadataEventProcessor(chainId)
          const rets = await processor.processEvent(
            log,
            chainId,
            signer,
            provider,
            event.type
          )
          if (rets) storeEvents[event.type] = rets
        } else if (event.type === EVENTS.METADATA_STATE) {
          const processor = getMetadataStateEventProcessor(chainId)
          storeEvents[event.type] = await processor.processEvent(log, chainId, provider)
        } else if (event.type === EVENTS.EXCHANGE_CREATED) {
          storeEvents[event.type] = procesExchangeCreated()
        } else if (event.type === EVENTS.EXCHANGE_RATE_CHANGED) {
          storeEvents[event.type] = processExchangeRateChanged()
        } else if (event.type === EVENTS.ORDER_STARTED) {
          const processor = getOrderStartedEventProcessor(chainId)
          storeEvents[event.type] = await processor.processEvent(
            log,
            chainId,
            signer,
            provider
          )
        } else if (event.type === EVENTS.ORDER_REUSED) {
          const processor = getOrderReusedEventProcessor(chainId)
          storeEvents[event.type] = await processor.processEvent(
            log,
            chainId,
            signer,
            provider
          )
        } else if (event.type === EVENTS.TOKEN_URI_UPDATE) {
          storeEvents[event.type] = processTokenUriUpadate()
        }
      }
    }
    return storeEvents
  }

  return {}
}

const procesExchangeCreated = (): string => {
  return 'EXCHANGE_CREATED'
}

const processExchangeRateChanged = (): string => {
  return 'EXCHANGE_RATE_CHANGED'
}

const processTokenUriUpadate = (): string => {
  return 'TOKEN_URI_UPDATE'
}

export const getNFTContract = (signer: Signer, address: string): ethers.Contract => {
  address = getAddress(address)
  return getContract(signer, 'ERC721Template', address)
}

export const getDtContract = (signer: Signer, address: string): ethers.Contract => {
  address = getAddress(address)
  return getContract(signer, 'ERC20Template', address)
}

export const getNFTFactory = (signer: Signer, address: string): ethers.Contract => {
  address = getAddress(address)
  return getContract(signer, 'ERC721Factory', address)
}
function getContract(
  signer: Signer,
  contractName: string,
  address: string
): ethers.Contract {
  const abi = getContractDefinition(contractName)
  return new ethers.Contract(getAddress(address), abi, signer)
}

function getContractDefinition(contractName: string): any {
  switch (contractName) {
    case 'ERC721Factory':
      return ERC721Factory.abi
    case 'ERC721Template':
      return ERC721Template.abi
    case 'ERC20Template':
      return ERC20Template.abi
    default:
      return ERC721Factory.abi
  }
}

/**
 * Checks if a given NFT address was deployed by our NFT Factory on the specific chain
 * @param chainId chain id as number
 * @param signer the signer account
 * @param dataNftAddress the deployed nft address
 * @returns true or false
 */
export async function wasNFTDeployedByOurFactory(
  chainId: number,
  signer: Signer,
  dataNftAddress: string
): Promise<boolean> {
  const nftFactoryAddress = getContractAddress(chainId, 'ERC721Factory')
  const nftFactoryContract = await getNFTFactory(signer, nftFactoryAddress)

  const nftAddressFromFactory = await nftFactoryContract.erc721List(dataNftAddress)

  return (
    getAddress(dataNftAddress)?.toLowerCase() ===
    getAddress(nftAddressFromFactory)?.toLowerCase()
  )
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

// when we send an admin command, we also get a job id back in the reponse
// we can use it later to get the status of the job execution (if not immediate)
export function buildJobIdentifier(command: string, extra: string[]): JobStatus {
  const now = new Date().getTime().toString()
  return {
    command, // which command
    timestamp: now, // when was delivered
    jobId: command + '_' + now, // job id
    status: CommandStatus.DELIVERED,
    hash: create256Hash(extra.join(''))
  }
}
