import winston, { LogEntry } from 'winston'
import Transport from 'winston-transport'
import DailyRotateFile from 'winston-daily-rotate-file'
import fs from 'fs'
import path from 'path'
import type { Database } from '../../components/database/index.js'
import { errorSummary } from './redact.js'

// all the types of modules/components
export const LOGGER_MODULE_NAMES = {
  HTTP: 'http',
  P2P: 'p2p',
  INDEXER: 'indexer',
  REINDEXER: 'reindexer',
  PROVIDER: 'provider',
  DATABASE: 'database',
  CONFIG: 'config',
  ALL_COMBINED: 'all',
  CORE: 'core',
  OCEAN_NODE: 'OceanNode'
}

// Some constants for logging
export const LOG_LEVELS_NUM = {
  error: 0,
  warn: 1,
  info: 2,
  http: 3,
  verbose: 4,
  debug: 5,
  silly: 6
}

export const LOG_LEVELS_STR = {
  LEVEL_ERROR: 'error',
  LEVEL_WARN: 'warn',
  LEVEL_INFO: 'info',
  LEVEL_HTTP: 'http',
  LEVEL_VERBOSE: 'verbose',
  LEVEL_DEBUG: 'debug',
  LEVEL_SILLY: 'silly'
}

const LOG_LEVELS_EMOJI = {
  error: '\u{1F631}', // face scremaing in panic
  debug: '\u{1F9D0}', // face with monocle
  warn: '\u{26a0} \u{FE0F}', // warning
  verbose: '\u{1F4AC}', // speech ballon
  info: '\u{1F449}', // point right
  http: '\u{1F98A}', // firefox homage :-)
  silly: '\u{1F92A}' // zany face
}

// we might want these somewhere else
export const GENERIC_EMOJIS = {
  EMOJI_CHECK_MARK: '\u{2705}',
  EMOJI_CROSS_MARK: '\u{274C}',
  EMOJI_OCEAN_WAVE: '\u{1F30A}',
  EMOJI_TO_MOON: '\u{1F680}' // rocket emoji
}

export function getLoggerLevelEmoji(level: string): string {
  const emoji = LOG_LEVELS_EMOJI[level as keyof typeof LOG_LEVELS_EMOJI]
  if (!emoji) {
    return GENERIC_EMOJIS.EMOJI_OCEAN_WAVE
  }
  return emoji
}

export const LOG_COLORS = {
  error: 'red',
  warn: 'yellow',
  info: 'cyan',
  debug: 'green',
  http: 'blue',
  verbose: 'white'
}

export const EXCEPTIONS_LOG_BASENAME = 'exceptions'
export const DEFAULT_LOG_FILES_DIR = 'logs'
export const DEFAULT_LOG_FILES_LEVEL = LOG_LEVELS_STR.LEVEL_INFO
export const DEFAULT_LOG_FILES_RETENTION_DAYS = 30
export const DEFAULT_LOG_FILES_MAX_SIZE = '20m'
export const DEFAULT_THROTTLE_INTERVAL_MS = 3_600_000
const CONSOLE_ERROR_INTERVAL_MS = 60_000
const MAX_THROTTLE_KEYS = 1000
const DAY_MS = 24 * 60 * 60 * 1000

// first occurrence of a key passes, repeats inside the interval are counted and suppressed
class Throttle {
  private readonly states = new Map<string, { since: number; suppressed: number }>()

  // null = suppress, otherwise the number of repeats suppressed since the last emission
  check(key: string, intervalMs: number, now: number = Date.now()): number | null {
    const state = this.states.get(key)
    if (state && now - state.since < intervalMs) {
      state.suppressed++
      return null
    }
    const suppressed = state ? state.suppressed : 0
    this.states.delete(key)
    this.states.set(key, { since: now, suppressed: 0 })
    if (this.states.size > MAX_THROTTLE_KEYS) {
      this.states.delete(this.states.keys().next().value)
    }
    return suppressed
  }

  reset(key: string): void {
    this.states.delete(key)
  }
}

// the logger's own problems go to stderr (logging them through winston could loop)
const consoleErrorThrottle = new Throttle()
function rateLimitedConsoleError(key: string, message: string): void {
  const suppressed = consoleErrorThrottle.check(key, CONSOLE_ERROR_INTERVAL_MS)
  if (suppressed === null) return
  console.error(
    suppressed > 0 ? `${message} (${suppressed} similar suppressed)` : message
  )
}

// for a custom logger transport
interface CustomOceanNodesTransportOptions extends Transport.TransportStreamOptions {
  dbInstance: Database
  collectionName?: string
  moduleName?: string
}

export class CustomOceanNodesTransport extends Transport {
  private dbInstance: Database
  private isLogging = false

  constructor(options: CustomOceanNodesTransportOptions) {
    super(options)
    this.dbInstance = options.dbInstance
  }

  // rebind to a (re)initialized database
  setDatabase(dbInstance: Database): void {
    this.dbInstance = dbInstance
  }

  hasLogDatabase(): boolean {
    return !!this.dbInstance?.logs
  }

  async log(info: LogEntry, callback: () => void): Promise<void> {
    setImmediate(() => {
      this.emit('logged', info)
    })

    // Prevent feedback loop: writing a log to the DB triggers Typesense API calls,
    // which generate debug logs, which would trigger more DB writes, and so on.
    if (this.isLogging) {
      callback()
      return
    }

    // Prepare the document to be logged
    const document = {
      level: info.level,
      message: info.message,
      moduleName: info.moduleName || LOGGER_MODULE_NAMES.ALL_COMBINED,
      timestamp: Date.now(), // Storing the current timestamp as a Unix epoch timestamp (number)
      meta: JSON.stringify(info.meta) // Ensure meta is a string
    }

    try {
      // Use the insertLog method of the LogDatabase instance
      if (this.dbInstance && this.dbInstance.logs) {
        this.isLogging = true
        await this.dbInstance.logs.insertLog(document)
      }
    } catch (error) {
      // console on purpose: logging this through winston would feed back into the DB
      rateLimitedConsoleError(
        'db-transport',
        `[logger] error writing log to DB: ${errorSummary(error)}`
      )
    } finally {
      this.isLogging = false
    }

    callback()
  }
}

let INSTANCE_COUNT = 0
let customDBTransport: CustomOceanNodesTransport = null

export const MAX_LOGGER_INSTANCES = 10

// unset or empty = not set (undefined); false/0/no/off (any case) = false; anything else = true
export function parseBoolEnv(value?: string): boolean | undefined {
  if (value === undefined || value === null) return undefined
  const v = String(value).trim().toLowerCase()
  if (!v) return undefined
  return !['false', '0', 'no', 'off'].includes(v)
}

export function parseLogLevel(value?: string): string | null {
  if (typeof value !== 'string') return null
  const level = value.trim().toLowerCase()
  return level in LOG_LEVELS_NUM ? level : null
}

// accepts winston levels in any case and LOG_LEVELS_STR keys ('LEVEL_ERROR'); else info
export function normalizeLogLevel(level: string): string {
  const parsed = parseLogLevel(level)
  if (parsed) return parsed
  if (typeof level === 'string') {
    const mapped = (LOG_LEVELS_STR as Record<string, string>)[level.trim().toUpperCase()]
    if (mapped) return mapped
  }
  return LOG_LEVELS_STR.LEVEL_INFO
}

function moreVerboseLevel(a: string, b: string): string {
  return LOG_LEVELS_NUM[a as keyof typeof LOG_LEVELS_NUM] >=
    LOG_LEVELS_NUM[b as keyof typeof LOG_LEVELS_NUM]
    ? a
    : b
}

export function USE_DB_TRANSPORT(): boolean {
  return parseBoolEnv(process.env.LOG_DB) === true
}

// if not set, then gets default 'development' level & colors
export function isDevelopmentEnvironment(): boolean {
  const env = process.env.NODE_ENV || 'development'
  return env === 'development'
}

export interface LoggingConfig {
  console: boolean
  file: boolean
  db: boolean
  exceptionsFile: boolean
  // LOG_FILES=false: no disk logging at all (no exceptions file, no runtime fallback)
  filesDisabled: boolean
  consoleLevel: string
  fileLevel: string
  // most verbose of console and file levels, used by the cheap pre-filter in log()
  loggerLevel: string
  dir: string
  retentionDays: number
  maxSize: string
  warnings: string[]
}

/**
 * Resolves where logs go and at which levels. Pure: only reads `env`.
 * Invalid values fall back to their defaults and are reported in `warnings`.
 */
export function resolveLoggingConfig(
  env: NodeJS.ProcessEnv = process.env
): LoggingConfig {
  const warnings: string[] = []
  const db = parseBoolEnv(env.LOG_DB) === true
  const logFiles = parseBoolEnv(env.LOG_FILES)
  const file = logFiles ?? !db
  let consoleOn = parseBoolEnv(env.LOG_CONSOLE) ?? true
  if (!consoleOn && !file && !db) {
    consoleOn = true
    warnings.push(
      'LOG_CONSOLE=false but neither LOG_FILES nor LOG_DB is enabled: keeping console logging on'
    )
  }

  const isDev = (env.NODE_ENV || 'development') === 'development'
  const levelOrDefault = (name: string, fallback: string): string => {
    const raw = env[name]
    if (raw === undefined || raw.trim() === '') return fallback
    const level = parseLogLevel(raw)
    if (!level) warnings.push(`invalid ${name} "${raw}", using "${fallback}"`)
    return level ?? fallback
  }
  const consoleLevel = levelOrDefault(
    'LOG_LEVEL',
    isDev ? LOG_LEVELS_STR.LEVEL_DEBUG : LOG_LEVELS_STR.LEVEL_INFO
  )
  const fileLevel = levelOrDefault('LOG_FILES_LEVEL', DEFAULT_LOG_FILES_LEVEL)

  let retentionDays = DEFAULT_LOG_FILES_RETENTION_DAYS
  const rawRetention = env.LOG_FILES_RETENTION_DAYS?.trim()
  if (rawRetention) {
    const days = /^\d+$/.test(rawRetention) ? parseInt(rawRetention, 10) : NaN
    if (Number.isSafeInteger(days) && days >= 1) retentionDays = days
    else
      warnings.push(
        `invalid LOG_FILES_RETENTION_DAYS "${rawRetention}", using ${DEFAULT_LOG_FILES_RETENTION_DAYS}`
      )
  }

  let maxSize = DEFAULT_LOG_FILES_MAX_SIZE
  const rawMaxSize = env.LOG_FILES_MAX_SIZE?.trim()
  if (rawMaxSize) {
    if (/^[1-9]\d*[kmg]$/i.test(rawMaxSize)) maxSize = rawMaxSize.toLowerCase()
    else
      warnings.push(
        `invalid LOG_FILES_MAX_SIZE "${rawMaxSize}", using "${DEFAULT_LOG_FILES_MAX_SIZE}"`
      )
  }

  return {
    console: consoleOn,
    file,
    db,
    exceptionsFile: logFiles !== false,
    filesDisabled: logFiles === false,
    consoleLevel,
    fileLevel,
    loggerLevel: file ? moreVerboseLevel(consoleLevel, fileLevel) : consoleLevel,
    dir: path.resolve(env.LOG_FILES_DIR?.trim() || DEFAULT_LOG_FILES_DIR),
    retentionDays,
    maxSize,
    warnings
  }
}

// snapshot taken once, when the module loads
const LOGGING: LoggingConfig = resolveLoggingConfig()

export const getDefaultLevel = (): string => {
  return LOGGING.consoleLevel
}

// where log files are (or would be) written; read from env on each call
export function getLogsDir(): string {
  return path.resolve(process.env.LOG_FILES_DIR?.trim() || DEFAULT_LOG_FILES_DIR)
}

// lowercased module names that get their own rotating file (<basename>-YYYY-MM-DD.log)
export function getModuleLogBasenames(): string[] {
  return [...new Set(Object.values(LOGGER_MODULE_NAMES).map((m) => m.toLowerCase()))]
}

// unknown module names share the 'all' file
export function getModuleLogBasename(moduleName?: string): string {
  const name = (moduleName || LOGGER_MODULE_NAMES.ALL_COMBINED).toLowerCase()
  return getModuleLogBasenames().includes(name) ? name : LOGGER_MODULE_NAMES.ALL_COMBINED
}

if (isDevelopmentEnvironment()) {
  winston.addColors(LOG_COLORS)
}

// file lines: one JSON object per line, sorted keys, ISO timestamp
const LINE_FORMAT: winston.Logform.Format = winston.format.combine(
  winston.format.timestamp(),
  winston.format.json()
)

const alignedWithColorsAndTime: winston.Logform.Format = winston.format.combine(
  winston.format.colorize({ all: true }),
  winston.format.timestamp(),
  winston.format.align(),
  winston.format.printf(
    (info) => `${info.timestamp} ${info.level}: ${(info.message as string).trim()}`
  )
)
const consoleColorFormatting: winston.Logform.Format | Record<string, any> = {
  format: winston.format.combine(alignedWithColorsAndTime, winston.format.colorize())
}

// every transport gets an explicit level: a shared transport only ever sees the level of
// the first logger it was added to
export const defaultConsoleTransport = new winston.transports.Console({
  ...consoleColorFormatting,
  level: LOGGING.consoleLevel
})

export interface RotatingFileOptions {
  dir: string
  basename: string
  level: string
  retentionDays: number
  maxSize: string
  symlink?: boolean
  // called once the write stream failed and the transport went silent
  onStreamError?: () => void
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Deletes `<basename>-YYYY-MM-DD[.N].log[.gz]` files whose UTC day is more than
 * `retentionDays` before today. The rotator only prunes files listed in its audit file and
 * misses archives gzipped before a restart, so this sweep runs whenever a transport is built.
 */
export function pruneExpiredLogFiles(
  dir: string,
  basename: string,
  retentionDays: number,
  now: number = Date.now()
): string[] {
  const pattern = new RegExp(
    `^${escapeRegExp(basename)}-(\\d{4})-(\\d{2})-(\\d{2})(?:\\.\\d+)?\\.log(?:\\.gz)?$`
  )
  const today = new Date(now)
  const cutoff =
    Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()) -
    retentionDays * DAY_MS
  const removed: string[] = []
  let names: string[] = []
  try {
    names = fs.readdirSync(dir)
  } catch {
    return removed
  }
  for (const name of names) {
    const match = pattern.exec(name)
    if (!match) continue
    const day = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
    if (day >= cutoff) continue
    try {
      fs.unlinkSync(path.join(dir, name))
      removed.push(name)
    } catch {
      // already gone or not removable: the next sweep retries
    }
  }
  return removed
}

/**
 * Daily rotating JSON-lines file `<dir>/<basename>-YYYY-MM-DD[.N].log` (UTC days), gzipped
 * on rotation, kept `retentionDays` days. Throws if `dir` cannot be created or written.
 * Disk errors (ENOSPC, EACCES...) never crash the node: the transport goes silent.
 */
export function buildRotatingFileTransport(opts: RotatingFileOptions): DailyRotateFile {
  fs.mkdirSync(opts.dir, { recursive: true })
  fs.accessSync(opts.dir, fs.constants.W_OK)
  pruneExpiredLogFiles(opts.dir, opts.basename, opts.retentionDays)

  const transport = new DailyRotateFile({
    dirname: opts.dir,
    filename: `${opts.basename}-%DATE%`,
    extension: '.log',
    datePattern: 'YYYY-MM-DD',
    utc: true,
    maxFiles: `${opts.retentionDays}d`,
    maxSize: opts.maxSize,
    zippedArchive: true,
    // explicit: the default name is a hash of the options, so any option change would
    // orphan the existing files from retention
    auditFile: path.join(opts.dir, `.${opts.basename}-audit.json`),
    createSymlink: opts.symlink !== false,
    symlinkName: `${opts.basename}-current.log`,
    level: opts.level,
    format: LINE_FORMAT
  })
  transport.setMaxListeners(30)

  const where = path.join(opts.dir, `${opts.basename}-*.log`)
  // nothing listens for the rotator's write errors otherwise: they would crash the process
  transport.logStream.on('error', (err: unknown) => {
    transport.silent = true
    rateLimitedConsoleError(
      `file:${where}`,
      `[logger] disk logging to ${where} stopped: ${errorSummary(err)}`
    )
    opts.onStreamError?.()
  })
  // gzip / cleanup failures are emitted on the transport itself. Emitted for real, every
  // logger's pipe would unpipe (and close) the shared transport: report them, keep logging
  const emit = transport.emit.bind(transport)
  transport.emit = ((event: string | symbol, ...args: any[]): boolean => {
    if (event !== 'error') return emit(event, ...args)
    rateLimitedConsoleError(
      `file-maintenance:${where}`,
      `[logger] log file maintenance error (${where}): ${errorSummary(args[0])}`
    )
    return true
  }) as typeof transport.emit
  return transport
}

// one rotating transport per file, shared by every logger of that module: two rotators on
// the same file would corrupt rotation. null = could not be created
const fileTransports = new Map<string, DailyRotateFile | null>()
let exceptionsTransport: DailyRotateFile | null | undefined
let exceptionHandlerAssigned = false
const closedTransports = new WeakSet<object>()

// after a write error (ENOSPC, EACCES...) the rotator's stream is destroyed: retry with a
// fresh transport later instead of staying silent until restart
export const FILE_RECOVERY_DELAY_MS = 60_000
const pendingRecoveries = new Set<string>()

function scheduleFileTransportRecovery(
  key: string,
  moduleName: string,
  cfg: LoggingConfig
): void {
  if (pendingRecoveries.has(key)) return
  pendingRecoveries.add(key)
  const timer = setTimeout(() => {
    pendingRecoveries.delete(key)
    const dead = fileTransports.get(key)
    // flushed for shutdown, or already replaced
    if (!dead || closedTransports.has(dead) || !dead.silent) return
    fileTransports.delete(key)
    const fresh = getModuleFileTransport(moduleName, cfg)
    if (!fresh) {
      fileTransports.set(key, dead)
      scheduleFileTransportRecovery(key, moduleName, cfg)
      return
    }
    for (const logger of REGISTRY) {
      if (!logger.getTransports().includes(dead)) continue
      logger.logger.remove(dead)
      logger.addTransport(fresh)
    }
    closedTransports.add(dead)
    try {
      dead.close()
    } catch {
      // the stream is already gone
    }
    REGISTRY[0]?.warn(
      `Disk logging to ${path.join(cfg.dir, path.basename(key))}-*.log resumed`
    )
  }, FILE_RECOVERY_DELAY_MS)
  timer.unref()
}

export function getModuleFileTransport(
  moduleName: string,
  cfg: LoggingConfig = LOGGING
): DailyRotateFile | null {
  const basename = getModuleLogBasename(moduleName)
  const key = path.join(cfg.dir, basename)
  if (fileTransports.has(key)) return fileTransports.get(key)
  let transport: DailyRotateFile | null = null
  try {
    transport = buildRotatingFileTransport({
      dir: cfg.dir,
      basename,
      level: cfg.fileLevel,
      retentionDays: cfg.retentionDays,
      maxSize: cfg.maxSize,
      onStreamError: () => scheduleFileTransportRecovery(key, moduleName, cfg)
    })
  } catch (err) {
    rateLimitedConsoleError(
      `file-init:${cfg.dir}`,
      `[logger] cannot write log files to ${cfg.dir} (${errorSummary(
        err
      )}): file logging disabled`
    )
  }
  fileTransports.set(key, transport)
  return transport
}

function getExceptionsTransport(cfg: LoggingConfig = LOGGING): DailyRotateFile | null {
  if (exceptionsTransport === undefined) {
    try {
      exceptionsTransport = buildRotatingFileTransport({
        dir: cfg.dir,
        basename: EXCEPTIONS_LOG_BASENAME,
        level: LOG_LEVELS_STR.LEVEL_ERROR,
        retentionDays: cfg.retentionDays,
        maxSize: cfg.maxSize
      })
    } catch (err) {
      exceptionsTransport = null
      rateLimitedConsoleError(
        `file-init:${cfg.dir}`,
        `[logger] cannot write the exceptions log to ${cfg.dir}: ${errorSummary(err)}`
      )
    }
  }
  return exceptionsTransport
}

function isSharedFileTransport(transport: Transport): boolean {
  if (!transport) return false
  if (transport === exceptionsTransport) return true
  for (const t of fileTransports.values()) {
    if (t === transport) return true
  }
  return false
}

let fileFallbackReason: string | null = null

// LOGGING, with file logging switched on once the runtime fallback kicked in
function effectiveLoggingConfig(): LoggingConfig {
  if (fileFallbackReason === null || LOGGING.file) return LOGGING
  return {
    ...LOGGING,
    file: true,
    loggerLevel: moreVerboseLevel(LOGGING.consoleLevel, LOGGING.fileLevel)
  }
}

/**
 * Transports for a module logger: its rotating file (if file logging is on and the file
 * could be opened) and the console (if enabled, or if there is no other output).
 */
export function getDefaultLoggerTransports(
  moduleOrComponentName: string,
  cfg: LoggingConfig = resolveLoggingConfig()
): winston.transport[] {
  const transports: winston.transport[] = []
  const fileTransport = cfg.file
    ? getModuleFileTransport(moduleOrComponentName, cfg)
    : null
  if (fileTransport) {
    transports.push(fileTransport)
  }
  if (cfg.console || (!fileTransport && !cfg.db)) {
    transports.push(defaultConsoleTransport)
  }
  return transports
}

export interface CustomNodeLoggerOptions extends winston.LoggerOptions {
  moduleName: string // one of LOGGER_MODULE_NAMES
}

function buildLoggerOptions(
  moduleName: string,
  cfg: LoggingConfig,
  logLevel?: string
): CustomNodeLoggerOptions {
  return {
    level: parseLogLevel(logLevel) ?? cfg.loggerLevel,
    levels: LOG_LEVELS_NUM,
    format: LINE_FORMAT,
    moduleName,
    defaultMeta: { component: moduleName.toUpperCase() },
    transports: getDefaultLoggerTransports(moduleName, cfg)
  }
}

const REGISTRY: CustomNodeLogger[] = []
let configWarningsEmitted = false

/**
 * Customize the logger options
 */
export class CustomNodeLogger {
  // safe a ref to the logger
  logger: winston.Logger
  // save a ref to options
  loggerOptions: CustomNodeLoggerOptions
  private readonly throttle = new Throttle()

  constructor(options?: CustomNodeLoggerOptions) {
    if (INSTANCE_COUNT >= MAX_LOGGER_INSTANCES) {
      throw new Error(
        `You have reached the maximum number of Logger instances considered safe (${MAX_LOGGER_INSTANCES}). Please consider reusing some of them!`
      )
    }
    INSTANCE_COUNT++
    this.loggerOptions =
      options ??
      buildLoggerOptions(LOGGER_MODULE_NAMES.ALL_COMBINED, effectiveLoggingConfig())
    this.logger = winston.createLogger({ ...this.loggerOptions })
    // transport errors are re-emitted on the logger: never let them crash the process
    this.logger.on('error', (err: unknown) => {
      rateLimitedConsoleError('logger', `[logger] transport error: ${errorSummary(err)}`)
    })
    REGISTRY.push(this)

    if (!options) {
      this.debug('CustomNodeLogger created without options, using defaults')
    }
    if (INSTANCE_COUNT === MAX_LOGGER_INSTANCES) {
      // after 10 instances we get warnings about possible memory leaks
      this.warn(
        `You already have ${INSTANCE_COUNT} instances of Logger. Please consider reusing some of them!`
      )
    }
    if (!configWarningsEmitted) {
      configWarningsEmitted = true
      for (const warning of LOGGING.warnings) {
        this.warn(`Logging config: ${warning}`)
      }
    }
  }

  removeTransport(winston: Transport) {
    // shared file transports are closed when unpiped from their first logger, which would
    // stop file logging for every module
    if (isSharedFileTransport(winston)) return
    this.logger.remove(winston)
  }

  addTransport(winston: Transport) {
    this.logger.add(winston)
  }

  getTransports(): Array<Transport> {
    return this.logger.transports
  }

  hasDBTransports(): boolean {
    return this.hasDBTransport()
  }

  getLogger(): winston.Logger {
    return this.logger
  }

  // should correspond also to filename when logging to a file
  getModuleName(): string {
    return this.loggerOptions.moduleName
  }

  // the logger's threshold (most verbose of its transports), never a message level
  getLoggerLevel(): string {
    return this.logger.level || this.loggerOptions.level
  }

  // some shorter versions
  debug(message: string): void {
    this.log(LOG_LEVELS_STR.LEVEL_DEBUG, message, true)
  }

  warn(message: string): void {
    this.log(LOG_LEVELS_STR.LEVEL_WARN, message, true)
  }

  info(message: string): void {
    this.log(LOG_LEVELS_STR.LEVEL_INFO, message, true)
  }

  error(message: string): void {
    this.log(LOG_LEVELS_STR.LEVEL_ERROR, message, true)
  }

  trace(message: string): void {
    this.log(LOG_LEVELS_STR.LEVEL_SILLY, message, true)
  }

  verbose(message: string): void {
    this.log(LOG_LEVELS_STR.LEVEL_VERBOSE, message, true)
  }

  // wrapper function for logging with custom logger
  log(
    level: string = LOG_LEVELS_STR.LEVEL_INFO,
    message: string,
    includeModuleName: boolean = false
  ) {
    const logLevel = normalizeLogLevel(level)
    // lazy check db custom transport, needed beacause of dependency cycles
    const usingDBTransport = this.hasDBTransport()
    if (customDBTransport !== null && USE_DB_TRANSPORT() && !usingDBTransport) {
      this.addTransport(customDBTransport)
    } else if (usingDBTransport && !USE_DB_TRANSPORT()) {
      this.removeTransport(this.getDBTransport())
    }

    // winston does not filter .log() calls by the logger level, only per transport
    if (!this.isLevelEnabled(logLevel)) return
    // avoids winston's "Attempt to write logs with no transports" warning
    if (this.logger.transports.length === 0) return

    this.logger.log(logLevel, includeModuleName ? this.buildMessage(message) : message, {
      moduleName: this.getModuleName().toUpperCase()
    })
  }

  // true when some transport may accept `level`: guards messages that are expensive to build
  isLevelEnabled(level: string): boolean {
    const threshold = LOG_LEVELS_NUM[this.logger.level as keyof typeof LOG_LEVELS_NUM]
    const wanted = LOG_LEVELS_NUM[normalizeLogLevel(level) as keyof typeof LOG_LEVELS_NUM]
    return wanted <= threshold
  }

  logMessage(
    message: string,
    includeModuleName: boolean = false,
    level: string = LOG_LEVELS_STR.LEVEL_INFO
  ) {
    this.log(level, message, includeModuleName)
  }

  // supports emoji :-)? Experimental, might not work properly on some transports
  // Usage:
  // logger.logMessageWithEmoji(`HTTP port: ${config.httpPort}`, true, GENERIC_EMOJIS.EMOJI_CHECK_MARK);
  // logger.logMessageWithEmoji(`HTTP port: ${config.httpPort}`, true, );
  logMessageWithEmoji(
    message: string,
    includeModuleName: boolean = false,
    emoji?: string,
    level: string = LOG_LEVELS_STR.LEVEL_INFO
  ) {
    const logLevel = normalizeLogLevel(level)
    this.log(
      logLevel,
      `${emoji || getLoggerLevelEmoji(logLevel)} ${message}`,
      includeModuleName
    )
  }

  // >= 500 (or no status) is a node-side failure; anything else is the client's problem
  logByStatus(httpStatus: number | undefined | null, message: string): void {
    const clientSide =
      typeof httpStatus === 'number' && Number.isFinite(httpStatus) && httpStatus < 500
    this.log(
      clientSide ? LOG_LEVELS_STR.LEVEL_DEBUG : LOG_LEVELS_STR.LEVEL_ERROR,
      message,
      true
    )
  }

  // logs the first occurrence of `key`, then at most once per interval with a suppressed count
  throttled(
    key: string,
    level: string,
    message: string,
    intervalMs: number = DEFAULT_THROTTLE_INTERVAL_MS
  ): void {
    const suppressed = this.throttle.check(key, intervalMs)
    if (suppressed === null) return
    this.log(
      level,
      suppressed > 0 ? `${message} (${suppressed} similar suppressed)` : message,
      true
    )
  }

  resetThrottle(key: string): void {
    this.throttle.reset(key)
  }

  // prefix the message with the module/component name (optional)
  buildMessage(message: string) {
    const cpName = this.getModuleName()
    if (cpName) {
      message = cpName.toUpperCase() + ':\t' + message
    }
    return message
  }

  hasDBTransport(): boolean {
    return this.getDBTransport() !== undefined
  }

  getDBTransport(): winston.transport | undefined {
    return this.getTransports().find(
      (transport: winston.transport) => transport instanceof CustomOceanNodesTransport
    )
  }
}

// kind of a factory function for different modules/components
export function getCustomLoggerForModule(
  moduleOrComponentName?: string,
  logLevel?: string
): CustomNodeLogger {
  if (!moduleOrComponentName) {
    moduleOrComponentName = LOGGER_MODULE_NAMES.ALL_COMBINED
  }
  const cfg = effectiveLoggingConfig()
  const options = buildLoggerOptions(moduleOrComponentName, cfg, logLevel)
  // an uncaught exception belongs to the whole process: one file, one process listener
  if (!exceptionHandlerAssigned && cfg.exceptionsFile) {
    const transport = getExceptionsTransport(cfg)
    if (transport) {
      options.exceptionHandlers = [transport]
      exceptionHandlerAssigned = true
    }
  }
  return new CustomNodeLogger(options)
}

export function getLoggerInstanceCount(): number {
  return INSTANCE_COUNT
}

export function configureCustomDBTransport(
  dbConnection: Database,
  logger: CustomNodeLogger
) {
  if (!customDBTransport) {
    customDBTransport = new CustomOceanNodesTransport({
      dbInstance: dbConnection,
      level: LOGGING.consoleLevel
    })
    customDBTransport.setMaxListeners(30)
  } else {
    customDBTransport.setDatabase(dbConnection)
  }
  if (!logger.hasDBTransport()) {
    logger.addTransport(customDBTransport)
    logger.debug('Adding DB transport to Logger: ' + logger.getModuleName())
  }
  return logger
}

/**
 * Runtime fallback when LOG_DB is on but the log database is unusable: adds each module's
 * rotating file to every logger. No-op when LOG_FILES=false or file logging is already on.
 * Returns true when the fallback was enabled by this call.
 */
export function enableFileLoggingFallback(reason: string): boolean {
  if (LOGGING.filesDisabled || LOGGING.file || fileFallbackReason !== null) return false
  let enabled = false
  for (const logger of REGISTRY) {
    const transport = getModuleFileTransport(logger.getModuleName(), LOGGING)
    if (!transport) continue
    if (!logger.getTransports().includes(transport)) {
      logger.addTransport(transport)
    }
    logger.logger.level = moreVerboseLevel(logger.getLoggerLevel(), LOGGING.fileLevel)
    enabled = true
  }
  if (enabled) {
    fileFallbackReason = reason
    REGISTRY[0].warn(`Log DB unavailable (${reason}): writing logs to ${LOGGING.dir}`)
  }
  return enabled
}

/**
 * Last resort when the log DB is unusable and no file fallback is possible: loggers left
 * without any transport get the console back, with one warning. Returns true if it did.
 */
export function ensureLogOutput(reason: string): boolean {
  let forced = false
  for (const logger of REGISTRY) {
    const outputs = logger
      .getTransports()
      .filter((t) => !(t instanceof CustomOceanNodesTransport))
    if (outputs.length > 0) continue
    logger.addTransport(defaultConsoleTransport)
    forced = true
  }
  if (forced) {
    REGISTRY[0].warn(
      `Log DB unavailable (${reason}) and file logging is off: logging to console`
    )
  }
  return forced
}

// true when at least one module file of the configured directory is open and writable
export function isFileLoggingActive(): boolean {
  if (!LOGGING.file && fileFallbackReason === null) return false
  for (const [key, transport] of fileTransports) {
    if (transport && !transport.silent && path.dirname(key) === LOGGING.dir) return true
  }
  return false
}

export function getLoggingConfig(): Readonly<LoggingConfig> {
  return effectiveLoggingConfig()
}

// one line for the startup log
export function getLoggingSummary(): string {
  const consoleOn = REGISTRY.some((l) =>
    l.getTransports().includes(defaultConsoleTransport)
  )
  const files = isFileLoggingActive()
    ? `${LOGGING.dir} (${LOGGING.fileLevel}, ${LOGGING.retentionDays}d${
        fileFallbackReason !== null ? ', fallback' : ''
      })`
    : 'off'
  const db = USE_DB_TRANSPORT() && customDBTransport?.hasLogDatabase() ? 'on' : 'off'
  return `Logging: console=${consoleOn ? LOGGING.consoleLevel : 'off'}, files=${files}, db=${db}`
}

// ends one file transport; resolves when its stream is flushed (or on error)
export async function closeFileTransport(transport: DailyRotateFile): Promise<void> {
  if (!transport || closedTransports.has(transport)) return
  closedTransports.add(transport)
  // let log lines emitted in this tick reach the transport first
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise<void>((resolve) => {
    transport.once('finish', () => resolve())
    transport.logStream.once('error', () => resolve())
    try {
      transport.close()
    } catch {
      resolve()
    }
    // nothing may write to an ended stream
    transport.silent = true
  })
}

/**
 * Flushes and closes every log file (module files and exceptions). Call right before the
 * process exits; waits at most `ms`.
 */
export async function flushLogs(ms: number = 2000): Promise<void> {
  const open = (t: DailyRotateFile | null | undefined): t is DailyRotateFile =>
    !!t && !closedTransports.has(t)
  const moduleFiles = [...fileTransports.values()].filter(open)
  const exceptions = open(exceptionsTransport) ? exceptionsTransport : null
  if (moduleFiles.length === 0 && !exceptions) return
  let timer: NodeJS.Timeout
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms)
    timer.unref()
  })
  // the exceptions file goes last: on a crash winston exits as soon as it has finished,
  // which must not cut off the module files
  const flushAll = async () => {
    await Promise.all(moduleFiles.map(closeFileTransport))
    if (exceptions) await closeFileTransport(exceptions)
  }
  await Promise.race([flushAll(), timeout])
  clearTimeout(timer)
}
