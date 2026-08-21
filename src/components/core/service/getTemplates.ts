import { Readable } from 'stream'
import { P2PCommandResponse } from '../../../@types/index.js'
import { ServiceGetTemplatesCommand } from '../../../@types/commands.js'
import { CommandHandler } from '../handler/handler.js'
import {
  ValidateParams,
  validateCommandParameters
} from '../../httpRoutes/validateCommands.js'
import { CORE_LOGGER } from '../../../utils/logging/common.js'

export class ServiceGetTemplatesHandler extends CommandHandler {
  validate(command: ServiceGetTemplatesCommand): ValidateParams {
    return validateCommandParameters(command, [])
  }

  async handle(task: ServiceGetTemplatesCommand): Promise<P2PCommandResponse> {
    const validationResponse = await this.verifyParamsAndRateLimits(task)
    if (this.shouldDenyTaskHandling(validationResponse)) return validationResponse
    try {
      const engines = this.getOceanNode().getC2DEngines()
      if (!engines)
        return {
          stream: null,
          status: { httpStatus: 503, error: 'Compute engines not configured' }
        }

      const templates = await engines.fetchServiceTemplates()
      CORE_LOGGER.logMessage(
        `ServiceGetTemplates: returning ${templates.length} template(s)`,
        true
      )
      return {
        stream: Readable.from(JSON.stringify(templates)),
        status: { httpStatus: 200 }
      }
    } catch (error: any) {
      CORE_LOGGER.error(error.message)
      return { stream: null, status: { httpStatus: 500, error: error.message } }
    }
  }
}
