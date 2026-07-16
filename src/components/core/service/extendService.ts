import { Readable } from 'stream'
import { P2PCommandResponse } from '../../../@types/index.js'
import { ServiceExtendCommand } from '../../../@types/commands.js'
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
import { findServiceJobAndEngine, toPublicServiceJob } from './utils.js'

export class ServiceExtendHandler extends CommandHandler {
  validate(command: ServiceExtendCommand): ValidateParams {
    const commandValidation = validateCommandParameters(command, [
      'consumerAddress',
      'serviceId',
      'additionalDuration',
      'payment'
    ])
    if (commandValidation.valid) {
      if (parseInt(String(command.additionalDuration)) <= 0)
        return buildInvalidRequestMessage('Invalid additionalDuration')
    }
    return commandValidation
  }

  async handle(task: ServiceExtendCommand): Promise<P2PCommandResponse> {
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

    // Ownership check
    if (job.owner.toLowerCase() !== task.consumerAddress.toLowerCase())
      return { stream: null, status: { httpStatus: 401, error: 'Not the service owner' } }

    // Resolve the environment the service actually runs on. This MUST exist: both the
    // access gate and pricing key off it. A missing env would otherwise let validateAccess
    // auto-allow (undefined access → true) and pricing fall back to an unrelated env.
    const runEnv: ComputeEnvironment | undefined = (
      await engine.getComputeEnvironments()
    ).find((e) => e.id === job!.environment)
    if (!runEnv)
      return buildInvalidParametersResponse(
        buildInvalidRequestMessage(`Service environment "${job.environment}" not found`)
      )

    // Access-list gate (mirrors paid compute → 403). Re-checked here because access
    // lists are mutable and extending prolongs use of the restricted environment.
    const accessGranted = await validateAccess(
      task.consumerAddress,
      runEnv.access,
      this.getOceanNode()
    )
    if (!accessGranted)
      return { stream: null, status: { httpStatus: 403, error: 'Access denied' } }

    // Everything from the state check to the final write runs under the per-service
    // lifecycle lock: extend is a read-mutate-write of the job row, and without the lock
    // its final updateServiceJob could overwrite a concurrent stop/restart/Expired state
    // (and the expiry sweep could tear the service down between our payment and write).
    // The lock is taken BEFORE any escrow operation, so a busy lock costs nothing.
    try {
      return await engine.runExclusive(
        task.serviceId,
        async (): Promise<P2PCommandResponse> => {
          // Re-read under the lock — every other mutator holds the same lock, so this
          // snapshot cannot go stale before our write.
          const [freshJob] = await engine.db.getServiceJob(
            task.serviceId,
            task.consumerAddress
          )
          if (!freshJob)
            return buildInvalidParametersResponse(
              buildInvalidRequestMessage('Service job not found: ' + task.serviceId)
            )

          // State check — only Starting or Running can be extended
          if (
            freshJob.status !== ServiceStatusNumber.Starting &&
            freshJob.status !== ServiceStatusNumber.Running
          )
            return buildInvalidParametersResponse(
              buildInvalidRequestMessage(
                `Cannot extend a service in state "${freshJob.statusText}". Only Starting or Running services can be extended.`
              )
            )

          // Extension must not push total beyond maxDurationSeconds
          const sod = engine.getC2DConfig().connection?.serviceOnDemand
          const maxDuration = sod?.maxDurationSeconds ?? 86400
          const remainingSeconds = Math.max(
            0,
            Math.floor((freshJob.expiresAt - Date.now()) / 1000)
          )
          const newTotalDuration = remainingSeconds + task.additionalDuration
          if (newTotalDuration > maxDuration)
            return buildInvalidParametersResponse(
              buildInvalidRequestMessage(
                `Extension would result in ${newTotalDuration}s remaining, exceeding maximum ${maxDuration}s`
              )
            )

          // Cost — same price formula as the start, priced off the env the service runs
          // on. No fallback: pricing must use runEnv (resolved above);
          // calculateResourcesCost returns null if that env has no pricing for the token.
          const costExtend = engine.calculateResourcesCost(
            freshJob.resources.map((r) => ({ id: r.id, amount: r.amount })),
            runEnv,
            task.payment.chainId,
            task.payment.token,
            task.additionalDuration
          )
          if (costExtend === null)
            return buildInvalidParametersResponse(
              buildInvalidRequestMessage(
                `No pricing configured for token ${task.payment.token} on chain ${task.payment.chainId}`
              )
            )

          // Escrow lock + immediate claim
          let lockTx: string | null
          try {
            lockTx = await engine.escrow.createLock(
              task.payment.chainId,
              task.serviceId,
              task.payment.token,
              task.consumerAddress,
              costExtend,
              engine.escrow.getMinLockTime(task.additionalDuration)
            )
          } catch (e: any) {
            CORE_LOGGER.error(`Service extend createLock failed: ${e.message}`)
            return { stream: null, status: { httpStatus: 402, error: e.message } }
          }
          if (!lockTx)
            return {
              stream: null,
              status: { httpStatus: 402, error: 'Escrow lock failed for extend' }
            }

          // Wait for the lock tx to be mined before claiming (same-signer back-to-back txs).
          try {
            await engine.escrow.waitForTransaction(task.payment.chainId, lockTx)
          } catch (e: any) {
            CORE_LOGGER.error(`Service extend lock not confirmed: ${e.message}`)
            await engine.escrow
              .cancelExpiredLock(
                task.payment.chainId,
                task.serviceId,
                task.payment.token,
                task.consumerAddress
              )
              .catch((err) =>
                CORE_LOGGER.error(`cancelExpiredLock failed: ${err.message}`)
              )
            return {
              stream: null,
              status: {
                httpStatus: 402,
                error: 'Escrow lock not confirmed — lock cancelled'
              }
            }
          }

          let claimTx: string | null
          try {
            claimTx = await engine.escrow.claimLock(
              task.payment.chainId,
              task.serviceId,
              task.payment.token,
              task.consumerAddress,
              costExtend,
              `service-extend:${task.serviceId}`
            )
          } catch (e: any) {
            claimTx = null
            CORE_LOGGER.error(`Service extend claimLock failed: ${e.message}`)
          }
          if (!claimTx) {
            await engine.escrow
              .cancelExpiredLock(
                task.payment.chainId,
                task.serviceId,
                task.payment.token,
                task.consumerAddress
              )
              .catch((e) => CORE_LOGGER.error(`cancelExpiredLock failed: ${e.message}`))
            return {
              stream: null,
              status: { httpStatus: 402, error: 'Escrow claim failed — lock cancelled' }
            }
          }

          // Payment successful — push expiresAt forward and record extension payment
          freshJob.expiresAt += task.additionalDuration * 1000
          freshJob.duration += task.additionalDuration
          freshJob.extendPayments = [
            ...(freshJob.extendPayments ?? []),
            {
              chainId: task.payment.chainId,
              token: task.payment.token,
              lockTx,
              claimTx,
              cancelTx: '',
              cost: costExtend
            }
          ]
          await engine.db.updateServiceJob(freshJob)

          CORE_LOGGER.logMessage(
            `Service ${task.serviceId} extended by ${task.additionalDuration}s, new expiresAt: ${freshJob.expiresAt}`,
            true
          )
          return {
            stream: Readable.from(JSON.stringify([toPublicServiceJob(freshJob)])),
            status: { httpStatus: 200 }
          }
        }
      )
    } catch (error: any) {
      // Lifecycle lock busy (a stop/restart/expiry owns the service) or engine stopped —
      // nothing was charged yet, the client simply retries shortly.
      CORE_LOGGER.error(`ServiceExtend ${task.serviceId} rejected: ${error.message}`)
      return { stream: null, status: { httpStatus: 400, error: error.message } }
    }
  }
}
