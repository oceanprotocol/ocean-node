import fs from 'fs/promises'
import path from 'path'
import { LOGGER_MODULE_NAMES } from './Logger.js'

const LOGS_DIR = 'logs/'
const EXCEPTIONS_SUFFIX = '_exceptions.log'

/**
 * Reads exception log files from the logs/ directory and returns parsed entries.
 * Used as a fallback when LOG_DB is disabled and the database has no log entries.
 * Each exception file is NDJSON (one JSON object per line) written by winston.
 */
export async function readExceptionLogFiles(
  startTime: Date,
  endTime: Date,
  maxLogs: number,
  moduleName?: string,
  level?: string
): Promise<Record<string, any>[]> {
  const moduleNames = Object.values(LOGGER_MODULE_NAMES)
  const targetModules = moduleName
    ? moduleNames.filter((m) => m.toLowerCase() === moduleName.toLowerCase())
    : moduleNames

  const logs: Record<string, any>[] = []

  for (const mod of targetModules) {
    if (logs.length >= maxLogs) break

    const filePath = path.join(LOGS_DIR, mod + EXCEPTIONS_SUFFIX)
    let content: string
    try {
      content = await fs.readFile(filePath, 'utf-8')
    } catch {
      continue // File doesn't exist or isn't readable
    }
    if (!content.trim()) continue

    const lines = content.split('\n')
    for (const line of lines) {
      if (!line.trim()) continue
      if (logs.length >= maxLogs) break

      try {
        const entry = JSON.parse(line)
        const entryDate = new Date(entry.date)

        if (entryDate < startTime || entryDate > endTime) continue
        if (level && entry.level !== level) continue

        logs.push({
          level: entry.level,
          message: entry.message,
          moduleName: (entry.component || mod).toUpperCase(),
          timestamp: entryDate.getTime(),
          meta: JSON.stringify({
            stack: entry.stack,
            trace: entry.trace,
            os: entry.os
          })
        })
      } catch {
        // Skip malformed lines
      }
    }
  }

  logs.sort((a, b) => b.timestamp - a.timestamp)
  return logs.slice(0, maxLogs)
}
