import { Client } from '@elastic/elasticsearch'
import { OceanNodeDBConfig } from '../../@types'
import { DATABASE_LOGGER } from '../../utils/logging/common.js'
import { GENERIC_EMOJIS, LOG_LEVELS_STR } from '../../utils/logging/Logger.js'
import { DB_TYPES } from '../../utils/constants.js'

export interface ElasticsearchRetryConfig {
  requestTimeout?: number
  pingTimeout?: number
  resurrectStrategy?: 'ping' | 'optimistic' | 'none'
  maxRetries?: number
  sniffOnStart?: boolean
  sniffInterval?: number | false
  sniffOnConnectionFault?: boolean
  healthCheckInterval?: number
}

export const DEFAULT_ELASTICSEARCH_CONFIG: Required<ElasticsearchRetryConfig> = {
  requestTimeout: parseInt(process.env.ELASTICSEARCH_REQUEST_TIMEOUT || '60000'),
  pingTimeout: parseInt(process.env.ELASTICSEARCH_PING_TIMEOUT || '5000'),
  resurrectStrategy:
    (process.env.ELASTICSEARCH_RESURRECT_STRATEGY as 'ping' | 'optimistic' | 'none') ||
    'ping',
  maxRetries: parseInt(process.env.ELASTICSEARCH_MAX_RETRIES || '5'),
  sniffOnStart: false,
  sniffInterval:
    process.env.ELASTICSEARCH_SNIFF_INTERVAL === 'false'
      ? false
      : parseInt(process.env.ELASTICSEARCH_SNIFF_INTERVAL || '30000'),
  sniffOnConnectionFault: process.env.ELASTICSEARCH_SNIFF_ON_CONNECTION_FAULT !== 'false',
  healthCheckInterval: parseInt(
    process.env.ELASTICSEARCH_HEALTH_CHECK_INTERVAL || '60000'
  )
}

class ElasticsearchClientSingleton {
  private static instance: any = null
  private client: Client | null = null
  private config: OceanNodeDBConfig | null = null
  private connectionAttempts: number = 0
  private lastConnectionTime: number = 0
  private isRetrying: boolean = false
  private healthCheckTimer: NodeJS.Timeout | null = null
  private isMonitoring: boolean = false

  private constructor() {}

  public static getInstance(): ElasticsearchClientSingleton {
    if (!ElasticsearchClientSingleton.instance) {
      ElasticsearchClientSingleton.instance = new ElasticsearchClientSingleton()
    }
    return ElasticsearchClientSingleton.instance
  }

  private isElasticsearchDatabase(config: OceanNodeDBConfig): boolean {
    return config.dbType === DB_TYPES.ELASTIC_SEARCH
  }

  public async getClient(
    config: OceanNodeDBConfig,
    customConfig: Partial<ElasticsearchRetryConfig> = {}
  ): Promise<Client> {
    if (!this.isElasticsearchDatabase(config)) {
      DATABASE_LOGGER.logMessageWithEmoji(
        `Skipping Elasticsearch connection - database type is set to '${
          config.dbType || 'unknown'
        }', not '${DB_TYPES.ELASTIC_SEARCH}'`,
        true,
        GENERIC_EMOJIS.EMOJI_OCEAN_WAVE,
        LOG_LEVELS_STR.LEVEL_DEBUG
      )
      throw new Error(`Database type '${config.dbType}' is not Elasticsearch`)
    }

    if (this.client && this.config) {
      const isHealthy = await this.checkConnectionHealth()
      if (isHealthy) {
        this.startHealthMonitoring(config, customConfig)
        return this.client
      } else {
        DATABASE_LOGGER.logMessageWithEmoji(
          `Elasticsearch connection interrupted or failed to ${this.maskUrl(
            this.config.url
          )} - starting retry phase`,
          true,
          GENERIC_EMOJIS.EMOJI_CROSS_MARK,
          LOG_LEVELS_STR.LEVEL_WARN
        )
        this.closeConnectionSync()
        return this.startRetryConnection(config, customConfig)
      }
    }

    const client = await this.createNewConnection(config, customConfig)
    this.startHealthMonitoring(config, customConfig)
    return client
  }

  private startHealthMonitoring(
    config: OceanNodeDBConfig,
    customConfig: Partial<ElasticsearchRetryConfig> = {}
  ): void {
    if (this.isMonitoring || !this.client || !this.isElasticsearchDatabase(config)) return

    const finalConfig = {
      ...DEFAULT_ELASTICSEARCH_CONFIG,
      ...customConfig
    }

    this.isMonitoring = true
    DATABASE_LOGGER.logMessageWithEmoji(
      `Starting Elasticsearch connection monitoring (health check every ${finalConfig.healthCheckInterval}ms)`,
      true,
      GENERIC_EMOJIS.EMOJI_OCEAN_WAVE,
      LOG_LEVELS_STR.LEVEL_DEBUG
    )

    this.healthCheckTimer = setInterval(async () => {
      if (this.client && !this.isRetrying) {
        const isHealthy = await this.checkConnectionHealth()
        if (!isHealthy) {
          DATABASE_LOGGER.logMessageWithEmoji(
            `Elasticsearch connection lost during monitoring - triggering automatic reconnection`,
            true,
            GENERIC_EMOJIS.EMOJI_CROSS_MARK,
            LOG_LEVELS_STR.LEVEL_WARN
          )
          this.closeConnectionSync()
          try {
            await this.startRetryConnection(config, customConfig)
          } catch (error) {
            DATABASE_LOGGER.logMessageWithEmoji(
              `Automatic reconnection failed: ${error.message}`,
              true,
              GENERIC_EMOJIS.EMOJI_CROSS_MARK,
              LOG_LEVELS_STR.LEVEL_ERROR
            )
          }
        }
      }
    }, finalConfig.healthCheckInterval)
  }

  private stopHealthMonitoring(): void {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer)
      this.healthCheckTimer = null
      this.isMonitoring = false
      DATABASE_LOGGER.logMessageWithEmoji(
        `Stopped Elasticsearch connection monitoring`,
        true,
        GENERIC_EMOJIS.EMOJI_OCEAN_WAVE,
        LOG_LEVELS_STR.LEVEL_DEBUG
      )
    }
  }

  private async startRetryConnection(
    config: OceanNodeDBConfig,
    customConfig: Partial<ElasticsearchRetryConfig> = {}
  ): Promise<Client> {
    if (!this.isElasticsearchDatabase(config)) {
      throw new Error(`Database type '${config.dbType}' is not Elasticsearch`)
    }

    this.isRetrying = true
    const finalConfig = {
      ...DEFAULT_ELASTICSEARCH_CONFIG,
      ...customConfig
    }

    DATABASE_LOGGER.logMessageWithEmoji(
      `Starting Elasticsearch retry connection phase to ${this.maskUrl(
        config.url
      )} (max retries: ${finalConfig.maxRetries})`,
      true,
      GENERIC_EMOJIS.EMOJI_OCEAN_WAVE,
      LOG_LEVELS_STR.LEVEL_INFO
    )

    for (let attempt = 1; attempt <= finalConfig.maxRetries; attempt++) {
      try {
        DATABASE_LOGGER.logMessageWithEmoji(
          `Elasticsearch reconnection attempt ${attempt}/${
            finalConfig.maxRetries
          } to ${this.maskUrl(config.url)}`,
          true,
          GENERIC_EMOJIS.EMOJI_OCEAN_WAVE,
          LOG_LEVELS_STR.LEVEL_INFO
        )

        const client = await this.createNewConnection(config, customConfig)
        this.isRetrying = false
        return client
      } catch (error) {
        if (attempt === finalConfig.maxRetries) {
          this.isRetrying = false
          DATABASE_LOGGER.logMessageWithEmoji(
            `Elasticsearch retry connection failed after ${
              finalConfig.maxRetries
            } attempts to ${this.maskUrl(config.url)}: ${error.message}`,
            true,
            GENERIC_EMOJIS.EMOJI_CROSS_MARK,
            LOG_LEVELS_STR.LEVEL_ERROR
          )
          throw error
        }

        const delay = Math.min(1000 * Math.pow(2, attempt - 1), 30000)
        DATABASE_LOGGER.logMessageWithEmoji(
          `Elasticsearch retry attempt ${attempt}/${finalConfig.maxRetries} failed, waiting ${delay}ms before next attempt: ${error.message}`,
          true,
          GENERIC_EMOJIS.EMOJI_CROSS_MARK,
          LOG_LEVELS_STR.LEVEL_WARN
        )
        await new Promise((resolve) => setTimeout(resolve, delay))
      }
    }

    throw new Error('Maximum retry attempts reached')
  }

  private async checkConnectionHealth(): Promise<boolean> {
    if (!this.client) return false

    try {
      await this.client.ping()
      return true
    } catch (error) {
      DATABASE_LOGGER.logMessageWithEmoji(
        `Elasticsearch connection health check failed: ${error.message}`,
        true,
        GENERIC_EMOJIS.EMOJI_CROSS_MARK,
        LOG_LEVELS_STR.LEVEL_DEBUG
      )
      return false
    }
  }

  private async createNewConnection(
    config: OceanNodeDBConfig,
    customConfig: Partial<ElasticsearchRetryConfig> = {}
  ): Promise<Client> {
    if (!this.isElasticsearchDatabase(config)) {
      throw new Error(`Database type '${config.dbType}' is not Elasticsearch`)
    }

    this.connectionAttempts++
    this.lastConnectionTime = Date.now()

    const finalConfig = {
      ...DEFAULT_ELASTICSEARCH_CONFIG,
      ...customConfig
    }

    try {
      const client = new Client({
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

      await client.ping()

      this.client = client
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

  private closeConnectionSync(): void {
    this.stopHealthMonitoring()
    if (this.client) {
      try {
        this.client.close()
      } catch (error) {
        // silent close, no logging needed
      }
      this.client = null
      this.config = null
    }
  }

  public getConnectionStats(): {
    attempts: number
    lastConnection: number
    connected: boolean
    isRetrying: boolean
    isMonitoring: boolean
  } {
    return {
      attempts: this.connectionAttempts,
      lastConnection: this.lastConnectionTime,
      connected: this.client !== null,
      isRetrying: this.isRetrying,
      isMonitoring: this.isMonitoring
    }
  }
}

export async function createElasticsearchClientWithRetry(
  config: OceanNodeDBConfig,
  customConfig: Partial<ElasticsearchRetryConfig> = {}
): Promise<Client> {
  const singleton = ElasticsearchClientSingleton.getInstance()
  return await singleton.getClient(config, customConfig)
}

export function getElasticsearchConfig(
  retryConfig: ElasticsearchRetryConfig = {}
): Required<ElasticsearchRetryConfig> {
  return {
    ...DEFAULT_ELASTICSEARCH_CONFIG,
    ...retryConfig
  }
}

export function getElasticsearchConnectionStats(): {
  attempts: number
  lastConnection: number
  connected: boolean
  isRetrying: boolean
  isMonitoring: boolean
} {
  const singleton = ElasticsearchClientSingleton.getInstance()
  return singleton.getConnectionStats()
}
