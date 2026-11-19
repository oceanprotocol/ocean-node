import { randomUUID } from 'node:crypto'
import type { OceanNodeDBConfig } from '../../../@types/OceanNode.js'
import { DATABASE_LOGGER } from '../../../utils/logging/common.js'
import { LOG_LEVELS_STR } from '../../../utils/logging/Logger.js'
import { AbstractLogDatabase } from '../BaseDatabase.js'
import { Conditions, SqlClient, insertRow } from './SqlClient.js'

const LOG_INSERT_FAILED_KEY = 'sql-log-insert-failed'
// the largest page of logs
const PAGE_SIZE = 250

type LogRow = { id: string; doc: string }

const toLog = (row: LogRow): Record<string, any> => ({
  ...JSON.parse(row.doc),
  id: row.id
})

// The log lines of the node (LOG_DB). "timestamp" is an ISO date, which sorts as text.
// The module and the level have columns: the log API filters on them.
export class SqlLogDatabase extends AbstractLogDatabase {
  constructor(
    config: OceanNodeDBConfig,
    private db: SqlClient
  ) {
    super(config)
  }

  init(): Promise<void> {
    return this.db.exec(`
      CREATE TABLE IF NOT EXISTS logs (
        "id" TEXT PRIMARY KEY, "timestamp" TEXT NOT NULL, "moduleName" TEXT, "level" TEXT,
        "doc" TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS logs_timestamp ON logs ("timestamp");`)
  }

  async insertLog(logEntry: Record<string, any>) {
    const id = randomUUID()
    const timestamp = new Date().toISOString()
    try {
      await insertRow(this.db, 'logs', {
        id,
        timestamp,
        moduleName: logEntry.moduleName,
        level: logEntry.level,
        doc: JSON.stringify({ ...logEntry, timestamp })
      })
      return { ...logEntry, id }
    } catch (error) {
      // one line for each failed write would double the output while the database is down
      DATABASE_LOGGER.throttled(
        LOG_INSERT_FAILED_KEY,
        LOG_LEVELS_STR.LEVEL_ERROR,
        `Error when inserting log entry: ${error.message}`
      )
      return null
    }
  }

  async retrieveLog(id: string): Promise<Record<string, any> | null> {
    try {
      const row = await this.db.get<LogRow>(
        'SELECT "id", "doc" FROM logs WHERE "id" = ?',
        [id]
      )
      return row ? toLog(row) : null
    } catch (error) {
      DATABASE_LOGGER.error(`Error when retrieving log entry: ${error.message}`)
      return null
    }
  }

  // Newest first. With `page` (starts at 0): one page of at most PAGE_SIZE logs. Without
  // it: the first `maxLogs` logs.
  async retrieveMultipleLogs(
    startTime: Date,
    endTime: Date,
    maxLogs: number,
    moduleName?: string,
    level?: string,
    page?: number
  ): Promise<Record<string, any>[]> {
    const where = new Conditions()
      .add('"timestamp" >= ?', startTime.toISOString())
      .add('"timestamp" <= ?', endTime.toISOString())
    if (moduleName) where.add('LOWER("moduleName") = ?', moduleName.toLowerCase())
    if (level) where.add('LOWER("level") = ?', level.toLowerCase())
    const hasPage = page !== undefined && page !== null
    const limit = hasPage ? Math.min(maxLogs, PAGE_SIZE) : maxLogs
    try {
      const rows = await this.db.all<LogRow>(
        `SELECT "id", "doc" FROM logs${where} ORDER BY "timestamp" DESC LIMIT ? OFFSET ?`,
        [...where.params, limit, hasPage ? page * limit : 0]
      )
      return rows.map(toLog)
    } catch (error) {
      DATABASE_LOGGER.error(
        `Error when retrieving multiple log entries: ${error.message}`
      )
      return []
    }
  }

  async delete(logId: string): Promise<void> {
    if (!logId) {
      throw new Error('Log ID is required for deletion.')
    }
    await this.db.run('DELETE FROM logs WHERE "id" = ?', [logId])
  }

  // deletes the logs that are older than LOG_RETENTION_TIME (milliseconds)
  async deleteOldLogs(): Promise<number> {
    const limit = new Date(Date.now() - this.retentionMs()).toISOString()
    try {
      const { changes } = await this.db.run('DELETE FROM logs WHERE "timestamp" <= ?', [
        limit
      ])
      return changes
    } catch (error) {
      DATABASE_LOGGER.error(`Error when deleting old log entries: ${error.message}`)
      return 0
    }
  }

  async getLogsCount(): Promise<number> {
    try {
      const row = await this.db.get('SELECT COUNT(*) AS "count" FROM logs')
      return Number(row.count)
    } catch (error) {
      DATABASE_LOGGER.error(`Unable to retrieve logs count: ${error.message}`)
      return 0
    }
  }
}
