import fs from 'fs'
import fsp from 'fs/promises'
import path from 'path'
import readline from 'readline'
import zlib from 'zlib'
import {
  EXCEPTIONS_LOG_BASENAME,
  LOGGER_MODULE_NAMES,
  getLogsDir,
  getModuleLogBasenames
} from './Logger.js'

// same shape as the log DB records: nodes-dashboard, ocean-cli and on-mcp depend on it
export interface LogRecord {
  level: string
  message: string
  moduleName: string
  timestamp: number // epoch ms
  meta?: string
}

export interface ReadLogFilesOptions {
  startTime: Date
  endTime: Date
  maxLogs: number
  moduleName?: string
  level?: string
  page?: number // 1-based
  dir?: string // defaults to getLogsDir()
}

// upper bound on page * maxLogs: deeper pages return []
export const MAX_LOG_FILE_RESULTS = 10000

// uncaught exceptions belong to the whole process
const EXCEPTIONS_MODULE_NAME = LOGGER_MODULE_NAMES.OCEAN_NODE.toUpperCase()
const ALL_MODULES = LOGGER_MODULE_NAMES.ALL_COMBINED.toLowerCase()
const ROTATED_FILE = /^([a-z0-9]+)-(\d{4}-\d{2}-\d{2})(?:\.(\d+))?\.log(\.gz)?$/
const LEGACY_EXCEPTIONS_FILE = /^([A-Za-z0-9]+)_exceptions\.log$/

interface LogFile {
  file: string
  series: string
  day: string // YYYY-MM-DD (UTC)
  part: number // 0 for the base file
  gz: boolean
  exceptions: boolean
}

interface ScanFilter {
  start: number
  end: number
  level?: string
  module?: string
}

function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

// keeps the last `size` items pushed
class RingBuffer<T> {
  private items: T[] = []
  private next = 0
  constructor(private readonly size: number) {}

  push(item: T): void {
    if (this.items.length < this.size) {
      this.items.push(item)
    } else {
      this.items[this.next] = item
      this.next = (this.next + 1) % this.size
    }
  }

  toArray(): T[] {
    return this.items.slice(this.next).concat(this.items.slice(0, this.next))
  }
}

function toRecord(
  entry: Record<string, any>,
  file: LogFile,
  filter: ScanFilter
): LogRecord | null {
  const timestamp = Date.parse(entry.timestamp ?? entry.date)
  if (!Number.isFinite(timestamp) || timestamp < filter.start || timestamp > filter.end) {
    return null
  }
  const level = typeof entry.level === 'string' ? entry.level : ''
  if (filter.level && level !== filter.level) return null

  if (file.exceptions) {
    return {
      level,
      message: String(entry.message ?? ''),
      moduleName: EXCEPTIONS_MODULE_NAME,
      timestamp,
      meta: JSON.stringify({ stack: entry.stack, trace: entry.trace, os: entry.os })
    }
  }
  const moduleName = String(entry.moduleName ?? entry.component ?? file.series)
  // the 'all' file also takes loggers of unknown modules
  if (
    filter.module &&
    filter.module !== ALL_MODULES &&
    moduleName.toLowerCase() !== filter.module
  ) {
    return null
  }
  return {
    level,
    message: String(entry.message ?? ''),
    moduleName: moduleName.toUpperCase(),
    timestamp
  }
}

// newest `want` matching records of one file; read errors (file rotated away, corrupt or
// partially written gzip) end this file only
async function scanFile(
  file: LogFile,
  filter: ScanFilter,
  want: number
): Promise<LogRecord[]> {
  const buffer = new RingBuffer<LogRecord>(want)
  const needle = filter.level ? `"level":${JSON.stringify(filter.level)}` : null
  const input = fs.createReadStream(file.file)
  const source = file.gz ? input.pipe(zlib.createGunzip()) : input
  if (file.gz) input.on('error', (err) => source.destroy(err))
  const lines = readline.createInterface({ input: source, crlfDelay: Infinity })
  try {
    for await (const line of lines) {
      // keys are sorted and unspaced, so this skips most other-level lines unparsed
      if (needle && !line.includes(needle)) continue
      let entry: unknown
      try {
        entry = JSON.parse(line)
      } catch {
        continue // malformed or partially written line
      }
      if (!entry || typeof entry !== 'object') continue
      const record = toRecord(entry as Record<string, any>, file, filter)
      if (record) buffer.push(record)
    }
  } catch {
    // keep what was read so far
  } finally {
    lines.close()
    input.destroy()
    source.destroy()
  }
  return buffer.toArray()
}

function newestFirst(a: LogRecord, b: LogRecord): number {
  return b.timestamp - a.timestamp
}

async function listLogFiles(dir: string): Promise<fs.Dirent[]> {
  try {
    return await fsp.readdir(dir, { withFileTypes: true })
  } catch {
    return [] // missing or unreadable directory
  }
}

/**
 * Reads the rotating log files (`<module>-YYYY-MM-DD[.N].log[.gz]` and
 * `exceptions-YYYY-MM-DD...`) and returns records shaped like the log DB, newest first.
 * Streams one UTC day at a time, newest day first, and stops as soon as the requested page
 * is filled. A module filter only opens that module's files; exception entries are tagged
 * OCEANNODE and come back for that module (or 'all') only. Legacy `<module>_exceptions.log`
 * files are read, deduplicated, only when the range starts before the first rotated file.
 */
export async function readLogFiles(options: ReadLogFilesOptions): Promise<LogRecord[]> {
  const start = options.startTime?.getTime?.()
  const end = options.endTime?.getTime?.()
  const maxLogs = Math.floor(Number(options.maxLogs))
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) return []
  if (!Number.isFinite(maxLogs) || maxLogs <= 0) return []
  const page =
    Number.isFinite(options.page) && options.page >= 1 ? Math.floor(options.page) : 1
  const offset = (page - 1) * maxLogs
  const want = Math.min(page * maxLogs, MAX_LOG_FILE_RESULTS)
  if (offset >= want) return []

  const known = getModuleLogBasenames()
  let series: Set<string>
  let module: string | undefined
  if (options.moduleName) {
    module = options.moduleName.trim().toLowerCase()
    if (!known.includes(module)) return []
    series = new Set([module])
    // exceptions are tagged with the OCEANNODE module (and the 'all' filter passes every module)
    if (module === EXCEPTIONS_MODULE_NAME.toLowerCase() || module === ALL_MODULES) {
      series.add(EXCEPTIONS_LOG_BASENAME)
    }
  } else {
    series = new Set([...known, EXCEPTIONS_LOG_BASENAME])
  }
  const filter: ScanFilter = {
    start,
    end,
    level: options.level ? options.level.trim().toLowerCase() : undefined,
    module
  }

  const dir = options.dir ?? getLogsDir()
  const firstDay = utcDay(start)
  const lastDay = utcDay(end)
  let oldestRotatedDay: string | null = null
  const byDay = new Map<string, Map<string, LogFile>>()
  const legacy: LogFile[] = []

  // symlinks (<module>-current.log), audit files and legacy <module>.log files are skipped
  for (const dirent of await listLogFiles(dir)) {
    if (!dirent.isFile()) continue
    const rotated = ROTATED_FILE.exec(dirent.name)
    if (rotated) {
      const [, name, day, part, gz] = rotated
      if (name !== EXCEPTIONS_LOG_BASENAME && !known.includes(name)) continue
      if (oldestRotatedDay === null || day < oldestRotatedDay) oldestRotatedDay = day
      if (!series.has(name) || day < firstDay || day > lastDay) continue
      const files = byDay.get(day) ?? new Map<string, LogFile>()
      byDay.set(day, files)
      // while an archive is being gzipped both copies exist: the plain one is complete
      const key = dirent.name.replace(/\.gz$/, '')
      if (gz && files.get(key)?.gz === false) continue
      files.set(key, {
        file: path.join(dir, dirent.name),
        series: name,
        day,
        part: part ? Number(part) : 0,
        gz: !!gz,
        exceptions: name === EXCEPTIONS_LOG_BASENAME
      })
      continue
    }
    const old = LEGACY_EXCEPTIONS_FILE.exec(dirent.name)
    if (old && known.includes(old[1].toLowerCase())) {
      legacy.push({
        file: path.join(dir, dirent.name),
        series: old[1].toLowerCase(),
        day: '',
        part: 0,
        gz: false,
        exceptions: true
      })
    }
  }

  const result: LogRecord[] = []
  // files are named by UTC day, so an older day never holds a newer entry
  const days = [...byDay.keys()].sort().reverse()
  for (const day of days) {
    const files = [...byDay.get(day).values()].sort((a, b) => b.part - a.part)
    const chunks = await Promise.all(files.map((file) => scanFile(file, filter, want)))
    for (const chunk of chunks) result.push(...chunk)
    if (result.length >= want) break
  }

  // legacy files have one copy of each exception per module and no day in their name
  if (
    result.length < want &&
    legacy.length > 0 &&
    series.has(EXCEPTIONS_LOG_BASENAME) &&
    (oldestRotatedDay === null || start < Date.parse(oldestRotatedDay))
  ) {
    const seen = new Set<string>()
    const chunks = await Promise.all(legacy.map((file) => scanFile(file, filter, want)))
    const unique = chunks.flat().filter((record) => {
      // the copies were stamped separately: compare at second precision
      const key = `${Math.floor(record.timestamp / 1000)}|${record.message}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    result.push(...unique)
  }

  return result.sort(newestFirst).slice(offset, want)
}
