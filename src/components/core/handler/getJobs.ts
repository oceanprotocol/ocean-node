import { Readable } from 'stream'
import { GetJobsCommand } from '../../../@types/commands.js'
import { CORE_LOGGER } from '../../../utils/logging/common.js'
import { buildInvalidRequestMessage } from '../../httpRoutes/validateCommands.js'
import { CommandHandler } from './handler.js'
import { P2PCommandResponse } from '../../../@types/OceanNode.js'
import { parseFromTimestampSeconds } from '../utils/timestamps.js'

export class GetJobsHandler extends CommandHandler {
  validate(command: GetJobsCommand) {
    // absent / empty means "no filter", as before
    if (command.fromTimestamp) {
      if (typeof command.fromTimestamp !== 'string') {
        return buildInvalidRequestMessage(
          'Parameter : "fromTimestamp" is not a valid string'
        )
      }
      // Reject unparseable values instead of passing them to SQL, where they used to match
      // nothing and return 200 + [] — indistinguishable from "no jobs in that window".
      if (!Number.isFinite(parseFromTimestampSeconds(command.fromTimestamp))) {
        return buildInvalidRequestMessage(
          `Parameter "fromTimestamp" is not a valid date: "${command.fromTimestamp}" — use an ISO date or a Unix timestamp`
        )
      }
    }
    return { valid: true }
  }

  async handle(task: GetJobsCommand): Promise<P2PCommandResponse> {
    const validationResponse = await this.verifyParamsAndRateLimits(task)
    if (this.shouldDenyTaskHandling(validationResponse)) {
      return validationResponse
    }

    try {
      const { c2d } = await this.getOceanNode().getDatabase()
      if (!c2d) {
        throw new Error('C2D database not initialized')
      }

      // The DB columns store decimal seconds; validate() has already rejected anything
      // unparseable, so this is either a finite seconds value or undefined (no filter).
      const fromTimestamp = task.fromTimestamp
        ? parseFromTimestampSeconds(task.fromTimestamp)
        : undefined
      const jobs = await c2d.getJobs(
        task.environments,
        fromTimestamp ?? undefined,
        task.consumerAddrs,
        undefined,
        task.runningJobs
      )
      const sanitizedJobs = jobs.map((job) => {
        if (job.algorithm) {
          const { envs, meta, ...restAlgo } = job.algorithm
          const sanitizedAlgo = meta
            ? { ...restAlgo, meta: (({ rawcode, ...restMeta }) => restMeta)(meta) }
            : restAlgo
          return { ...job, algorithm: sanitizedAlgo }
        }
        return job
      })
      return {
        stream: Readable.from(JSON.stringify(sanitizedJobs)),
        status: {
          httpStatus: 200,
          error: null
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      CORE_LOGGER.error('Error retrieving node jobs: ' + message)
      return {
        status: {
          httpStatus: 500,
          error: message
        },
        stream: null
      }
    }
  }
}
