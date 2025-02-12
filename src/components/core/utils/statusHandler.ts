import os from 'os'
import { LOG_LEVELS_STR, GENERIC_EMOJIS } from '../../../utils/logging/Logger.js'
import {
  OceanNodeStatus,
  OceanNodeProvider,
  OceanNodeIndexer,
  StorageTypes,
  OceanNodeConfig
} from '../../../@types/OceanNode.js'
import {
  Blockchain,
  existsEnvironmentVariable,
  getConfiguration
} from '../../../utils/index.js'
import { ENVIRONMENT_VARIABLES } from '../../../utils/constants.js'
import { CORE_LOGGER } from '../../../utils/logging/common.js'
import { OceanNode } from '../../../OceanNode.js'
import { ethers, isAddress } from 'ethers'
import { typesenseSchemas } from '../../database/TypesenseSchemas.js'
import { RPCS, SupportedNetwork } from '../../../@types/blockchain.js'
import { isDefined } from '../../../utils/util.js'
import AccessListContract from '@oceanprotocol/contracts/artifacts/contracts/accesslists/AccessList.sol/AccessList.json' assert { type: 'json' }
import { getAccountsFromAccessList } from '../../../utils/credentials.js'

async function getAdminAddresses(config: OceanNodeConfig): Promise<string[]> {
  const validAddresses: string[] = []
  if (config.allowedAdmins && config.allowedAdmins.length > 0) {
    for (const admin of config.allowedAdmins) {
      if (isAddress(admin) === true) {
        validAddresses.push(admin)
      }
    }
    if (validAddresses.length === 0) {
      CORE_LOGGER.log(
        LOG_LEVELS_STR.LEVEL_ERROR,
        `Invalid format for ETH address from ALLOWED ADMINS.`
      )
    }
  }
  if (
    config.allowedAdminsList &&
    isDefined(config.supportedNetworks) &&
    Object.keys(config.allowedAdminsList).length > 0
  ) {
    const RPCS: RPCS = config.supportedNetworks
    const supportedChains: string[] = Object.keys(config.supportedNetworks)
    const accessListsChainsListed = Object.keys(config.allowedAdminsList)
    for (const chain of supportedChains) {
      const { chainId, network, rpc, fallbackRPCs } = RPCS[chain]
      const blockchain = new Blockchain(rpc, network, chainId, fallbackRPCs)

      // check the access lists for this chain
      if (accessListsChainsListed.length > 0 && accessListsChainsListed.includes(chain)) {
        for (const accessListAddress of config.allowedAdminsList[chainId]) {
          // instantiate contract and check addresses present + balanceOf()
          const accessListContract = new ethers.Contract(
            accessListAddress,
            AccessListContract.abi,
            blockchain.getSigner()
          )

          const adminsFromAccessList: string[] = await getAccountsFromAccessList(
            accessListContract,
            chainId
          )
          if (adminsFromAccessList.length > 0) {
            return validAddresses.concat(adminsFromAccessList)
          }
        }
      }
    }
  }
  return validAddresses
}
const supportedStorageTypes: StorageTypes = {
  url: true,
  arwave: existsEnvironmentVariable(ENVIRONMENT_VARIABLES.ARWEAVE_GATEWAY),
  ipfs: existsEnvironmentVariable(ENVIRONMENT_VARIABLES.IPFS_GATEWAY)
}

// platform information
const platformInfo = {
  cpus: os.cpus().length,
  freemem: os.freemem(),
  totalmem: os.totalmem(),
  loadavg: os.loadavg(),
  arch: os.arch(),
  machine: os.machine(),
  platform: os.platform(),
  osType: os.type(),
  node: process.version
}

function getProviderInfo(config: OceanNodeConfig): OceanNodeProvider[] {
  const providers: OceanNodeProvider[] = []
  for (const [key, supportedNetwork] of Object.entries(config.supportedNetworks)) {
    const provider: OceanNodeProvider = {
      chainId: key,
      network: supportedNetwork.network
    }
    providers.push(provider)
  }
  return providers
}

async function getIndexerInfo(
  oceanNode: OceanNode,
  config: OceanNodeConfig
): Promise<OceanNodeIndexer[]> {
  const indexerNetworks: OceanNodeIndexer[] = []
  if (config.indexingNetworks) {
    for (const [key, indexedNetwork] of Object.entries(config.indexingNetworks)) {
      if (config.hasIndexer) {
        const blockNr = await getIndexerBlockInfo(oceanNode, indexedNetwork)
        const indexer: OceanNodeIndexer = {
          chainId: key,
          network: indexedNetwork.network,
          block: blockNr
        }
        indexerNetworks.push(indexer)
      }
    }
  }
  return indexerNetworks
}

async function getIndexerBlockInfo(
  oceanNode: OceanNode,
  supportedNetwork: SupportedNetwork
): Promise<string> {
  let blockNr = '0'
  try {
    const { indexer: indexerDatabase } = oceanNode.getDatabase()
    const { lastIndexedBlock } = await indexerDatabase.retrieve(supportedNetwork.chainId)
    blockNr = lastIndexedBlock.toString()
  } catch (error) {
    CORE_LOGGER.log(
      LOG_LEVELS_STR.LEVEL_ERROR,
      `Error fetching last indexed block for network ${supportedNetwork.network}`
    )
  }
  return blockNr
}

let nodeStatus: OceanNodeStatus = null

export async function status(
  oceanNode: OceanNode,
  nodeId?: string,
  detailed: boolean = false
): Promise<OceanNodeStatus> {
  CORE_LOGGER.logMessage('Command status started execution...', true)
  if (!oceanNode) {
    CORE_LOGGER.logMessageWithEmoji(
      'Node object not found. Cannot proceed with status command.',
      true,
      GENERIC_EMOJIS.EMOJI_CROSS_MARK,
      LOG_LEVELS_STR.LEVEL_ERROR
    )
    return
  }
  const config = await getConfiguration()

  // no previous status?
  if (!nodeStatus) {
    nodeStatus = {
      id: nodeId && nodeId !== undefined ? nodeId : config.keys.peerId.toString(), // get current node ID
      publicKey: Buffer.from(config.keys.publicKey).toString('hex'),
      address: config.keys.ethAddress,
      version: process.env.npm_package_version,
      http: config.hasHttp,
      p2p: config.hasP2P,
      provider: [],
      indexer: [],
      supportedStorage: supportedStorageTypes,
      // uptime: process.uptime(),
      platform: platformInfo,
      codeHash: config.codeHash,
      allowedAdmins: await getAdminAddresses(config)
    }
  }
  // need to update at least block info if available
  if (config.supportedNetworks) {
    nodeStatus.provider = getProviderInfo(config)
    nodeStatus.indexer = await getIndexerInfo(oceanNode, config)
  }
  // only these 2 might change between requests
  nodeStatus.platform.freemem = os.freemem()
  nodeStatus.platform.loadavg = os.loadavg()
  nodeStatus.uptime = process.uptime()

  // depends on request
  if (detailed) {
    nodeStatus.c2dClusters = config.c2dClusters
    nodeStatus.supportedSchemas = typesenseSchemas.ddoSchemas
  }
  return nodeStatus
}
