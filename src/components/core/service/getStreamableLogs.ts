import { Stream } from 'stream'
import { P2PCommandResponse } from '../../../@types/index.js'
import { ServiceGetStreamableLogsCommand } from '../../../@types/commands.js'
import { CommandHandler } from '../handler/handler.js'
import {
  ValidateParams,
  validateCommandParameters,
  buildInvalidParametersResponse,
  buildInvalidRequestMessage
} from '../../httpRoutes/validateCommands.js'
import { CORE_LOGGER } from '../../../utils/logging/common.js'
import type { C2DEngine } from '../../c2d/compute_engine_base.js'
import type { ServiceJob } from '../../../@types/C2D/ServiceOnDemand.js'

export class ServiceGetStreamableLogsHandler extends CommandHandler {
  validate(command: ServiceGetStreamableLogsCommand): ValidateParams {
    return validateCommandParameters(command, ['consumerAddress', 'serviceId'])
  }

  async handle(task: ServiceGetStreamableLogsCommand): Promise<P2PCommandResponse> {
    const validationResponse = await this.verifyParamsAndRateLimits(task)
    if (this.shouldDenyTaskHandling(validationResponse)) return validationResponse

    const auth = await this.validateTokenOrSignature(
      task.authorization,
      task.consumerAddress,
      task.nonce,
      task.signature,
      task.command
    )
    if (auth.status.httpStatus !== 200) return auth

    const engines = this.getOceanNode().getC2DEngines()
    if (!engines)
      return {
        stream: null,
        status: { httpStatus: 503, error: 'Compute engines not configured' }
      }

    // Find job across all engines by serviceId + owner
    let job: ServiceJob | null = null
    let engine: C2DEngine | null = null
    for (const eng of engines.getAllEngines()) {
      const [found] = await eng.db.getServiceJob(task.serviceId, task.consumerAddress)
      if (found) {
        job = found
        engine = eng
        break
      }
    }
    if (!job || !engine)
      return buildInvalidParametersResponse(
        buildInvalidRequestMessage('Service job not found: ' + task.serviceId)
      )
    if (job.owner.toLowerCase() !== task.consumerAddress.toLowerCase())
      return { stream: null, status: { httpStatus: 401, error: 'Not the service owner' } }

    try {
      const respStream = await engine.getServiceStreamableLogs(
        task.serviceId,
        task.consumerAddress
      )
      if (!respStream) {
        return {
          stream: null,
          status: { httpStatus: 404, error: 'Service not found or not running' }
        }
      }
      return { stream: respStream as unknown as Stream, status: { httpStatus: 200 } }
    } catch (error) {
      const message = (error as Error)?.message ?? String(error)
      CORE_LOGGER.error(message)
      return { stream: null, status: { httpStatus: 500, error: message } }
    }
  }
}
