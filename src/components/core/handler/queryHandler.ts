import { Handler } from './handler.js'
import { QueryCommand } from '../../../@types/commands.js'
import { P2PCommandResponse } from '../../../@types/OceanNode.js'
import { Readable } from 'stream'
import {
  ValidateParams,
  buildInvalidParametersResponse,
  validateCommandParameters
} from '../../httpRoutes/validateCommands.js'
import { CORE_LOGGER } from '../../../utils/logging/common.js'

export class QueryHandler extends Handler {
  validate(command: QueryCommand): ValidateParams {
    return validateCommandParameters(command, ['query'])
  }

  async handle(task: QueryCommand): Promise<P2PCommandResponse> {
    const validationResponse = await this.verifyParamsAndRateLimits(task)
    if (this.shouldDenyTaskHandling(validationResponse)) {
      return validationResponse
    }
    try {
      let result = await this.getOceanNode().getDatabase().ddo.search(task.query)
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
      const result = await this.getOceanNode().getDatabase().ddoState.search(task.query)
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
