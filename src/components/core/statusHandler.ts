import {
  OceanNodeStatus,
  OceanNodeProvider,
  OceanNodeIndexer,
  P2PCommandResponse
} from '../../@types'
import {
  CustomNodeLogger,
  LOGGER_MODULE_NAMES,
  LOG_LEVELS_STR,
  GENERIC_EMOJIS,
  defaultConsoleTransport,
  getCustomLoggerForModule
} from '../../utils/logging/Logger.js'
import { Blockchain } from '../../utils/blockchain.js'
import { getConfig } from '../../utils/index.js'
import { Command } from '../../utils/constants.js'
import { Readable } from 'stream'

export const STATUS_CONSOLE_LOGGER: CustomNodeLogger = getCustomLoggerForModule(
  LOGGER_MODULE_NAMES.CORE,
  LOG_LEVELS_STR.LEVEL_INFO,
  defaultConsoleTransport
)

export async function status(nodeId?: string): Promise<OceanNodeStatus> {
  STATUS_CONSOLE_LOGGER.logMessage('Command status started execution...', true)
  const config = await getConfig()
  if (!config) {
    STATUS_CONSOLE_LOGGER.logMessageWithEmoji(
      'Config object not found. Cannot proceed with status command.',
      true,
      GENERIC_EMOJIS.EMOJI_CROSS_MARK,
      LOG_LEVELS_STR.LEVEl_ERROR
    )
    return
  }
  const status: OceanNodeStatus = {
    id: undefined,
    publicKey: undefined,
    address: undefined,
    version: undefined,
    http: undefined,
    p2p: undefined,
    provider: [],
    indexer: []
  }
  if (nodeId && nodeId !== undefined) {
    status.id = nodeId
  } else {
    // get current node ID
    status.id = config.keys.peerId.toString()
  }
  status.version = process.env.npm_package_version
  status.publicKey = Buffer.from(config.keys.publicKey).toString('hex')
  status.address = config.keys.ethAddress
  status.http = config.hasHttp
  status.p2p = config.hasP2P
  const blockchain = new Blockchain(JSON.parse(process.env.RPCS), config.keys)
  const supportedChains = blockchain.getSupportedChains()
  status.provider = supportedChains.map((chain) => {
    const provider: OceanNodeProvider = {
      chainId: undefined,
      network: undefined
    }
    provider.chainId = chain
    provider.network = blockchain.getNetworkNameByChainId(chain)
    return provider
  })
  status.indexer = supportedChains.map((chain) => {
    const indexer: OceanNodeIndexer = {
      chainId: undefined,
      network: undefined,
      block: undefined
    }
    indexer.chainId = chain
    indexer.network = blockchain.getNetworkNameByChainId(chain)
    indexer.block = '0'
    return indexer
  })

  return status
}

export async function handleStatusCommand(task: Command): Promise<P2PCommandResponse> {
  try {
    const statusResult = await status(task.node)
    if (!statusResult) {
      return {
        stream: null,
        status: { httpStatus: 404, error: 'Config Not Found' }
      }
    }
    return {
      stream: Readable.from(JSON.stringify(statusResult)),
      status: { httpStatus: 200 }
    }
  } catch (error) {
    return {
      stream: null,
      status: { httpStatus: 500, error: 'Unknown error: ' + error.message }
    }
  }
}
