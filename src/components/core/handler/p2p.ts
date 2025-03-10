import { CommandHandler } from './handler.js'
import { getConfiguration } from '../../../utils/config.js'
import { P2PCommandResponse } from '../../../@types/OceanNode.js'
import {
  FindPeerCommand,
  GetP2PPeerCommand,
  GetP2PPeersCommand,
  GetP2PNetworkStatsCommand
} from '../../../@types/commands.js'
import { Readable } from 'stream'
import {
  ValidateParams,
  validateCommandParameters
} from '../../httpRoutes/validateCommands.js'
import { CORE_LOGGER } from '../../../utils/logging/common.js'

export class FindPeerHandler extends CommandHandler {
  validate(command: FindPeerCommand): ValidateParams {
    const validation = validateCommandParameters(command, ['peerId'])
    return validation
  }

  async handle(task: FindPeerCommand): Promise<P2PCommandResponse> {
    const checks = await this.verifyParamsAndRateLimits(task)
    if (checks.status.httpStatus !== 200 || checks.status.error !== null) {
      return checks
    }
    try {
      const peer = await this.getOceanNode()
        .getP2PNode()
        .findPeerInDht(String(task.peerId), parseInt(String(task.timeout)))
      // .getPeerDetails(String(task.peerId))
      if (!peer) {
        return {
          stream: null,
          status: { httpStatus: 404, error: 'Peer Not Found' }
        }
      }
      return {
        stream: Readable.from(JSON.stringify(peer, null, 4)),
        status: { httpStatus: 200 }
      }
    } catch (error) {
      CORE_LOGGER.error(`Error in Handler: ${error.message}`)
      return {
        stream: null,
        status: { httpStatus: 500, error: 'Unknown error: ' + error.message }
      }
    }
  }
}

export class GetP2PPeerHandler extends CommandHandler {
  validate(command: GetP2PPeerCommand): ValidateParams {
    const validation = validateCommandParameters(command, ['peerId'])
    return validation
  }

  async handle(task: GetP2PPeerCommand): Promise<P2PCommandResponse> {
    const checks = await this.verifyParamsAndRateLimits(task)
    if (checks.status.httpStatus !== 200 || checks.status.error !== null) {
      return checks
    }
    try {
      const peers = await this.getOceanNode()
        .getP2PNode()
        .getPeerDetails(String(task.peerId))
      if (!peers) {
        return {
          stream: null,
          status: { httpStatus: 404, error: 'Peer Not Found' }
        }
      }
      return {
        stream: Readable.from(JSON.stringify(peers, null, 4)),
        status: { httpStatus: 200 }
      }
    } catch (error) {
      CORE_LOGGER.error(`Error in Handler: ${error.message}`)
      return {
        stream: null,
        status: { httpStatus: 500, error: 'Unknown error: ' + error.message }
      }
    }
  }
}

export class GetP2PPeersHandler extends CommandHandler {
  validate(command: GetP2PPeersCommand): ValidateParams {
    const validation = validateCommandParameters(command, [])
    return validation
  }

  async handle(task: GetP2PPeersCommand): Promise<P2PCommandResponse> {
    const checks = await this.verifyParamsAndRateLimits(task)
    if (checks.status.httpStatus !== 200 || checks.status.error !== null) {
      return checks
    }
    try {
      const peers = await this.getOceanNode().getP2PNode().getAllPeerStore()
      if (!peers) {
        return {
          stream: null,
          status: { httpStatus: 404, error: 'Peers Not Found' }
        }
      }
      return {
        stream: Readable.from(JSON.stringify(peers, null, 4)),
        status: { httpStatus: 200 }
      }
    } catch (error) {
      CORE_LOGGER.error(`Error in Handler: ${error.message}`)
      return {
        stream: null,
        status: { httpStatus: 500, error: 'Unknown error: ' + error.message }
      }
    }
  }
}

export class GetP2PNetworkStatsHandler extends CommandHandler {
  validate(command: GetP2PNetworkStatsCommand): ValidateParams {
    const validation = validateCommandParameters(command, [])
    return validation
  }

  async handle(task: GetP2PNetworkStatsCommand): Promise<P2PCommandResponse> {
    const checks = await this.verifyParamsAndRateLimits(task)
    if (checks.status.httpStatus !== 200 || checks.status.error !== null) {
      return checks
    }
    try {
      const config = await getConfiguration()
      if (config.p2pConfig.enableNetworkStats) {
        const stats = await this.getOceanNode().getP2PNode().getNetworkingStats()
        return {
          stream: Readable.from(JSON.stringify(stats, null, 4)),
          status: { httpStatus: 200 }
        }
      } else {
        return {
          stream: null,
          status: { httpStatus: 400, error: 'Not enabled or unavailable' }
        }
      }
    } catch (error) {
      CORE_LOGGER.error(`Error in Handler: ${error.message}`)
      return {
        stream: null,
        status: { httpStatus: 500, error: 'Unknown error: ' + error.message }
      }
    }
  }
}
