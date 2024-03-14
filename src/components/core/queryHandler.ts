import { Handler } from './handler.js'
import { QueryCommand } from '../../@types/commands.js'
import { P2PCommandResponse } from '../../@types/OceanNode.js'
import { Readable } from 'stream'
import {
  ValidateParams,
  buildInvalidParametersResponse,
  validateCommandParameters
} from '../httpRoutes/validateCommands.js'

export class QueryHandler extends Handler {
  validate(command: QueryCommand): ValidateParams {
    return validateCommandParameters(command, ['query'])
  }

  async handle(task: QueryCommand): Promise<P2PCommandResponse> {
    const validation = this.validate(task)
    if (!validation.valid) {
      return buildInvalidParametersResponse(validation)
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
      return {
        stream: null,
        status: { httpStatus: 500, error: 'Unknown error: ' + error.message }
      }
    }
  }
}
