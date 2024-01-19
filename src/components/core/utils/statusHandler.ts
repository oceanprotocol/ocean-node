import os from 'os'
import { LOG_LEVELS_STR, GENERIC_EMOJIS } from '../../../utils/logging/Logger.js'
import {
  OceanNodeStatus,
  OceanNodeProvider,
  OceanNodeIndexer,
  StorageTypes
} from '../../../@types/OceanNode.js'
import { existsEnvironmentVariable } from '../../../utils/index.js'
import { ENVIRONMENT_VARIABLES } from '../../../utils/constants.js'
import { CORE_LOGGER } from '../../../utils/logging/common.js'
import { OceanNode } from '../../../OceanNode.js'

export async function status(
  oceanNode: OceanNode,
  nodeId?: string
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
  const config = oceanNode.getConfig()
  const { indexer: indexerDatabase } = oceanNode.getDatabase()
  const status: OceanNodeStatus = {
    id: undefined,
    publicKey: undefined,
    address: undefined,
    version: undefined,
    http: undefined,
    p2p: undefined,
    provider: [],
    indexer: [],
    supportedStorage: undefined,
    uptime: process.uptime(),
    platform: {
      cpus: os.cpus().length,
      freemem: os.freemem(),
      totalmem: os.totalmem(),
      loadavg: os.loadavg(),
      arch: os.arch(),
      machine: os.machine(),
      platform: os.platform(),
      release: os.release(),
      osType: os.type(),
      osVersion: os.version(),
      node: process.version
    }
  }
  if (nodeId && nodeId !== undefined) {
    status.id = nodeId
  } else {
    // get current node ID
    status.id = config.keys.peerId.toString()
  }

  const supportedStorageTypes: StorageTypes = {
    url: true,
    arwave: existsEnvironmentVariable(ENVIRONMENT_VARIABLES.ARWEAVE_GATEWAY),
    ipfs: existsEnvironmentVariable(ENVIRONMENT_VARIABLES.IPFS_GATEWAY)
  }

  status.version = process.env.npm_package_version
  status.publicKey = Buffer.from(config.keys.publicKey).toString('hex')
  status.address = config.keys.ethAddress
  status.http = config.hasHttp
  status.p2p = config.hasP2P
  status.supportedStorage = supportedStorageTypes

  if (config.supportedNetworks) {
    for (const [key, supportedNetwork] of Object.entries(config.supportedNetworks)) {
      if (config.hasProvider) {
        const provider: OceanNodeProvider = {
          chainId: key,
          network: supportedNetwork.network
        }
        status.provider.push(provider)
      }
      if (config.hasIndexer) {
        let blockNr = '0'
        try {
          const { lastIndexedBlock } = await indexerDatabase.retrieve(
            supportedNetwork.chainId
          )
          blockNr = lastIndexedBlock.toString()
        } catch (error) {
          CORE_LOGGER.log(
            LOG_LEVELS_STR.LEVEL_ERROR,
            `Error fetching last indexed block for network ${supportedNetwork.network}`
          )
        }
        const indexer: OceanNodeIndexer = {
          chainId: key,
          network: supportedNetwork.network,
          block: blockNr
        }
        status.indexer.push(indexer)
      }
    }
  }
  return status
}
