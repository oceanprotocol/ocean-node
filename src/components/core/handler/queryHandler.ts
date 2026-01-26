import { CommandHandler } from './handler.js'
import { QueryCommand } from '../../../@types/commands.js'
import { P2PCommandResponse } from '../../../@types/OceanNode.js'
import { Readable } from 'stream'
import {
  ValidateParams,
  buildInvalidParametersResponse,
  validateCommandParameters
} from '../../httpRoutes/validateCommands.js'
import { CORE_LOGGER } from '../../../utils/logging/common.js'

export class QueryHandler extends CommandHandler {
  validate(command: QueryCommand): ValidateParams {
    return validateCommandParameters(command, ['query'])
  }

  async handle(task: QueryCommand): Promise<P2PCommandResponse> {
    const validationResponse = await this.verifyParamsAndRateLimits(task)
    if (this.shouldDenyTaskHandling(validationResponse)) {
      return validationResponse
    }
    try {
      const database = this.getOceanNode().getDatabase()
      if (!database || !database.ddo) {
        CORE_LOGGER.error('DDO database is not available')
        return {
          stream: null,
          status: { httpStatus: 503, error: 'DDO database is not available' }
        }
      }
      let result = await database.ddo.search(task.query)
      if (!result) {
        result = []
      }
      return {
        stream: Readable.from(JSON.stringify(result)),
        status: { httpStatus: 200 }
      }
    } catch (error) {
      CORE_LOGGER.error(`Error in QueryHandler: ${error.message}`)
      return {
        stream: null,
        status: { httpStatus: 500, error: 'Unknown error: ' + error.message }
      }
    }
  }
}

export class QueryDdoStateHandler extends QueryHandler {
  async handle(task: QueryCommand): Promise<P2PCommandResponse> {
    const validation = this.validate(task)
    if (!validation.valid) {
      return buildInvalidParametersResponse(validation)
    }
    try {
      const database = this.getOceanNode().getDatabase()
      if (!database || !database.ddoState) {
        CORE_LOGGER.error('DDO State database is not available')
        return {
          stream: null,
          status: { httpStatus: 503, error: 'DDO State database is not available' }
        }
      }

      const result = await database.ddoState.search(task.query)

      CORE_LOGGER.debug(`DDO State search result: ${JSON.stringify(result)}`)

      if (result === null) {
        CORE_LOGGER.error('Database search returned null')
        return {
          stream: null,
          status: { httpStatus: 500, error: 'Database search failed' }
        }
      }

      return {
        stream: Readable.from(JSON.stringify(result)),
        status: { httpStatus: 200 }
      }
    } catch (error) {
      CORE_LOGGER.error(`Error in QueryDdoStateHandler: ${error.message}`)
      return {
        stream: null,
        status: { httpStatus: 500, error: 'Unknown error: ' + error.message }
      }
    }
  }
}
