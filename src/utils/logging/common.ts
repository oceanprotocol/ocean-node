import {
  CustomNodeLogger,
  getCustomLoggerForModule,
  LOGGER_MODULE_NAMES
} from './Logger.js'

// TODO gather all the logger instances used here
// right now they are scatered all hover the place
// should keep Max 10
// 1
// Ocean Node
export const OCEAN_NODE_LOGGER: CustomNodeLogger = getCustomLoggerForModule(
  LOGGER_MODULE_NAMES.OCEAN_NODE
)
// 2
// Core stuff
export const CORE_LOGGER: CustomNodeLogger = getCustomLoggerForModule(
  LOGGER_MODULE_NAMES.CORE
)
// 3
// DB
export const DATABASE_LOGGER: CustomNodeLogger = getCustomLoggerForModule(
  LOGGER_MODULE_NAMES.DATABASE
)
// 4
// http
// use this logger instance on all HTTP related stuff
export const HTTP_LOGGER: CustomNodeLogger = getCustomLoggerForModule(
  LOGGER_MODULE_NAMES.HTTP
)
// 5
// indexer
export const INDEXER_LOGGER: CustomNodeLogger = getCustomLoggerForModule(
  LOGGER_MODULE_NAMES.INDEXER
)
// 6
// P2P
// just use the default logger with default transports
// Bellow is just an example usage, only logging to console here
export const P2P_LOGGER: CustomNodeLogger = getCustomLoggerForModule(
  LOGGER_MODULE_NAMES.P2P
)
// 7
// provider
// this should be actually part of provider, so lets put this as module name
export const PROVIDER_LOGGER: CustomNodeLogger = getCustomLoggerForModule(
  LOGGER_MODULE_NAMES.PROVIDER
)
// 8
// config
export const CONFIG_LOGGER: CustomNodeLogger = getCustomLoggerForModule(
  LOGGER_MODULE_NAMES.CONFIG
)
