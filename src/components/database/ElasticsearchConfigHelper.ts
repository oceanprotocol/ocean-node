import { Client } from '@elastic/elasticsearch'
import { OceanNodeDBConfig } from '../../@types'
import { DATABASE_LOGGER } from '../../utils/logging/common.js'
import { GENERIC_EMOJIS, LOG_LEVELS_STR } from '../../utils/logging/Logger.js'

export interface ElasticsearchRetryConfig {
  requestTimeout?: number
  pingTimeout?: number
  resurrectStrategy?: 'ping' | 'optimistic' | 'none'
  maxRetries?: number
  sniffOnStart?: boolean
  sniffInterval?: number | false
  sniffOnConnectionFault?: boolean
}

export const DEFAULT_ELASTICSEARCH_CONFIG: Required<ElasticsearchRetryConfig> = {
  requestTimeout: parseInt(process.env.ELASTICSEARCH_REQUEST_TIMEOUT || '60000'),
  pingTimeout: parseInt(process.env.ELASTICSEARCH_PING_TIMEOUT || '5000'),
  resurrectStrategy:
    (process.env.ELASTICSEARCH_RESURRECT_STRATEGY as 'ping' | 'optimistic' | 'none') ||
    'ping',
  maxRetries: parseInt(process.env.ELASTICSEARCH_MAX_RETRIES || '5'),
  sniffOnStart: process.env.ELASTICSEARCH_SNIFF_ON_START !== 'false',
  sniffInterval:
    process.env.ELASTICSEARCH_SNIFF_INTERVAL === 'false'
      ? false
      : parseInt(process.env.ELASTICSEARCH_SNIFF_INTERVAL || '30000'),
  sniffOnConnectionFault: process.env.ELASTICSEARCH_SNIFF_ON_CONNECTION_FAULT !== 'false'
}

class ElasticsearchClientSingleton {
  private static instance: any = null
  private client: Client | null = null
  private config: OceanNodeDBConfig | null = null
  private connectionAttempts: number = 0
  private lastConnectionTime: number = 0

  private constructor() {}

  public static getInstance(): ElasticsearchClientSingleton {
    if (!ElasticsearchClientSingleton.instance) {
      ElasticsearchClientSingleton.instance = new ElasticsearchClientSingleton()
    }
    return ElasticsearchClientSingleton.instance
  }

  public getClient(
    config: OceanNodeDBConfig,
    customConfig: Partial<ElasticsearchRetryConfig> = {}
  ): Client {
    if (this.client && this.config) {
      return this.client
    }

    return this.createNewConnection(config, customConfig)
  }

  private createNewConnection(
    config: OceanNodeDBConfig,
    customConfig: Partial<ElasticsearchRetryConfig> = {}
  ): Client {
    this.connectionAttempts++
    this.lastConnectionTime = Date.now()

    const finalConfig = {
      ...DEFAULT_ELASTICSEARCH_CONFIG,
      ...customConfig
    }

    try {
      this.client = new Client({
        node: config.url,
        auth:
          config.username && config.password
            ? { username: config.username, password: config.password }
            : undefined,
        requestTimeout: finalConfig.requestTimeout,
        pingTimeout: finalConfig.pingTimeout,
        resurrectStrategy: finalConfig.resurrectStrategy,
        maxRetries: finalConfig.maxRetries,
        sniffOnStart: finalConfig.sniffOnStart,
        sniffInterval: finalConfig.sniffInterval,
        sniffOnConnectionFault: finalConfig.sniffOnConnectionFault
      })

      this.config = { ...config }

      DATABASE_LOGGER.logMessageWithEmoji(
        `Elasticsearch connection established successfully to ${this.maskUrl(
          config.url
        )} (attempt ${this.connectionAttempts}/${
          finalConfig.maxRetries
        }) last successful connection ${this.lastConnectionTime}`,
        true,
        GENERIC_EMOJIS.EMOJI_CHECK_MARK,
        LOG_LEVELS_STR.LEVEL_INFO
      )

      return this.client
    } catch (error) {
      DATABASE_LOGGER.logMessageWithEmoji(
        `Failed to connect to Elasticsearch at ${this.maskUrl(config.url)} (attempt ${
          this.connectionAttempts
        }/${finalConfig.maxRetries}) last successful connection ${
          this.lastConnectionTime
        }: ${error.message}`,
        true,
        GENERIC_EMOJIS.EMOJI_CROSS_MARK,
        LOG_LEVELS_STR.LEVEL_ERROR
      )
      throw error
    }
  }

  private maskUrl(url: string): string {
    try {
      const urlObj = new URL(url)
      return `${urlObj.protocol}//${urlObj.hostname}:${
        urlObj.port || (urlObj.protocol === 'https:' ? '443' : '80')
      }`
    } catch (error) {
      return url.replace(/\/\/[^@]+@/, '//***:***@')
    }
  }
}

export function createElasticsearchClientWithRetry(
  config: OceanNodeDBConfig,
  customConfig: Partial<ElasticsearchRetryConfig> = {}
): Client {
  const singleton = ElasticsearchClientSingleton.getInstance()
  return singleton.getClient(config, customConfig)
}

export function getElasticsearchConfig(
  retryConfig: ElasticsearchRetryConfig = {}
): Required<ElasticsearchRetryConfig> {
  return {
    ...DEFAULT_ELASTICSEARCH_CONFIG,
    ...retryConfig
  }
}
