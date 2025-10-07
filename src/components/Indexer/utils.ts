import { JsonRpcApiProvider, Signer, ethers, getAddress } from 'ethers'
import ERC721Factory from '@oceanprotocol/contracts/artifacts/contracts/ERC721Factory.sol/ERC721Factory.json' assert { type: 'json' }
import ERC721Template from '@oceanprotocol/contracts/artifacts/contracts/templates/ERC721Template.sol/ERC721Template.json' assert { type: 'json' }
import { EVENT_HASHES, isDefined } from '../../utils/index.js'
import { NetworkEvent } from '../../@types/blockchain.js'
import { INDEXER_LOGGER } from '../../utils/logging/common.js'
import ERC20Template from '@oceanprotocol/contracts/artifacts/contracts/templates/ERC20TemplateEnterprise.sol/ERC20TemplateEnterprise.json' assert { type: 'json' }
import { getOceanArtifactsAdressesByChainId } from '../../utils/address.js'
import { CommandStatus, JobStatus } from '../../@types/commands.js'
import { create256Hash } from '../../utils/crypt.js'
import Dispenser from '@oceanprotocol/contracts/artifacts/contracts/pools/dispenser/Dispenser.sol/Dispenser.json' assert { type: 'json' }
import FixedRateExchange from '@oceanprotocol/contracts/artifacts/contracts/pools/fixedRate/FixedRateExchange.sol/FixedRateExchange.json' assert { type: 'json' }
import { createHash } from 'crypto'
import { ServicePrice } from '../../@types/IndexedMetadata.js'
import { VersionedDDO } from '@oceanprotocol/ddo-js'

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
    const details = {
      fromBlock: startIndex,
      toBlock: lastIndexedBlock + count,
      topics: [eventHashes]
    }
    INDEXER_LOGGER.debug(
      `Retrieving events from block ${startIndex} to ${lastIndexedBlock + count}`
    )
    const blockLogs = await provider.getLogs(details)
    return blockLogs
  } catch (error) {
    INDEXER_LOGGER.error(
      `Error retrieving events from block ${lastIndexedBlock + 1} to ${
        lastIndexedBlock + count
      }:`
    )
    INDEXER_LOGGER.error(error)
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
  if (isDefined(process.env.INDEXER_INTERVAL)) {
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
