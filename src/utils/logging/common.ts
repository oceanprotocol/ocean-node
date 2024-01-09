import {
  CustomNodeLogger,
  getCustomLoggerForModule,
  LOGGER_MODULE_NAMES,
  LOG_LEVELS_STR,
  defaultConsoleTransport
} from './Logger.js'

// TODO gather all the logger instances used here
// right now they are scatered all hover the place
// should keep Max 10
// 1
// Ocean Node
export const OCEAN_NODE_LOGGER: CustomNodeLogger = getCustomLoggerForModule(
  LOGGER_MODULE_NAMES.OCEAN_NODE,
  LOG_LEVELS_STR.LEVEL_INFO, // Info level
  defaultConsoleTransport // console only Transport
)
// 2
// DB , console only
export const DB_CONSOLE_LOGGER: CustomNodeLogger = getCustomLoggerForModule(
  LOGGER_MODULE_NAMES.DATABASE,
  LOG_LEVELS_STR.LEVEL_INFO,
  defaultConsoleTransport
)
// 3
// Status
export const STATUS_CONSOLE_LOGGER: CustomNodeLogger = getCustomLoggerForModule(
  LOGGER_MODULE_NAMES.CORE,
  LOG_LEVELS_STR.LEVEL_INFO,
  defaultConsoleTransport
)
// 4
// DB, console + db
export const DATABASE_LOGGER: CustomNodeLogger = getCustomLoggerForModule(
  LOGGER_MODULE_NAMES.DATABASE,
  LOG_LEVELS_STR.LEVEL_INFO,
  defaultConsoleTransport
)
// 5
// http
// use this logger instance on all HTTP related stuff
export const HTTP_LOGGER: CustomNodeLogger = getCustomLoggerForModule(
  LOGGER_MODULE_NAMES.HTTP,
  LOG_LEVELS_STR.LEVEL_INFO,
  defaultConsoleTransport
)
// 6
// indexer
export const INDEXER_LOGGER: CustomNodeLogger = getCustomLoggerForModule(
  LOGGER_MODULE_NAMES.INDEXER,
  LOG_LEVELS_STR.LEVEL_INFO,
  defaultConsoleTransport
)
// 7
// P2P
// just use the default logger with default transports
// Bellow is just an example usage, only logging to console here
export const P2P_CONSOLE_LOGGER: CustomNodeLogger = getCustomLoggerForModule(
  LOGGER_MODULE_NAMES.P2P,
  LOG_LEVELS_STR.LEVEL_INFO,
  defaultConsoleTransport
)
// 8
// provider
// this should be actually part of provider, so lets put this as module name
export const PROVIDER_LOGGER: CustomNodeLogger = getCustomLoggerForModule(
  LOGGER_MODULE_NAMES.PROVIDER,
  LOG_LEVELS_STR.LEVEL_INFO, // Info level
  defaultConsoleTransport // console only Transport
)
// 9
// config
export const CONFIG_CONSOLE_LOGGER: CustomNodeLogger = getCustomLoggerForModule(
  LOGGER_MODULE_NAMES.CONFIG,
  LOG_LEVELS_STR.LEVEL_INFO,
  defaultConsoleTransport
)
