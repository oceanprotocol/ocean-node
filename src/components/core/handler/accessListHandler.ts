import { CommandHandler } from './handler.js'
import { P2PCommandResponse } from '../../../@types/OceanNode.js'
import {
  GetAccessListCommand,
  SearchAccessListCommand
} from '../../../@types/commands.js'
import { Readable } from 'stream'
import {
  ValidateParams,
  validateCommandParameters
} from '../../httpRoutes/validateCommands.js'
import { CORE_LOGGER } from '../../../utils/logging/common.js'

export class GetAccessListHandler extends CommandHandler {
  validate(command: GetAccessListCommand): ValidateParams {
    return validateCommandParameters(command, ['chainId', 'contractAddress'])
  }

  async handle(task: GetAccessListCommand): Promise<P2PCommandResponse> {
    const checks = await this.verifyParamsAndRateLimits(task)
    if (checks.status.httpStatus !== 200 || checks.status.error !== null) {
      return checks
    }
    try {
      const db = await this.getOceanNode().getDatabase()
      const doc = await db.accessList.retrieve(
        Number(task.chainId),
        String(task.contractAddress)
      )
      if (!doc) {
        return {
          stream: null,
          status: { httpStatus: 404, error: 'AccessList not found' }
        }
      }
      return {
        stream: Readable.from(JSON.stringify(doc)),
        status: { httpStatus: 200 }
      }
    } catch (error) {
      CORE_LOGGER.error(`GetAccessListHandler error: ${error.message}`)
      return {
        stream: null,
        status: { httpStatus: 500, error: 'Unknown error: ' + error.message }
      }
    }
  }
}

export class SearchAccessListHandler extends CommandHandler {
  validate(command: SearchAccessListCommand): ValidateParams {
    return validateCommandParameters(command, ['wallet'])
  }

  async handle(task: SearchAccessListCommand): Promise<P2PCommandResponse> {
    const checks = await this.verifyParamsAndRateLimits(task)
    if (checks.status.httpStatus !== 200 || checks.status.error !== null) {
      return checks
    }
    try {
      const db = await this.getOceanNode().getDatabase()
      const chainId = task.chainId !== undefined ? Number(task.chainId) : undefined
      const docs = await db.accessList.searchByWallet(String(task.wallet), chainId)
      return {
        stream: Readable.from(JSON.stringify(docs ?? [])),
        status: { httpStatus: 200 }
      }
    } catch (error) {
      CORE_LOGGER.error(`SearchAccessListHandler error: ${error.message}`)
      return {
        stream: null,
        status: { httpStatus: 500, error: 'Unknown error: ' + error.message }
      }
    }
  }
}
