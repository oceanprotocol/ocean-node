import winston, { Logger, LogEntry } from 'winston'
import Transport, { TransportStreamOptions } from 'winston-transport'
import DailyRotateFile from 'winston-daily-rotate-file'
import fs from 'fs'
import { Typesense } from '../../components/database/typesense'
import { TypesenseConfigOptions } from '../../@types'
import { Database } from '../../components/database/index.js'

// all the types of modules/components
export const LOGGER_MODULE_NAMES = {
  HTTP: 'http',
  P2P: 'p2p',
  INDEXER: 'indexer',
  PROVIDER: 'provider',
  DATABASE: 'database',
  CONFIG: 'config',
  ALL_COMBINED: 'all'
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
  LEVEl_ERROR: 'error',
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
  EMOJI_CROSS_MARK: '\u{274C}'
}

export function getLoggerLevelEmoji(level: string): string {
  const emoji = LOG_LEVELS_EMOJI[level as keyof typeof LOG_LEVELS_EMOJI]
  if (!emoji) {
    return '\u{1F680}' // rocket emoji
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

// if not set, then gets default 'development' level & colors
export const isDevelopment = (): boolean => {
  const env = process.env.NODE_ENV || 'development'
  return env.toLowerCase().startsWith('dev')
}

export const getDefaultLevel = (): string => {
  return isDevelopment() ? 'debug' : 'info'
}

if (isDevelopment()) {
  winston.addColors(LOG_COLORS)
}

export const format: winston.Logform.Format = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.printf(
    (info: any) => `${info.timestamp} ${info.level}: ${info.message}`
  ),
  winston.format.prettyPrint()
)

export const consoleColorFormatting: winston.Logform.Format | Record<string, any> =
  isDevelopment()
    ? { format: winston.format.combine(format, winston.format.colorize({ all: true })) }
    : {}

// ex: we caa also have a simpler format for console only
// format: winston.format.combine(
//     winston.format.colorize(),
//     winston.format.simple()
//   )

// combine different transports of the same type in one transport
export const developmentTransports: winston.transports.FileTransportInstance[] =
  isDevelopment()
    ? [
        new winston.transports.File({
          filename: 'error.log',
          dirname: 'logs/',
          level: 'error',
          handleExceptions: true
        }),

        new winston.transports.File({
          filename: 'all.log',
          dirname: 'logs/',
          handleExceptions: true
          // we can also set a custom
          // format: winston.format.json()
        })
      ]
    : []

export const defaultConsoleTransport = new winston.transports.Console({
  ...consoleColorFormatting
})

export const defaultTransports: (
  | winston.transports.FileTransportInstance
  | winston.transports.ConsoleTransportInstance
)[] = [...developmentTransports, defaultConsoleTransport]

function getDefaultOptions(): winston.LoggerOptions {
  return {
    level: getDefaultLevel(),
    levels: LOG_LEVELS_NUM,
    format,
    transports: defaultTransports,
    exceptionHandlers: [
      new winston.transports.File({ dirname: 'logs/', filename: EXCEPTIONS_HANDLER })
    ]
  }
}

export function buildDefaultLogger(): Logger {
  const logger: winston.Logger = winston.createLogger(getDefaultOptions())

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
    if (!options) {
      this.logger = buildDefaultLogger()
      this.loggerOptions = {
        ...getDefaultOptions(),
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

  // wrapper function for logging with custom logger
  log(
    level: string = LOG_LEVELS_STR.LEVEL_INFO,
    message: string,
    includeModuleName: boolean = false
  ) {
    this.getLogger().log(level, includeModuleName ? this.buildMessage(message) : message)
  }

  logMessage(message: string, includeModuleName: boolean = false) {
    const level = this.getLoggerLevel() || getDefaultLevel()
    this.getLogger().log(level, includeModuleName ? this.buildMessage(message) : message)
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

    this.getLogger().log(level, msg)
  }

  // prefix the message with the module/component name (optional)
  buildMessage(message: string) {
    const cpName = this.getModuleName()
    if (cpName) {
      message = '[' + cpName.toUpperCase() + '] => ' + message
    }

    return message
  }
}

// kind of a factory function for different modules/components
export function getCustomLoggerForModule(
  moduleOrComponentName?: string,
  logLevel?: string,
  loggerTransports?: winston.transport | winston.transport[]
): CustomNodeLogger {
  if (!moduleOrComponentName) {
    moduleOrComponentName = LOGGER_MODULE_NAMES.ALL_COMBINED
  }

  const logger: CustomNodeLogger = new CustomNodeLogger(
    /* pass any custom options here */ {
      level: logLevel || LOG_LEVELS_STR.LEVEL_HTTP,
      levels: LOG_LEVELS_NUM,
      moduleName: moduleOrComponentName,
      defaultMeta: { component: moduleOrComponentName.toUpperCase() },
      transports: loggerTransports || [
        buildCustomFileTransport(moduleOrComponentName),
        defaultConsoleTransport
      ],
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
      timestamp: new Date().toISOString(), // Storing the current timestamp as a string
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
