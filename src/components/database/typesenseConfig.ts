import { TypesenseConfigOptions, TypesenseNode } from '../../@types'
import winston, { Logger } from 'winston'

export class TypesenseConfig {
  apiKey: string
  nodes: TypesenseNode[]
  numRetries: number
  retryIntervalSeconds: number
  connectionTimeoutSeconds: number
  logLevel: string
  logger: Logger

  constructor(options: TypesenseConfigOptions) {
    this.apiKey = options.apiKey
    this.nodes = options.nodes || []
    this.numRetries = options.numRetries || 3
    this.connectionTimeoutSeconds = options.connectionTimeoutSeconds || 5
    this.retryIntervalSeconds = options.retryIntervalSeconds || 0.1
    this.logLevel = options.logLevel || 'debug'
    this.logger =
      options.logger ||
      winston.createLogger({
        level: this.logLevel,
        format: winston.format.prettyPrint(),
        transports: [new winston.transports.Console()]
      })
  }
}
