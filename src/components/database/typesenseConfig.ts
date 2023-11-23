import {
  TypesenseAbstractLogger,
  TypesenseConfigOptions,
  TypesenseNode
} from '../../@types'

/**
 * TypesenseConfig class is used to specify configuration parameters for Typesense
 * as well as handling optional cases
 */
export class TypesenseConfig {
  apiKey: string
  nodes: TypesenseNode[]
  numRetries: number
  retryIntervalSeconds: number
  connectionTimeoutSeconds: number
  logLevel: string
  logger: TypesenseAbstractLogger

  constructor(options: TypesenseConfigOptions) {
    this.apiKey = options.apiKey
    this.nodes = options.nodes || []
    this.numRetries = options.numRetries || 3
    this.connectionTimeoutSeconds = options.connectionTimeoutSeconds || 5
    this.retryIntervalSeconds = options.retryIntervalSeconds || 0.1
    this.logLevel = options.logLevel || 'debug'
    this.logger = options.logger || { debug: (log: any) => console.log(log) }
  }
}
