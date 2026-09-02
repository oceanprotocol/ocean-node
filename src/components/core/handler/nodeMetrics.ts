import { CommandHandler } from './handler.js'
import { P2PCommandResponse } from '../../../@types/OceanNode.js'
import {
  GetNodeMetricsCommand,
  GetNodeMetricsHistoryCommand
} from '../../../@types/commands.js'
import { Readable } from 'stream'
import {
  ValidateParams,
  validateCommandParameters
} from '../../httpRoutes/validateCommands.js'
import { CORE_LOGGER } from '../../../utils/logging/common.js'
import { collectNodeMetricsSnapshot } from '../utils/nodeMetricsHandler.js'
import { NodeMetricsHistoryResult } from '../../../@types/nodeMetrics.js'
import {
  getMetricsRetentionDays,
  isNodeMetricsHistoryEnabled
} from '../../../utils/nodeMetricsConfig.js'
import { floorToHour } from '../../database/sqliteNodeMetrics.js'

const HOUR_MS = 60 * 60 * 1000
// Hard ceiling on returned buckets, independent of the range asked for. 180 days of hourly rows
// is 4320; keeping some headroom above the retention window bounds a single response.
const MAX_HISTORY_ROWS = 10000

export class GetNodeMetricsHandler extends CommandHandler {
  validate(command: GetNodeMetricsCommand): ValidateParams {
    return validateCommandParameters(command, [])
  }

  async handle(task: GetNodeMetricsCommand): Promise<P2PCommandResponse> {
    const checks = await this.verifyParamsAndRateLimits(task)
    if (checks.status.httpStatus !== 200 || checks.status.error !== null) {
      return checks
    }
    try {
      // The live snapshot is returned regardless of freshness: a caller wants to see current
      // state, genuine zeros included. `hasAggregate` on the payload tells them whether the
      // compute aggregate was populated.
      const snapshot = collectNodeMetricsSnapshot(this.getOceanNode())
      return {
        stream: Readable.from(JSON.stringify(snapshot)),
        status: { httpStatus: 200 }
      }
    } catch (error) {
      CORE_LOGGER.error(`Error in GetNodeMetricsHandler: ${error.message}`)
      return {
        stream: null,
        status: { httpStatus: 500, error: 'Unknown error: ' + error.message }
      }
    }
  }
}

// Accept epoch ms (number or numeric string) or an ISO-8601 date string. Returns undefined when
// the input is absent or unparseable.
function parseTimeParam(value: number | string | undefined): number | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  const trimmed = String(value).trim()
  if (trimmed === '') return undefined
  // A pure-integer string is epoch milliseconds, but ONLY when it is long enough to actually be
  // a ms timestamp (>= 12 digits ≈ year 2001+). A short integer like "2024" is a partial ISO
  // year, not 2024 ms since the epoch, so it must fall through to Date.parse rather than be
  // silently read as 1970 (which would then return an empty history instead of a real range).
  if (/^\d+$/.test(trimmed)) {
    if (trimmed.length >= 12) {
      const asNumber = Number(trimmed)
      return Number.isFinite(asNumber) ? asNumber : undefined
    }
    // else: short integer — treat as a calendar year via Date.parse below.
  }
  const asDate = Date.parse(trimmed)
  return Number.isNaN(asDate) ? undefined : asDate
}

export class GetNodeMetricsHistoryHandler extends CommandHandler {
  validate(command: GetNodeMetricsHistoryCommand): ValidateParams {
    return validateCommandParameters(command, [])
  }

  async handle(task: GetNodeMetricsHistoryCommand): Promise<P2PCommandResponse> {
    const checks = await this.verifyParamsAndRateLimits(task)
    if (checks.status.httpStatus !== 200 || checks.status.error !== null) {
      return checks
    }
    try {
      // The DB table is created regardless of the flag (and may hold rows from a period when the
      // feature was on), so gate reads on the flag too — otherwise disabling it would only stop
      // new roll-ups while still serving previously accumulated history.
      const db = await this.getOceanNode().getDatabase()
      if (!isNodeMetricsHistoryEnabled() || !db || !db.nodeMetrics) {
        return {
          stream: null,
          status: {
            httpStatus: 503,
            error: 'Node metrics history is not available on this node'
          }
        }
      }

      const now = Date.now()
      const retentionMs = getMetricsRetentionDays() * 24 * HOUR_MS
      const earliest = now - retentionMs

      let start = parseTimeParam(task.startTime)
      let stop = parseTimeParam(task.stopTime)

      if (task.startTime !== undefined && start === undefined) {
        return {
          stream: null,
          status: { httpStatus: 400, error: 'Invalid startTime' }
        }
      }
      if (task.stopTime !== undefined && stop === undefined) {
        return {
          stream: null,
          status: { httpStatus: 400, error: 'Invalid stopTime' }
        }
      }

      // Defaults: last retention window → now.
      if (stop === undefined) stop = now
      if (start === undefined) start = earliest

      if (start >= stop) {
        return {
          stream: null,
          status: { httpStatus: 400, error: 'startTime must be earlier than stopTime' }
        }
      }

      // Clamp to what we could possibly hold, then cap the row count.
      start = Math.max(start, earliest)
      stop = Math.min(stop, now)
      // A window that lies entirely before the retention horizon clamps `start` up to `earliest`
      // while `stop` stays below it, inverting the interval. Keep it ordered so the echoed range is
      // coherent and getHourly returns an empty (not malformed) result.
      if (start > stop) start = stop

      const buckets = db.nodeMetrics.getHourly(start, stop, MAX_HISTORY_ROWS)

      // Append the live, not-yet-rolled-up current hour (averaged from raw samples) when it falls
      // in range and the roll-up has not already stored it. Lets a caller see fresh data without
      // waiting for the top-of-hour roll-up; it is flagged `partial: true`.
      const currentHour = floorToHour(now)
      const alreadyStored =
        buckets.length > 0 && buckets[buckets.length - 1].hourStart === currentHour
      if (
        !alreadyStored &&
        currentHour >= start &&
        currentHour <= stop &&
        buckets.length < MAX_HISTORY_ROWS
      ) {
        const partial = db.nodeMetrics.getPartialHour(currentHour)
        if (partial) buckets.push(partial)
      }

      const result: NodeMetricsHistoryResult = {
        startTime: start,
        stopTime: stop,
        count: buckets.length,
        buckets
      }
      return {
        stream: Readable.from(JSON.stringify(result)),
        status: { httpStatus: 200 }
      }
    } catch (error) {
      CORE_LOGGER.error(`Error in GetNodeMetricsHistoryHandler: ${error.message}`)
      return {
        stream: null,
        status: { httpStatus: 500, error: 'Unknown error: ' + error.message }
      }
    }
  }
}
