import { Readable } from 'stream'
import { P2PCommandResponse } from '../../../@types/index.js'
import { ServiceStartCommand } from '../../../@types/commands.js'
import { CommandHandler } from '../handler/handler.js'
import {
  ValidateParams,
  validateCommandParameters,
  buildInvalidParametersResponse,
  buildInvalidRequestMessage
} from '../../httpRoutes/validateCommands.js'
import { CORE_LOGGER } from '../../../utils/logging/common.js'
import { isAddress } from 'ethers'
import type { C2DEngine } from '../../c2d/compute_engine_base.js'
import type {
  ComputeEnvironment,
  DBComputeJobPayment as Payment
} from '../../../@types/C2D/C2D.js'
import { generateUniqueID } from '../compute/utils.js'
import { validateAccess } from '../compute/startCompute.js'
import { decryptUserData, toPublicServiceJob } from './utils.js'

export class ServiceStartHandler extends CommandHandler {
  validate(command: ServiceStartCommand): ValidateParams {
    const commandValidation = validateCommandParameters(command, [
      'consumerAddress',
      'environment',
      'image',
      'duration',
      'payment'
    ])
    if (commandValidation.valid) {
      if (!isAddress(command.consumerAddress))
        return buildInvalidRequestMessage(
          'Parameter : "consumerAddress" is not a valid web3 address'
        )
      if (parseInt(String(command.duration)) <= 0)
        return buildInvalidRequestMessage('Invalid duration')
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

  async handle(task: ServiceStartCommand): Promise<P2PCommandResponse> {
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

    try {
      // 1. Resolve engine + environment (environment is mandatory)
      let engine: C2DEngine
      try {
        engine = await engines.getC2DByEnvId(task.environment)
      } catch {
        return buildInvalidParametersResponse(
          buildInvalidRequestMessage(`Unknown environment "${task.environment}"`)
        )
      }
      const env: ComputeEnvironment | undefined = (
        await engine.getComputeEnvironments()
      ).find((e) => e.id === task.environment)
      if (!env)
        return buildInvalidParametersResponse(
          buildInvalidRequestMessage(`Unknown environment "${task.environment}"`)
        )

      // 1a. Services capability gate (mirrors compute F4/F5 gates → 403)
      if (env.features?.services === false)
        return {
          stream: null,
          status: {
            httpStatus: 403,
            error: 'Services are not enabled on this environment'
          }
        }

      // 1b. Access-list gate (mirrors paid compute → 403). The signature only proves
      //     control of consumerAddress, not allowlist membership, so this must be
      //     enforced here before any escrow/charge logic.
      const accessGranted = await validateAccess(task.consumerAddress, env.access, node)
      if (!accessGranted)
        return {
          stream: null,
          status: {
            httpStatus: 403,
            error: 'Access denied'
          }
        }

      // 2. Decrypt userData (pre-escrow validity check, so undecryptable input isn't charged).
      //    The decrypted object becomes the container's env-var map inside the engine.
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

      // 4. Duration limit
      const sod = engine.getC2DConfig().connection?.serviceOnDemand
      const maxDuration = sod?.maxDurationSeconds ?? 86400
      if (task.duration > maxDuration)
        return buildInvalidParametersResponse(
          buildInvalidRequestMessage(
            `Duration ${task.duration}s exceeds maximum ${maxDuration}s`
          )
        )

      // 5. Resolve resources (fill cpu/ram/disk defaults the same way compute jobs do)
      let resources
      try {
        resources = await engine.checkAndFillMissingResources(
          task.resources ?? [],
          env,
          false
        )
        await engine.checkIfResourcesAreAvailable(
          resources,
          env,
          false,
          await engine.getComputeEnvironments()
        )
      } catch (e: any) {
        return buildInvalidParametersResponse(
          buildInvalidRequestMessage(e?.message || String(e))
        )
      }

      // 6. Server-side cost (used to size the escrow lock the background loop will create).
      const cost = engine.calculateResourcesCost(
        resources,
        env,
        task.payment.chainId,
        task.payment.token,
        task.duration
      )
      if (cost === null)
        return buildInvalidParametersResponse(
          buildInvalidRequestMessage(
            `No pricing configured for token ${task.payment.token} on chain ${task.payment.chainId}`
          )
        )

      const serviceId = generateUniqueID({
        owner: task.consumerAddress,
        environment: task.environment,
        image: task.image,
        duration: task.duration,
        nonce: task.nonce
      })

      // Escrow tx hashes are filled in later by the background pipeline (locking → payment).
      const payment: Payment = {
        chainId: task.payment.chainId,
        token: task.payment.token,
        lockTx: '',
        claimTx: '',
        cancelTx: '',
        cost
      }

      // 7. Persist the Starting record and return immediately with the serviceId. The
      //    engine's background loop (processServiceStart) then performs escrow lock → image
      //    pull/build → claim/cancel → container start. Clients poll SERVICE_GET_STATUS to
      //    watch the service progress to Running (or a *Failed / Error terminal status).
      const job = await engine.createServiceJob(
        task.environment,
        task.image,
        task.tag,
        task.checksum,
        task.dockerfile,
        task.additionalDockerFiles,
        task.dockerCmd,
        task.dockerEntrypoint,
        task.exposedPorts ?? [],
        resources,
        task.duration,
        task.consumerAddress,
        payment,
        serviceId,
        task.userData
      )

      return {
        stream: Readable.from(JSON.stringify([toPublicServiceJob(job)])),
        status: { httpStatus: 200 }
      }
    } catch (error: any) {
      CORE_LOGGER.error(`ServiceStart failed: ${error.message}`)
      return { stream: null, status: { httpStatus: 500, error: error.message } }
    }
  }
}
