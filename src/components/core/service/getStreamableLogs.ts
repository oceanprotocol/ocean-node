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
import { findServiceJobAndEngine, parseSinceParam } from './utils.js'

export class ServiceGetStreamableLogsHandler extends CommandHandler {
  validate(command: ServiceGetStreamableLogsCommand): ValidateParams {
    const validation = validateCommandParameters(command, [
      'consumerAddress',
      'serviceId'
    ])
    if (!validation.valid) return validation
    if (command.since) {
      try {
        parseSinceParam(command.since)
      } catch (error: any) {
        return buildInvalidRequestMessage(error.message)
      }
    }
    return validation
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
      const respStream = await engine.getServiceStreamableLogs(
        task.serviceId,
        task.consumerAddress,
        parseSinceParam(task.since)
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
