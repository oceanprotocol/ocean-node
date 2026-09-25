import { Readable } from 'stream'
import { P2PCommandResponse } from '../../../@types/index.js'
import { ServiceGetStatusCommand } from '../../../@types/commands.js'
import { CommandHandler } from '../handler/handler.js'
import {
  ValidateParams,
  validateCommandParameters
} from '../../httpRoutes/validateCommands.js'
import type {
  ServiceJob,
  ServiceOutputBucketUsage
} from '../../../@types/C2D/ServiceOnDemand.js'
import type { PersistentStorageFactory } from '../../persistentStorage/PersistentStorageFactory.js'
import { CORE_LOGGER } from '../../../utils/logging/common.js'
import { toPublicServiceJob } from './utils.js'

// Sizing a bucket walks its folder, and clients poll status every few seconds, so a
// reading may be this old. Uploads and deletes through the storage API refresh it.
const BUCKET_USAGE_MAX_AGE_MS = 30_000

// Best-effort: a bucket that is gone or can't be sized just leaves the field off.
async function getOutputBucketUsage(
  storage: PersistentStorageFactory | null,
  job: ServiceJob
): Promise<ServiceOutputBucketUsage | undefined> {
  if (!storage || !job.outputBucketId) return undefined
  try {
    const usage = await storage.getBucketQuotaUsage(
      job.outputBucketId,
      BUCKET_USAGE_MAX_AGE_MS
    )
    if (!usage) return undefined
    return { ...usage, full: usage.usedBytes >= usage.quotaBytes }
  } catch (e: any) {
    CORE_LOGGER.debug(
      `Service ${job.serviceId}: could not size bucket ${job.outputBucketId}: ${e.message}`
    )
    return undefined
  }
}

export class ServiceGetStatusHandler extends CommandHandler {
  validate(command: ServiceGetStatusCommand): ValidateParams {
    // consumerAddress is required: it is the owner scope AND the identity the
    // signature/token is verified against.
    return validateCommandParameters(command, ['consumerAddress'])
  }

  async handle(task: ServiceGetStatusCommand): Promise<P2PCommandResponse> {
    const validationResponse = await this.verifyParamsAndRateLimits(task)
    if (this.shouldDenyTaskHandling(validationResponse)) return validationResponse

    // Status exposes live endpoint URLs / payment data, so the caller must prove
    // control of consumerAddress; results are then scoped to that owner.
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

    // Aggregate across engines; each engine returns only its own cluster's jobs,
    // and the query ANDs owner + serviceId so only the authenticated owner's jobs match.
    const jobs: ServiceJob[] = []
    for (const eng of engines.getAllEngines()) {
      jobs.push(...(await eng.getServiceStatus(task.consumerAddress, task.serviceId)))
    }

    // Ownership is already proven above (this command is always authenticated), so runtime
    // metrics are included BY DEFAULT here — only an explicit includeMetrics=false opts out.
    const storage = this.getOceanNode().getPersistentStorage()
    const out = await Promise.all(
      jobs.map(async (job) => {
        const pub = toPublicServiceJob(job, {
          includeMetrics: task.includeMetrics !== false
        })
        const outputBucketUsage = await getOutputBucketUsage(storage, job)
        return outputBucketUsage ? { ...pub, outputBucketUsage } : pub
      })
    )
    return {
      stream: Readable.from(JSON.stringify(out)),
      status: { httpStatus: 200 }
    }
  }
}
