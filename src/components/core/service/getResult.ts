import { Stream } from 'stream'
import { P2PCommandResponse } from '../../../@types/index.js'
import { ServiceGetResultCommand } from '../../../@types/commands.js'
import { CommandHandler } from '../handler/handler.js'
import {
  ValidateParams,
  validateCommandParameters,
  buildInvalidParametersResponse,
  buildInvalidRequestMessage
} from '../../httpRoutes/validateCommands.js'
import { CORE_LOGGER } from '../../../utils/logging/common.js'
import { ServiceResultError } from '../../c2d/serviceOutputsZip.js'
import { findServiceJobAndEngine } from './utils.js'

// Downloads the /data/outputs of a service without an output bucket, as a zip: either one of
// the archives taken whenever a container of the service was removed (`index`, listed in the
// service status as outputArchives, resumable with `offset`), or a live zip of the running
// container (`live: true`).
export class ServiceGetResultHandler extends CommandHandler {
  validate(command: ServiceGetResultCommand): ValidateParams {
    const validation = validateCommandParameters(command, [
      'consumerAddress',
      'serviceId'
    ])
    if (!validation.valid) return validation
    const hasIndex = command.index !== undefined && command.index !== null
    if (command.live === true) {
      if (hasIndex)
        return buildInvalidRequestMessage('"index" and "live" are mutually exclusive')
      if (command.offset)
        return buildInvalidRequestMessage('"offset" is not supported with "live"')
      return validation
    }
    if (!hasIndex)
      return buildInvalidRequestMessage('Either "index" or "live" is required')
    if (!Number.isInteger(command.index) || command.index < 0)
      return buildInvalidRequestMessage('Invalid result index')
    if (
      command.offset !== undefined &&
      command.offset !== null &&
      (!Number.isInteger(command.offset) || command.offset < 0)
    )
      return buildInvalidRequestMessage('Invalid offset')
    return validation
  }

  async handle(task: ServiceGetResultCommand): Promise<P2PCommandResponse> {
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
      const result = await engine.getServiceResult(
        task.serviceId,
        task.consumerAddress,
        task.live === true ? 'live' : task.index,
        task.offset ?? 0
      )
      if (!result)
        return {
          stream: null,
          status: { httpStatus: 404, error: 'Service not found: ' + task.serviceId }
        }
      return {
        stream: result.stream as unknown as Stream,
        status: { httpStatus: 200, headers: result.headers }
      }
    } catch (error) {
      if (error instanceof ServiceResultError)
        return {
          stream: null,
          status: { httpStatus: error.httpStatus, error: error.message }
        }
      const message = (error as Error)?.message ?? String(error)
      CORE_LOGGER.error(`ServiceGetResultHandler: ${message}`)
      return { stream: null, status: { httpStatus: 500, error: message } }
    }
  }
}
