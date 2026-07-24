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
import type { ComputeEnvironment } from '../../../@types/C2D/C2D.js'
import { ServiceStatusNumber } from '../../../@types/C2D/ServiceOnDemand.js'
import { validateAccess } from '../compute/startCompute.js'
import { decryptUserData, findServiceJobAndEngine, toPublicServiceJob } from './utils.js'

export class ServiceRestartHandler extends CommandHandler {
  validate(command: ServiceRestartCommand): ValidateParams {
    const commandValidation = validateCommandParameters(command, [
      'consumerAddress',
      'serviceId'
    ])
    if (!commandValidation.valid) return commandValidation
    // Any container param present ⇒ RESPEC mode (the container is rebuilt entirely from
    // this request). In that mode `image` is mandatory — this is the discriminator that
    // makes a partial change impossible: you cannot send a new userData/dockerCmd on top
    // of the stored image, you must re-supply the whole spec. When no container param is
    // present the service restarts on its stored spec (REUSE mode) and no image is needed.
    const respec =
      command.image !== undefined ||
      command.tag !== undefined ||
      command.checksum !== undefined ||
      command.dockerfile !== undefined ||
      command.additionalDockerFiles !== undefined ||
      command.userData !== undefined ||
      command.dockerCmd !== undefined ||
      command.dockerEntrypoint !== undefined
    if (respec) {
      if (!command.image)
        return buildInvalidRequestMessage(
          'Restarting with new parameters requires "image": send the full container spec, ' +
            'not a partial change (restart is all-old or all-new)'
        )
      const imageModes = [command.tag, command.checksum, command.dockerfile].filter(
        Boolean
      ).length
      if (imageModes > 1)
        return buildInvalidRequestMessage(
          'Provide at most one of "tag", "checksum", "dockerfile"'
        )
    }
    return commandValidation
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

    // RESPEC mode with a Dockerfile: fast-fail if this daemon forbids image builds, so the
    // caller gets an immediate 403 instead of an async BuildImage failure. The engine's
    // doRestartService re-checks this as the authoritative backstop.
    if (task.dockerfile) {
      const sod = engine.getC2DConfig().connection?.serviceOnDemand
      if (!sod?.allowImageBuild)
        return {
          stream: null,
          status: {
            httpStatus: 403,
            error:
              'Dockerfile-based services are not allowed on this environment (allowImageBuild=false)'
          }
        }
    }

    // In RESPEC mode userData (if sent) becomes the new container env — decrypt it as a
    // validity check before touching the container. In REUSE mode task.userData is absent
    // and the stored userData is reused untouched.
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
      // Asynchronous, like SERVICE_START: engine.restartService validates, persists the
      // job as Restarting and returns immediately — the teardown + image pull/build +
      // new container run in the background (an image pull can take minutes and must
      // not block the HTTP/P2P response). Clients poll SERVICE_GET_STATUS and watch
      // Restarting → … → Running (or an Error status with the failure reason).
      const restarted = await engine.restartService(
        task.serviceId,
        task.consumerAddress,
        task.image,
        task.tag,
        task.checksum,
        task.dockerfile,
        task.additionalDockerFiles,
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
