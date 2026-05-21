import { CommandHandler } from './handler.js'
import { GetEscrowEventsCommand } from '../../../@types/commands.js'
import { P2PCommandResponse } from '../../../@types/OceanNode.js'
import { Readable } from 'stream'
import {
  ValidateParams,
  validateCommandParameters
} from '../../httpRoutes/validateCommands.js'
import { CORE_LOGGER } from '../../../utils/logging/common.js'

export class EscrowEventsHandler extends CommandHandler {
  validate(command: GetEscrowEventsCommand): ValidateParams {
    return validateCommandParameters(command, [])
  }

  async handle(task: GetEscrowEventsCommand): Promise<P2PCommandResponse> {
    const validationResponse = await this.verifyParamsAndRateLimits(task)
    if (this.shouldDenyTaskHandling(validationResponse)) {
      return validationResponse
    }
    try {
      const database = await this.getOceanNode().getDatabase()
      if (!database || !database.escrow) {
        CORE_LOGGER.error('Escrow database is not available')
        return {
          stream: null,
          status: { httpStatus: 503, error: 'Escrow database is not available' }
        }
      }

      const filters: Record<string, any> = {
        chainId: task.chainId,
        eventType: task.eventType,
        payer: task.payer ? task.payer.toLowerCase() : undefined,
        payee: task.payee ? task.payee.toLowerCase() : undefined,
        token: task.token ? task.token.toLowerCase() : undefined,
        jobId: task.jobId,
        txHash: task.txId
      }

      let result = await database.escrow.search(
        filters,
        task.maxResultsPerPage,
        task.pageNumber
      )
      if (!result) {
        result = []
      }
      return {
        stream: Readable.from(JSON.stringify(result)),
        status: { httpStatus: 200 }
      }
    } catch (error) {
      CORE_LOGGER.error(`Error in EscrowEventsHandler: ${error.message}`)
      return {
        stream: null,
        status: { httpStatus: 500, error: 'Unknown error: ' + error.message }
      }
    }
  }
}
