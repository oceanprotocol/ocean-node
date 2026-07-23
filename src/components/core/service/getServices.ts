import { Readable } from 'stream'
import { P2PCommandResponse } from '../../../@types/index.js'
import { GetServicesCommand } from '../../../@types/commands.js'
import { CommandHandler } from '../handler/handler.js'
import {
  ValidateParams,
  validateCommandParameters,
  buildInvalidRequestMessage
} from '../../httpRoutes/validateCommands.js'
import {
  ServiceStatusNumber,
  type ServiceJob
} from '../../../@types/C2D/ServiceOnDemand.js'
import { toListedServiceJob } from './utils.js'

// Parses the `fromTimestamp` filter into Unix milliseconds. Accepts an ISO date string
// or a Unix timestamp (seconds or milliseconds) given as a string / number-like string.
// Returns undefined for "no filter" and null for an unparseable value (caller → 400).
export function parseFromTimestamp(value?: string): number | undefined | null {
  if (value === undefined || value === null || value === '') return undefined
  if (/^\d+$/.test(String(value))) {
    const n = Number(value)
    // 1e12 ms ≈ Sep 2001; any plausible seconds value is far below it
    return n > 1e12 ? n : n * 1000
  }
  const t = Date.parse(String(value))
  return Number.isNaN(t) ? null : t
}

// SERVICE_LIST: the node-wide service listing, shaped like GetJobsHandler. Default (no
// filters) returns exactly what the engines count against the shared resource pools
// (getRunningServiceJobs): Running/Restarting/Stopping, the mid-start pipeline states,
// paid Error (container died, restartable), and explicitly Stopped (reservation kept
// until expiresAt). `status` narrows to ONE specific status (any, incl. Expired);
// `includeAllStatuses` returns everything; `fromTimestamp` keeps only services created
// at/after that moment. Unlike SERVICE_GET_STATUS this is NOT owner-scoped: any
// authenticated caller sees every consumer's services, so the output is listing-grade
// sanitized (no userData, no CMD/ENTRYPOINT overrides, no Dockerfile).
export class GetServicesHandler extends CommandHandler {
  validate(command: GetServicesCommand): ValidateParams {
    // consumerAddress is required: it is the identity the signature/token is verified
    // against (same contract as the other service commands).
    const validation = validateCommandParameters(command, ['consumerAddress'])
    if (!validation.valid) return validation
    if (
      command.status !== undefined &&
      ServiceStatusNumber[command.status] === undefined
    ) {
      return buildInvalidRequestMessage(
        `Parameter "status" is not a valid service status number: ${command.status}`
      )
    }
    if (command.fromTimestamp !== undefined) {
      if (typeof command.fromTimestamp !== 'string')
        return buildInvalidRequestMessage(
          'Parameter "fromTimestamp" is not a valid string'
        )
      if (!Number.isFinite(parseFromTimestamp(command.fromTimestamp)))
        return buildInvalidRequestMessage(
          `Parameter "fromTimestamp" is not a valid date: "${command.fromTimestamp}" — use an ISO date or a Unix timestamp`
        )
    }
    if (command.updatedSince !== undefined) {
      if (typeof command.updatedSince !== 'string')
        return buildInvalidRequestMessage(
          'Parameter "updatedSince" is not a valid string'
        )
      if (!Number.isFinite(parseFromTimestamp(command.updatedSince)))
        return buildInvalidRequestMessage(
          `Parameter "updatedSince" is not a valid date: "${command.updatedSince}" — use an ISO date or a Unix timestamp`
        )
    }
    return validation
  }

  async handle(task: GetServicesCommand): Promise<P2PCommandResponse> {
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

    const jobs: ServiceJob[] = []
    for (const eng of engines.getAllEngines()) {
      const { hash } = eng.getC2DConfig()
      if (
        task.updatedSince !== undefined ||
        task.status !== undefined ||
        task.includeAllStatuses
      ) {
        const all = (await eng.db.getServiceJob()).filter(
          (j: ServiceJob) => j.clusterHash === hash
        )
        jobs.push(
          ...(task.status !== undefined
            ? all.filter((j: ServiceJob) => j.status === task.status)
            : all)
        )
      } else {
        // default: the cluster's resource-holding set
        jobs.push(...(await eng.db.getRunningServiceJobs(hash)))
      }
    }

    const fromMs = parseFromTimestamp(task.fromTimestamp)
    const updatedSinceMs = parseFromTimestamp(task.updatedSince)
    const filtered = jobs.filter(
      (j) =>
        (fromMs === undefined || fromMs === null
          ? true
          : Date.parse(j.dateCreated) >= fromMs) &&
        (updatedSinceMs === undefined || updatedSinceMs === null
          ? true
          : (j.updatedAt ?? 0) >= updatedSinceMs)
    )

    return {
      stream: Readable.from(JSON.stringify(filtered.map(toListedServiceJob))),
      status: { httpStatus: 200 }
    }
  }
}
