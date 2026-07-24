import { Readable } from 'stream'
import { P2PCommandResponse } from '../../../@types/index.js'
import { ServiceStopCommand } from '../../../@types/commands.js'
import { CommandHandler } from '../handler/handler.js'
import {
  ValidateParams,
  validateCommandParameters,
  buildInvalidParametersResponse,
  buildInvalidRequestMessage
} from '../../httpRoutes/validateCommands.js'
import { CORE_LOGGER } from '../../../utils/logging/common.js'
import { findServiceJobAndEngine, toPublicServiceJob } from './utils.js'

export class ServiceStopHandler extends CommandHandler {
  validate(command: ServiceStopCommand): ValidateParams {
    return validateCommandParameters(command, ['consumerAddress', 'serviceId'])
  }

  async handle(task: ServiceStopCommand): Promise<P2PCommandResponse> {
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

    // Find the job and the engine that owns it (by clusterHash — see helper)
    const { job, engine } = await findServiceJobAndEngine(
      engines,
      task.serviceId,
      task.consumerAddress
    )
    if (!job)
      return buildInvalidParametersResponse(
        buildInvalidRequestMessage('Service job not found: ' + task.serviceId)
      )
    if (!engine)
      return {
        stream: null,
        status: {
          httpStatus: 500,
          error: `No compute engine owns service ${task.serviceId} (cluster ${job.clusterHash}) — the node's compute configuration may have changed`
        }
      }
    if (job.owner.toLowerCase() !== task.consumerAddress.toLowerCase())
      return { stream: null, status: { httpStatus: 401, error: 'Not the service owner' } }

    try {
      const stopped = await engine.stopService(task.serviceId, task.consumerAddress)
      return {
        stream: Readable.from(JSON.stringify([toPublicServiceJob(stopped)])),
        status: { httpStatus: 200 }
      }
    } catch (error: any) {
      CORE_LOGGER.error(`ServiceStop ${task.serviceId} failed: ${error.message}`)
      return { stream: null, status: { httpStatus: 500, error: error.message } }
    }
  }
}
