import winston, { Logger, LogEntry } from 'winston'
import Transport from 'winston-transport'
import DailyRotateFile from 'winston-daily-rotate-file'
import fs from 'fs'
import { Database } from '../../components/database/index.js'

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

// we can setup custom exceptionHandlers as part of initial config options
// exceptionHandlers: [
//     new transports.File({ filename: 'exceptions.log' })
//   ]
// OR enable it later
// Call exceptions.handle with a transport to handle exceptions
// logger.exceptions.handle(
//     new transports.File({ filename: 'exceptions.log' })
//   );
const EXCEPTIONS_HANDLER = 'exceptions.log'

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
  info: 'green',
  debug: 'white',
  http: 'magenta'
}

// for a custom logger transport
interface CustomOceanNodesTransportOptions extends Transport.TransportStreamOptions {
  dbInstance: Database
  collectionName?: string
  moduleName?: string
}

export class CustomOceanNodesTransport extends Transport {
  private dbInstance: Database

  constructor(options: CustomOceanNodesTransportOptions) {
    super(options)
    this.dbInstance = options.dbInstance
  }

  async log(info: LogEntry, callback: () => void): Promise<void> {
    setImmediate(() => {
      this.emit('logged', info)
    })

    // Prepare the document to be logged
    const document = {
      level: info.level,
      message: info.message,
      moduleName: info.moduleName || 'undefined',
      timestamp: Date.now(), // Storing the current timestamp as a Unix epoch timestamp (number)
      meta: JSON.stringify(info.meta) // Ensure meta is a string
    }

    try {
      // Use the insertLog method of the LogDatabase instance
      await this.dbInstance.logs.insertLog(document)
    } catch (error) {
      // Handle the error according to your needs
      console.error('Error writing to Typesense:', error)
      // Implement retry logic or other error handling as needed
    }

    callback()
  }
}

let INSTANCE_COUNT = 0
let customDBTransport: CustomOceanNodesTransport = null

export const MAX_LOGGER_INSTANCES = 10
export const NUM_LOGGER_INSTANCES = INSTANCE_COUNT

// if not set, then gets default 'development' level & colors
export function isDevelopmentEnvironment(): boolean {
  const env = process.env.NODE_ENV || 'development'
  return env === 'development'
}

export const getDefaultLevel = (): string => {
  return isDevelopmentEnvironment() ? 'debug' : 'info'
}

if (isDevelopmentEnvironment()) {
  winston.addColors(LOG_COLORS)
}

const format: winston.Logform.Format = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.printf(
    (info: any) => `${info.timestamp} ${info.level}: ${info.message}`
  ),
  winston.format.prettyPrint()
)

const consoleColorFormatting: winston.Logform.Format | Record<string, any> = {
  format: winston.format.combine(format, winston.format.colorize({ all: true }))
}

// ex: we caa also have a simpler format for console only
// format: winston.format.combine(
//     winston.format.colorize(),
//     winston.format.simple()
//   )

export const defaultConsoleTransport = new winston.transports.Console({
  ...consoleColorFormatting
})

function getDefaultOptions(moduleName: string): winston.LoggerOptions {
  const defaultOpts: winston.LoggerOptions = {
    level: getDefaultLevel(),
    levels: LOG_LEVELS_NUM,
    format,
    transports: [buildCustomFileTransport(moduleName), defaultConsoleTransport],
    exceptionHandlers: [
      new winston.transports.File({ dirname: 'logs/', filename: EXCEPTIONS_HANDLER })
    ]
  }
  return defaultOpts
}

export function buildDefaultLogger(): Logger {
  const logger: winston.Logger = winston.createLogger(
    getDefaultOptions(LOGGER_MODULE_NAMES.ALL_COMBINED)
  )
  INSTANCE_COUNT++
  return logger
}

export interface CustomNodeLoggerOptions extends winston.LoggerOptions {
  moduleName: string // one of LOGGER_MODULE_NAMES
}

/**
 * options example:
 * {
        filename: 'error.log',
        dirname: 'logs/',
        level: 'error',
        handleExceptions: true
  },
 * 
 * @param options 
 * @returns 
 */
export function buildCustomFileTransport(
  moduleName: string,
  options?: winston.transports.FileTransportOptions
): winston.transports.FileTransportInstance {
  if (!moduleName) {
    moduleName = LOGGER_MODULE_NAMES.ALL_COMBINED
  }

  if (!options) {
    options = {
      filename: moduleName + '.log',
      dirname: 'logs/',
      level: getDefaultLevel(),
      handleExceptions: true
    }
  }

  return new winston.transports.File({
    ...options
  })
}

export function getDefaultLoggerTransports(
  moduleOrComponentName: string
): winston.transport[] {
  // always log to file
  const transports: winston.transport[] = [
    buildCustomFileTransport(moduleOrComponentName)
  ]
  // only log to console if development
  if (isDevelopmentEnvironment()) {
    transports.push(defaultConsoleTransport)
  }
  return transports
}

/**
 *
 * @param moduleName
 * @param options
 * options are:
 * stream: any Node.js stream. If an objectMode stream is provided then the entire info object will be written.
 * Otherwise info[MESSAGE] will be written.
 * level: Level of messages that this transport should log (default: level set on parent logger).
 * silent: Boolean flag indicating whether to suppress output (default false).
 * eol: Line-ending character to use. (default: os.EOL).
 * @returns
 */
export function buildCustomStreamTransport(
  options?: winston.transports.StreamTransportOptions
): winston.transports.StreamTransportInstance {
  if (!options) {
    options = {
      stream: fs.createWriteStream('/dev/null'),
      level: getDefaultLevel(),
      handleExceptions: true
    }
  }

  return new winston.transports.Stream({
    ...options
  })
}

/**
 * Example to build a daily rotate file
 * We can use it on the initials transports config, or add it later with 'addTransport()' method bellow
 * In this case it will zip the archived files
 * The max file size is 20Mb and it will keep the logs for 14 days
 * More here:
 * https://www.npmjs.com/package/winston-daily-rotate-file
 * @param moduleName
 * @param zippedArchive
 * @param maxSize
 * @param maxFiles
 * @returns
 */
export function buildDailyRotateFile(
  moduleName: string,
  zippedArchive: boolean = true,
  maxSize: string = '20m', // 20 Mb by default
  maxFiles: string = '14d' // 14 days by deafult
): winston.transport {
  const transport: DailyRotateFile = new DailyRotateFile({
    filename: moduleName + '-%DATE%.log',
    datePattern: 'YYYY-MM-DD-HH',
    dirname: 'logs/',
    zippedArchive,
    maxSize,
    maxFiles,
    extension: '.log'
  })

  return transport
}

/**
 * Customize the logger options
 */
export class CustomNodeLogger {
  // safe a ref to the logger
  logger: winston.Logger
  // save a ref to options
  loggerOptions: CustomNodeLoggerOptions

  constructor(options?: CustomNodeLoggerOptions) {
    INSTANCE_COUNT++

    if (INSTANCE_COUNT === MAX_LOGGER_INSTANCES) {
      // after 10 instances we get warnings about possible memory leaks
      this.logger.warn(
        `You already have ${INSTANCE_COUNT} instances of Logger. Please consider reusing some of them!`
      )
    } else if (INSTANCE_COUNT > MAX_LOGGER_INSTANCES) {
      INSTANCE_COUNT--
      throw new Error(
        `You have reached the maximum number of Logger instances considered safe (${MAX_LOGGER_INSTANCES}). Please consider reusing some of them!`
      )
    }
    if (!options) {
      this.logger = buildDefaultLogger()
      this.loggerOptions = {
        ...getDefaultOptions(LOGGER_MODULE_NAMES.ALL_COMBINED),
        moduleName: LOGGER_MODULE_NAMES.ALL_COMBINED
      }
      this.logger.log(
        LOG_LEVELS_STR.LEVEL_INFO,
        'Info! Calling CustomNodeLogger without any logger options, will just use defaults...'
      )
    } else {
      this.logger = winston.createLogger({ ...options })
      this.loggerOptions = options
    }
  }

  removeTransport(winston: Transport) {
    this.logger.remove(winston)
  }

  addTransport(winston: Transport) {
    this.logger.add(winston)
  }

  getTransports(): Array<Transport> {
    return this.logger.transports
  }

  hasDBTransports(): boolean {
    const dbTransports: Array<Transport> = this.logger.transports.filter(
      (transport: winston.transport) => {
        return transport instanceof CustomOceanNodesTransport
      }
    )
    return dbTransports.length > 0
  }

  getLogger(): winston.Logger {
    return this.logger
  }

  // should correspond also to filename when logging to a file
  getModuleName(): string {
    return this.loggerOptions.moduleName
  }

  getLoggerLevel(): string {
    return this.loggerOptions.level
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
    // lazy check db custom transport, needed beacause of dependency cycles
    if (
      customDBTransport !== null && // if null then what?
      !isDevelopmentEnvironment() &&
      !this.hasDBTransport()
    ) {
      this.addTransport(customDBTransport)
    }

    this.getLogger().log(
      level,
      includeModuleName ? this.buildMessage(message) : message,
      { moduleName: this.getModuleName().toUpperCase() }
    )
  }

  logMessage(message: string, includeModuleName: boolean = false) {
    const level = this.getLoggerLevel() || getDefaultLevel()
    this.log(
      level,
      includeModuleName ? this.buildMessage(message) : message,
      includeModuleName
    )
  }

  // supports emoji :-)? Experimental, might not work properly on some transports
  // Usage:
  // logger.logMessageWithEmoji(`HTTP port: ${config.httpPort}`, true, GENERIC_EMOJIS.EMOJI_CHECK_MARK);
  // logger.logMessageWithEmoji(`HTTP port: ${config.httpPort}`, true, );
  logMessageWithEmoji(
    message: string,
    includeModuleName: boolean = false,
    emoji?: string,
    level?: string
  ) {
    if (!level) level = this.getLoggerLevel() || getDefaultLevel()

    let msg = includeModuleName ? this.buildMessage(message) : message

    if (emoji) {
      msg = emoji.concat(' ').concat(msg)
    } else {
      msg = getLoggerLevelEmoji(this.getLoggerLevel()).concat(' ').concat(msg)
    }

    this.log(level, msg, includeModuleName)
  }

  // prefix the message with the module/component name (optional)
  buildMessage(message: string) {
    const cpName = this.getModuleName()
    if (cpName) {
      message = '[' + cpName.toUpperCase() + '] => ' + message
    }

    return message
  }

  hasDBTransport(): boolean {
    const transports: winston.transport[] = this.getTransports().filter(
      (transport: winston.transport) => {
        return transport instanceof CustomOceanNodesTransport
      }
    )
    return transports.length > 0
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

  const logger: CustomNodeLogger = new CustomNodeLogger(
    /* pass any custom options here */ {
      level: logLevel || LOG_LEVELS_STR.LEVEL_INFO,
      levels: LOG_LEVELS_NUM,
      moduleName: moduleOrComponentName,
      defaultMeta: { component: moduleOrComponentName.toUpperCase() },
      transports: getDefaultLoggerTransports(moduleOrComponentName),
      exceptionHandlers: [
        new winston.transports.File({
          dirname: 'logs/',
          filename: moduleOrComponentName + '_' + EXCEPTIONS_HANDLER
        })
      ]
    }
  )

  return logger
}

export function configureCustomDBTransport(
  dbConnection: Database,
  logger: CustomNodeLogger
) {
  if (!customDBTransport) {
    customDBTransport = new CustomOceanNodesTransport({ dbInstance: dbConnection })
  }
  logger.addTransport(customDBTransport)
  return logger
}
