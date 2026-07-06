import { Readable } from 'stream'
import { P2PCommandResponse } from '../../../@types/index.js'
import { ServiceRestartCommand } from '../../../@types/commands.js'
import { CommandHandler } from '../handler/handler.js'
import {
  ValidateParams,
  validateCommandParameters,
  buildInvalidParametersResponse,
  buildInvalidRequestMessage
} from '../../httpRoutes/validateCommands.js'
import { CORE_LOGGER } from '../../../utils/logging/common.js'
import type { C2DEngine } from '../../c2d/compute_engine_base.js'
import type { ComputeEnvironment } from '../../../@types/C2D/C2D.js'
import type { ServiceJob } from '../../../@types/C2D/ServiceOnDemand.js'
import { ServiceStatusNumber } from '../../../@types/C2D/ServiceOnDemand.js'
import { validateAccess } from '../compute/startCompute.js'
import { decryptUserData, toPublicServiceJob } from './utils.js'

export class ServiceRestartHandler extends CommandHandler {
  validate(command: ServiceRestartCommand): ValidateParams {
    return validateCommandParameters(command, ['consumerAddress', 'serviceId'])
  }

  async handle(task: ServiceRestartCommand): Promise<P2PCommandResponse> {
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

    const node = this.getOceanNode()
    const engines = node.getC2DEngines()
    if (!engines)
      return {
        stream: null,
        status: { httpStatus: 503, error: 'Compute engines not configured' }
      }

    // Find job across all engines
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

    // Ownership check
    if (job.owner.toLowerCase() !== task.consumerAddress.toLowerCase())
      return { stream: null, status: { httpStatus: 401, error: 'Not the service owner' } }

    // Resolve the environment the service runs on. This MUST exist: the services gate and
    // access gate both key off it, and restarting resumes the container on it.
    const runEnv: ComputeEnvironment | undefined = (
      await engine.getComputeEnvironments()
    ).find((e) => e.id === job!.environment)
    if (!runEnv)
      return buildInvalidParametersResponse(
        buildInvalidRequestMessage(`Service environment "${job.environment}" not found`)
      )

    // Services capability gate (mirrors the start path → 403). features.services is mutable,
    // so an environment that no longer offers services must not have its services resumed.
    if (runEnv.features?.services === false)
      return {
        stream: null,
        status: { httpStatus: 403, error: 'Services are not enabled on this environment' }
      }

    // Access-list gate (mirrors paid compute → 403). Re-checked here because access
    // lists are mutable and restarting resumes use of the restricted environment.
    const accessGranted = await validateAccess(task.consumerAddress, runEnv.access, node)
    if (!accessGranted)
      return { stream: null, status: { httpStatus: 403, error: 'Access denied' } }

    // State check — cannot restart an expired service
    if (job.status === ServiceStatusNumber.Expired)
      return buildInvalidParametersResponse(
        buildInvalidRequestMessage('Cannot restart an expired service')
      )

    // If newUserData is provided it REPLACES the stored userData (must be the complete set).
    // Decrypt it as a validity check before touching the container.
    if (task.userData) {
      try {
        await decryptUserData(task.userData, node.getKeyManager())
      } catch {
        return buildInvalidParametersResponse(
          buildInvalidRequestMessage(
            'userData could not be decrypted — it must be ECIES-encrypted to the node public key'
          )
        )
      }
    }

    try {
      const restarted = await engine.restartService(
        task.serviceId,
        task.consumerAddress,
        task.userData,
        task.dockerCmd,
        task.dockerEntrypoint
      )
      return {
        stream: Readable.from(JSON.stringify([toPublicServiceJob(restarted)])),
        status: { httpStatus: 200 }
      }
    } catch (error: any) {
      CORE_LOGGER.error(`ServiceRestart ${task.serviceId} failed: ${error.message}`)
      return { stream: null, status: { httpStatus: 500, error: error.message } }
    }
  }
}
