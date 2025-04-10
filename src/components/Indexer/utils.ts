import { JsonRpcApiProvider, Signer, ethers, getAddress, Interface } from 'ethers'
import ERC721Factory from '@oceanprotocol/contracts/artifacts/contracts/ERC721Factory.sol/ERC721Factory.json' assert { type: 'json' }
import ERC721Template from '@oceanprotocol/contracts/artifacts/contracts/templates/ERC721Template.sol/ERC721Template.json' assert { type: 'json' }
import AccessListContract from '@oceanprotocol/contracts/artifacts/contracts/accesslists/AccessList.sol/AccessList.json' assert { type: 'json' }
import {
  ENVIRONMENT_VARIABLES,
  EVENTS,
  EVENT_HASHES,
  existsEnvironmentVariable,
  getConfiguration
} from '../../utils/index.js'
import { BlocksEvents, NetworkEvent, ProcessingEvents } from '../../@types/blockchain.js'
import {
  DispenserActivatedEventProcessor,
  DispenserDeactivatedEventProcessor,
  MetadataEventProcessor,
  MetadataStateEventProcessor,
  OrderReusedEventProcessor,
  OrderStartedEventProcessor,
  ExchangeActivatedEventProcessor,
  ExchangeDeactivatedEventProcessor,
  ExchangeRateChangedEventProcessor,
  ExchangeCreatedEventProcessor,
  DispenserCreatedEventProcessor
} from './processor.js'
import { INDEXER_LOGGER } from '../../utils/logging/common.js'
import { fetchEventFromTransaction } from '../../utils/util.js'
import ERC20Template from '@oceanprotocol/contracts/artifacts/contracts/templates/ERC20TemplateEnterprise.sol/ERC20TemplateEnterprise.json' assert { type: 'json' }
import { LOG_LEVELS_STR } from '../../utils/logging/Logger.js'
import { getOceanArtifactsAdressesByChainId } from '../../utils/address.js'
import { CommandStatus, JobStatus } from '../../@types/commands.js'
import { create256Hash } from '../../utils/crypt.js'
import Dispenser from '@oceanprotocol/contracts/artifacts/contracts/pools/dispenser/Dispenser.sol/Dispenser.json' assert { type: 'json' }
import FixedRateExchange from '@oceanprotocol/contracts/artifacts/contracts/pools/fixedRate/FixedRateExchange.sol/FixedRateExchange.json' assert { type: 'json' }
import { createHash } from 'crypto'
import { ServicePrice } from '../../@types/IndexedMetadata.js'
import { VersionedDDO } from '@oceanprotocol/ddo-js'

let metadataEventProccessor: MetadataEventProcessor
let metadataStateEventProcessor: MetadataStateEventProcessor
let orderReusedEventProcessor: OrderReusedEventProcessor
let orderStartedEventProcessor: OrderStartedEventProcessor
let dispenserActivatedEventProcessor: DispenserActivatedEventProcessor
let dispenserDeactivatedEventProcessor: DispenserDeactivatedEventProcessor
let exchangeCreatedEventProcessor: ExchangeCreatedEventProcessor
let exchangeActivatedEventProcessor: ExchangeActivatedEventProcessor
let exchangeDeactivatedEventProcessor: ExchangeDeactivatedEventProcessor
let exchangeNewRateEventProcessor: ExchangeRateChangedEventProcessor
let dispenserCreatedEventProcessor: DispenserCreatedEventProcessor

function getExchangeCreatedEventProcessor(
  chainId: number
): ExchangeCreatedEventProcessor {
  if (!exchangeCreatedEventProcessor) {
    exchangeCreatedEventProcessor = new ExchangeCreatedEventProcessor(chainId)
  }
  return exchangeCreatedEventProcessor
}

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

function getDispenserCreatedEventProcessor(
  chainId: number
): DispenserCreatedEventProcessor {
  if (!dispenserCreatedEventProcessor) {
    dispenserCreatedEventProcessor = new DispenserCreatedEventProcessor(chainId)
  }
  return dispenserCreatedEventProcessor
}

function getDispenserActivatedEventProcessor(
  chainId: number
): DispenserActivatedEventProcessor {
  if (!dispenserActivatedEventProcessor) {
    dispenserActivatedEventProcessor = new DispenserActivatedEventProcessor(chainId)
  }
  return dispenserActivatedEventProcessor
}

function getDispenserDeactivatedEventProcessor(
  chainId: number
): DispenserDeactivatedEventProcessor {
  if (!dispenserDeactivatedEventProcessor) {
    dispenserDeactivatedEventProcessor = new DispenserDeactivatedEventProcessor(chainId)
  }
  return dispenserDeactivatedEventProcessor
}

function getExchangeActivatedEventProcessor(
  chainId: number
): ExchangeActivatedEventProcessor {
  if (!exchangeActivatedEventProcessor) {
    exchangeActivatedEventProcessor = new ExchangeActivatedEventProcessor(chainId)
  }
  return exchangeActivatedEventProcessor
}

function getExchangeDeactivatedEventProcessor(
  chainId: number
): ExchangeDeactivatedEventProcessor {
  if (!exchangeDeactivatedEventProcessor) {
    exchangeDeactivatedEventProcessor = new ExchangeDeactivatedEventProcessor(chainId)
  }
  return exchangeDeactivatedEventProcessor
}

function getExchangeNewRateEventProcessor(chainId: number) {
  if (!exchangeNewRateEventProcessor) {
    exchangeNewRateEventProcessor = new ExchangeRateChangedEventProcessor(chainId)
  }
  return exchangeNewRateEventProcessor
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
    const { allowedValidators, allowedValidatorsList } = await getConfiguration() //  getAllowedValidators()
    const checkMetadataValidated =
      allowedValidators.length > 0 ||
      (allowedValidatorsList && Object.keys(allowedValidatorsList).length > 0)
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
          // ref: https://github.com/oceanprotocol/ocean-node/issues/257
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
              // do not process this one
            }
            const validators: string[] = metadataProofs.map((metadataProof) =>
              getAddress(metadataProof.args[0].toString())
            )
            // ALLOWED_VALIDATORS CHECK
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
              // do not process this one
            }
            // ALLOWED_VALIDATORS_LIST
            // by default it is OK
            let isAllowed = true
            if (allowedValidatorsList && validators.length > 0) {
              // need to check then
              isAllowed = false
              // check accessList
              const chainsListed = Object.keys(allowedValidatorsList)
              const chain = String(chainId)
              // check the access lists for this chain
              if (chainsListed.length > 0 && chainsListed.includes(chain)) {
                for (const accessListAddress of allowedValidatorsList[chain]) {
                  // instantiate contract and check balanceOf
                  const accessListContract = new ethers.Contract(
                    accessListAddress,
                    AccessListContract.abi,
                    signer
                  )
                  for (const metaproofValidator of validators) {
                    // if has at least 1 token than it is authorized
                    // its enough one validator on the list
                    const balance = await accessListContract.balanceOf(metaproofValidator)
                    if (Number(balance) <= 0) {
                      INDEXER_LOGGER.error(
                        `Metadata validator: ${metaproofValidator} is NOT part of the access list group: ${accessListAddress}.`
                      )
                    } else {
                      isAllowed = true
                      break
                    }
                  }
                }
              } else {
                isAllowed = true // no rules for this specific chain, so ignore this
              }
              // move on to the next (do not process this event)
              if (isAllowed === false) continue
            } // end if (allowedValidatorsList) {
          } // end if if (checkMetadataValidated) {
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
          const processor = getExchangeCreatedEventProcessor(chainId)
          INDEXER_LOGGER.logMessage(`log for exchange created: ${JSON.stringify(log)}`)
          storeEvents[event.type] = await processor.processEvent(
            log,
            chainId,
            signer,
            provider
          )
        } else if (event.type === EVENTS.EXCHANGE_RATE_CHANGED) {
          const processor = getExchangeNewRateEventProcessor(chainId)
          storeEvents[event.type] = await processor.processEvent(
            log,
            chainId,
            signer,
            provider
          )
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
        } else if (event.type === EVENTS.DISPENSER_ACTIVATED) {
          const processor = getDispenserActivatedEventProcessor(chainId)
          storeEvents[event.type] = await processor.processEvent(
            log,
            chainId,
            signer,
            provider
          )
        } else if (event.type === EVENTS.DISPENSER_CREATED) {
          const processor = getDispenserCreatedEventProcessor(chainId)
          storeEvents[event.type] = await processor.processEvent(
            log,
            chainId,
            signer,
            provider
          )
        } else if (event.type === EVENTS.DISPENSER_DEACTIVATED) {
          const processor = getDispenserDeactivatedEventProcessor(chainId)
          storeEvents[event.type] = await processor.processEvent(
            log,
            chainId,
            signer,
            provider
          )
        } else if (event.type === EVENTS.EXCHANGE_ACTIVATED) {
          const processor = getExchangeActivatedEventProcessor(chainId)
          storeEvents[event.type] = await processor.processEvent(
            log,
            chainId,
            signer,
            provider
          )
        } else if (event.type === EVENTS.EXCHANGE_DEACTIVATED) {
          const processor = getExchangeDeactivatedEventProcessor(chainId)
          storeEvents[event.type] = await processor.processEvent(
            log,
            chainId,
            signer,
            provider
          )
        }
      }
    } // end for loop
    return storeEvents
  }

  return {}
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

export function findServiceIdByDatatoken(
  ddo: VersionedDDO,
  datatokenAddress: string
): string {
  for (const s of ddo.getDDOFields().services) {
    if (s.datatokenAddress.toLowerCase() === datatokenAddress.toLowerCase()) {
      return s.id
    }
  }
  return null
}

export function doesDispenserAlreadyExist(
  dispenserAddress: string,
  prices: ServicePrice[]
): [boolean, ServicePrice?] {
  for (const price of prices) {
    if (dispenserAddress.toLowerCase() === price.contract.toLowerCase()) {
      return [true, price]
    }
  }
  return [false, null]
}

export function doesFreAlreadyExist(
  exchangeId: ethers.BytesLike,
  prices: ServicePrice[]
): [boolean, ServicePrice?] {
  for (const price of prices) {
    if (exchangeId === price.exchangeId) {
      return [true, price]
    }
  }
  return [false, null]
}

export async function getPricesByDt(
  datatoken: ethers.Contract,
  signer: Signer
): Promise<ServicePrice[]> {
  let dispensers = []
  let fixedRates = []
  let prices: ServicePrice[] = []
  try {
    dispensers = await datatoken.getDispensers()
  } catch (e) {
    INDEXER_LOGGER.error(`[GET PRICES] failure when retrieving dispensers: ${e}`)
  }
  try {
    fixedRates = await datatoken.getFixedRates()
  } catch (e) {
    INDEXER_LOGGER.error(
      `[GET PRICES] failure when retrieving fixed rate exchanges: ${e}`
    )
  }
  if (dispensers.length === 0 && fixedRates.length === 0) {
    prices = []
  } else {
    if (dispensers) {
      for (const dispenser of dispensers) {
        const dispenserContract = new ethers.Contract(dispenser, Dispenser.abi, signer)
        try {
          const [isActive, ,] = await dispenserContract.status(
            await datatoken.getAddress()
          )
          if (isActive === true) {
            prices.push({
              type: 'dispenser',
              price: '0',
              contract: dispenser,
              token: await datatoken.getAddress()
            })
          }
        } catch (e) {
          INDEXER_LOGGER.error(
            `[GET PRICES] failure when retrieving dispenser status from contracts: ${e}`
          )
        }
      }
    }

    if (fixedRates) {
      for (const fixedRate of fixedRates) {
        const fixedRateContract = new ethers.Contract(
          fixedRate[0],
          FixedRateExchange.abi,
          signer
        )
        try {
          const [, , , baseTokenAddress, , pricing, isActive, , , , , ,] =
            await fixedRateContract.getExchange(fixedRate[1])
          if (isActive === true) {
            prices.push({
              type: 'fixedrate',
              price: ethers.formatEther(pricing),
              token: baseTokenAddress,
              contract: fixedRate[0],
              exchangeId: fixedRate[1]
            })
          }
        } catch (e) {
          INDEXER_LOGGER.error(
            `[GET PRICES] failure when retrieving exchange status from contracts: ${e}`
          )
        }
      }
    }
  }
  return prices
}

export async function getPricingStatsForDddo(
  ddo: VersionedDDO,
  signer: Signer
): Promise<VersionedDDO> {
  if (!ddo.getAssetFields().indexedMetadata) {
    ddo.getDDOData().indexedMetadata = {}
  }

  if (!Array.isArray(ddo.getAssetFields().indexedMetadata.stats)) {
    ddo.getDDOData().indexedMetadata.stats = []
  }

  const stats = ddo.getAssetFields().indexedMetadata?.stats || []

  for (const service of ddo.getDDOFields().services) {
    const datatoken = new ethers.Contract(
      service.datatokenAddress,
      ERC20Template.abi,
      signer
    )
    let dispensers = []
    let fixedRates = []
    const prices: ServicePrice[] = []
    try {
      dispensers = await datatoken.getDispensers()
    } catch (e) {
      INDEXER_LOGGER.error(`Contract call fails when retrieving dispensers: ${e}`)
    }
    try {
      fixedRates = await datatoken.getFixedRates()
    } catch (e) {
      INDEXER_LOGGER.error(
        `Contract call fails when retrieving fixed rate exchanges: ${e}`
      )
    }
    if (dispensers.length === 0 && fixedRates.length === 0) {
      stats.push({
        datatokenAddress: service.datatokenAddress,
        name: await datatoken.name(),
        symbol: await datatoken.symbol(),
        serviceId: service.id,
        orders: 0,
        prices: []
      })
    } else {
      if (dispensers) {
        for (const dispenser of dispensers) {
          const dispenserContract = new ethers.Contract(dispenser, Dispenser.abi, signer)
          try {
            const [isActive, ,] = await dispenserContract.status(
              await datatoken.getAddress()
            )
            if (isActive === true) {
              prices.push({
                type: 'dispenser',
                price: '0',
                contract: dispenser,
                token: service.datatokenAddress
              })
              stats.push({
                datatokenAddress: service.datatokenAddress,
                name: await datatoken.name(),
                symbol: await datatoken.symbol(),
                serviceId: service.id,
                orders: 0,
                prices
              })
            }
          } catch (e) {
            INDEXER_LOGGER.error(
              `[GET PRICES] failure when retrieving dispenser status from contracts: ${e}`
            )
          }
        }
      }
    }

    if (fixedRates) {
      for (const fixedRate of fixedRates) {
        const fixedRateContract = new ethers.Contract(
          fixedRate[0],
          FixedRateExchange.abi,
          signer
        )
        try {
          const [, , , baseTokenAddress, , pricing, isActive, , , , , ,] =
            await fixedRateContract.getExchange(fixedRate[1])
          if (isActive === true) {
            prices.push({
              type: 'fixedrate',
              price: ethers.formatEther(pricing),
              token: baseTokenAddress,
              contract: fixedRate[0],
              exchangeId: fixedRate[1]
            })
            stats.push({
              datatokenAddress: service.datatokenAddress,
              name: await datatoken.name(),
              symbol: await datatoken.symbol(),
              serviceId: service.id,
              orders: 0, // just created
              prices
            })
          }
        } catch (e) {
          INDEXER_LOGGER.error(
            `[GET PRICES] failure when retrieving exchange status from contracts: ${e}`
          )
        }
      }
    }
  }

  ddo.updateFields({ indexedMetadata: { stats } })
  return ddo
}

export function getDid(nftAddress: string, chainId: number): string {
  return (
    'did:op:' +
    createHash('sha256')
      .update(getAddress(nftAddress) + chainId.toString(10))
      .digest('hex')
  )
}
