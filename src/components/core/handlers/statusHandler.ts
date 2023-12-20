import {
  OceanNodeStatus,
  OceanNodeProvider,
  OceanNodeIndexer,
  P2PCommandResponse,
  OceanNodeConfig
} from '../../../@types/OceanNode.js'
import {
  CustomNodeLogger,
  LOGGER_MODULE_NAMES,
  LOG_LEVELS_STR,
  GENERIC_EMOJIS,
  defaultConsoleTransport,
  getCustomLoggerForModule
} from '../../../utils/logging/Logger.js'
import { Readable } from 'stream'
import { Handler } from './handler.js'
import { Command } from '../../../utils/constants.js'
import os from 'os'

export const STATUS_CONSOLE_LOGGER: CustomNodeLogger = getCustomLoggerForModule(
  LOGGER_MODULE_NAMES.CORE,
  LOG_LEVELS_STR.LEVEL_INFO,
  defaultConsoleTransport
)

export class StatusHandler extends Handler {
  public constructor(task: any, config: OceanNodeConfig) {
    super(task, config, null)
    if (!this.isCommand(task)) {
      throw new Error(`Task has not Command type. It has ${typeof task}`)
    }
  }

  isCommand(obj: any): obj is Command {
    return typeof obj === 'object' && obj !== null && 'command' in obj
  }

  async status(nodeId?: string): Promise<OceanNodeStatus> {
    STATUS_CONSOLE_LOGGER.logMessage('Command status started execution...', true)
    const config = this.getConfig()
    if (!config) {
      STATUS_CONSOLE_LOGGER.logMessageWithEmoji(
        'Config object not found. Cannot proceed with status command.',
        true,
        GENERIC_EMOJIS.EMOJI_CROSS_MARK,
        LOG_LEVELS_STR.LEVEL_ERROR
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
      indexer: [],
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
        osVersion: os.version()
      }
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

    for (const [key, supportedNetwork] of Object.entries(config.supportedNetworks)) {
      const provider: OceanNodeProvider = {
        chainId: key,
        network: supportedNetwork.network
      }
      status.provider.push(provider)
      const indexer: OceanNodeIndexer = {
        chainId: key,
        network: supportedNetwork.network,
        block: '0'
      }
      status.indexer.push(indexer)
    }
    return status
  }

  async handle(): Promise<P2PCommandResponse> {
    try {
      const statusResult = await this.status(this.getTask().node)
      if (!statusResult) {
        return {
          stream: null,
          status: { httpStatus: 404, error: 'Status Not Found' }
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
}
