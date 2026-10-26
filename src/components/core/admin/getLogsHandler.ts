import { AdminCommandHandler } from './adminHandler.js'
import { AdminGetLogsCommand } from '../../../@types/commands.js'
import { P2PCommandResponse } from '../../../@types/OceanNode.js'
import {
  ValidateParams,
  buildInvalidParametersResponse,
  buildInvalidRequestMessage
} from '../../httpRoutes/validateCommands.js'
import { ReadableString } from '../../P2P/handleProtocolCommands.js'
import { readLogFiles } from '../../../utils/logging/logFiles.js'
import { USE_DB_TRANSPORT, getLogsDir } from '../../../utils/logging/Logger.js'
import { CORE_LOGGER } from '../../../utils/logging/common.js'
import { errorSummary } from '../../../utils/logging/redact.js'
import type { Database } from '../../database/index.js'

const DEFAULT_LOGS_WINDOW_MS = 7 * 24 * 60 * 60 * 1000
const DEFAULT_MAX_LOGS = 100
const MAX_LOGS = 1000

// ISO date or epoch milliseconds (ocean-cli sends epoch-ms strings); null if invalid
export function parseLogsTime(value: unknown, fallback: Date): Date | null {
  if (value === undefined || value === null || value === '') return fallback
  let date: Date
  if (typeof value === 'number') {
    date = new Date(value)
  } else if (typeof value === 'string') {
    const text = value.trim()
    date = /^\d+$/.test(text) ? new Date(Number(text)) : new Date(text)
  } else {
    return null
  }
  return Number.isFinite(date.getTime()) ? date : null
}

// finite: clamped to 0..1000, otherwise 100
export function parseMaxLogs(value: unknown): number {
  const maxLogs = value === undefined || value === null ? NaN : Number(value)
  if (!Number.isFinite(maxLogs)) return DEFAULT_MAX_LOGS
  return Math.min(Math.max(Math.floor(maxLogs), 0), MAX_LOGS)
}

export function parseLogsPage(value: unknown): number | undefined {
  const page = value === undefined || value === null ? NaN : Number(value)
  return Number.isFinite(page) ? Math.floor(page) : undefined
}

function jsonResponse(body: unknown): P2PCommandResponse {
  return {
    status: { httpStatus: 200 },
    stream: new ReadableString(JSON.stringify(body))
  }
}

export class GetLogsHandler extends AdminCommandHandler {
  async validate(command: AdminGetLogsCommand): Promise<ValidateParams> {
    return await super.validate(command)
  }

  async handle(task: AdminGetLogsCommand): Promise<P2PCommandResponse> {
    const validation = await this.validate(task)
    if (!validation.valid) {
      return buildInvalidParametersResponse(validation)
    }
    try {
      // getDatabase() resolves to undefined without DB_URL and rejects if init failed
      let db: Database | null
      try {
        db = await this.getOceanNode().getDatabase()
      } catch {
        db = null
      }
      // the DB is only the log source while logs are written to it
      const dbLogs = USE_DB_TRANSPORT() && db?.logs ? db.logs : null

      if (task.logId) {
        // the error text has to be on `status` as well as in the stream: a non-200
        // response body is not forwarded over P2P, and the /directCommand route falls
        // back to `response.status.error`, so without this the client gets a 404 with an
        // empty body.
        if (!dbLogs) {
          const error = 'Log lookup by id requires LOG_DB and a log database'
          return {
            status: { httpStatus: 404, error },
            stream: new ReadableString(error)
          }
        }
        const log = await dbLogs.retrieveLog(task.logId)
        if (log) {
          return jsonResponse(log)
        }
        return {
          status: { httpStatus: 404, error: 'Log not found' },
          stream: new ReadableString('Log not found')
        }
      }

      const endTime = parseLogsTime(task.endTime, new Date())
      if (!endTime) {
        return buildInvalidParametersResponse(
          buildInvalidRequestMessage('Invalid endTime: expected an ISO date or epoch ms')
        )
      }
      const startTime = parseLogsTime(
        task.startTime,
        new Date(Date.now() - DEFAULT_LOGS_WINDOW_MS)
      )
      if (!startTime) {
        return buildInvalidParametersResponse(
          buildInvalidRequestMessage(
            'Invalid startTime: expected an ISO date or epoch ms'
          )
        )
      }
      const maxLogs = parseMaxLogs(task.maxLogs)
      const page = parseLogsPage(task.page)
      const { moduleName, level } = task
      // P2P commands are arbitrary JSON: the HTTP route already coerces these to strings
      for (const [name, value] of Object.entries({ moduleName, level })) {
        if (value !== undefined && value !== null && typeof value !== 'string') {
          return buildInvalidParametersResponse(
            buildInvalidRequestMessage(`Invalid ${name}: expected a string`)
          )
        }
      }

      if (dbLogs) {
        try {
          const logs = await dbLogs.retrieveMultipleLogs(
            startTime,
            endTime,
            maxLogs,
            moduleName,
            level,
            page
          )
          if (logs?.length) return jsonResponse(logs)
          if (page > 1) return jsonResponse([])
        } catch (error) {
          // the logger falls back to files when the DB is unusable: read them instead
          CORE_LOGGER.throttled(
            'get-logs-db',
            'error',
            `Reading logs from the database failed, using log files: ${errorSummary(error)}`
          )
        }
      }

      const fileLogs = await readLogFiles({
        startTime,
        endTime,
        maxLogs,
        moduleName,
        level,
        page,
        dir: getLogsDir()
      })
      return jsonResponse(fileLogs)
    } catch (error) {
      CORE_LOGGER.error(`Retrieving logs failed: ${errorSummary(error)}`)
      return {
        status: {
          httpStatus: 500,
          error: `Error retrieving logs: ${errorSummary(error)}`
        },
        stream: null
      }
    }
  }
}
