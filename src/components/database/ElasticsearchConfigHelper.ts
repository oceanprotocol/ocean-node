import EventEmitter from 'node:events'
import { Client } from '@elastic/elasticsearch'
import { OceanNodeDBConfig } from '../../@types'
import { DATABASE_LOGGER } from '../../utils/logging/common.js'
import { GENERIC_EMOJIS, LOG_LEVELS_STR } from '../../utils/logging/Logger.js'
import { DB_TYPES } from '../../utils/constants.js'

export const DB_EVENTS = {
  CONNECTION_LOST: 'db:connection:lost',
  CONNECTION_RESTORED: 'db:connection:restored'
} as const
export const ES_CONNECTION_EVENTS = new EventEmitter()

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
  requestTimeout: parseInt(process.env.ELASTICSEARCH_REQUEST_TIMEOUT || '30000'),
  pingTimeout: parseInt(process.env.ELASTICSEARCH_PING_TIMEOUT || '3000'),
  resurrectStrategy:
    (process.env.ELASTICSEARCH_RESURRECT_STRATEGY as 'ping' | 'optimistic' | 'none') ||
    'ping',
  maxRetries: parseInt(process.env.ELASTICSEARCH_MAX_RETRIES || '3'),
  sniffOnStart: process.env.ELASTICSEARCH_SNIFF_ON_START === 'false',
  sniffInterval: process.env.ELASTICSEARCH_SNIFF_INTERVAL === 'true' ? 30000 : false,
  sniffOnConnectionFault: process.env.ELASTICSEARCH_SNIFF_ON_CONNECTION_FAULT !== 'false',
  healthCheckInterval: parseInt(
    process.env.ELASTICSEARCH_HEALTH_CHECK_INTERVAL || '15000'
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
  private connectionLostEmitted: boolean = false

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
      // Skip the extra ping here: 5 DB-class constructors all call getClient()
      // during reconnect reinit, and concurrent pings cause false errors that trigger another LOST/RESTORED cycle.
      if (this.isMonitoring) {
        return this.client
      }

      const isHealthy = await this.checkConnectionHealth()
      if (isHealthy) {
        this.startHealthMonitoring(config, customConfig)
        return this.client
      } else {
        DATABASE_LOGGER.logMessageWithEmoji(
          `Elasticsearch connection unhealthy at ${this.maskUrl(
            this.config.url
          )} - health monitoring will handle reconnection`,
          true,
          GENERIC_EMOJIS.EMOJI_CROSS_MARK,
          LOG_LEVELS_STR.LEVEL_WARN
        )
        this.startHealthMonitoring(config, customConfig)
        throw new Error('Elasticsearch connection is not healthy')
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
      `Starting Elasticsearch health monitoring (interval: ${finalConfig.healthCheckInterval}ms)`,
      true,
      GENERIC_EMOJIS.EMOJI_OCEAN_WAVE,
      LOG_LEVELS_STR.LEVEL_DEBUG
    )

    this.healthCheckTimer = setInterval(async () => {
      if (this.isRetrying) {
        return
      }

      const isHealthy = await this.checkConnectionHealth()
      if (!isHealthy) {
        if (this.client) {
          try {
            this.client.close()
          } catch {}
          this.client = null
          this.config = null
        }

        // Emit CONNECTION_LOST
        if (!this.connectionLostEmitted) {
          this.connectionLostEmitted = true
          DATABASE_LOGGER.logMessageWithEmoji(
            `Elasticsearch connection lost to ${this.maskUrl(
              config.url
            )} - starting reconnection attempts every ${finalConfig.healthCheckInterval}ms`,
            true,
            GENERIC_EMOJIS.EMOJI_CROSS_MARK,
            LOG_LEVELS_STR.LEVEL_WARN
          )
          ES_CONNECTION_EVENTS.emit(DB_EVENTS.CONNECTION_LOST)
        }

        // Single reconnection attempt
        this.isRetrying = true
        try {
          DATABASE_LOGGER.logMessageWithEmoji(
            `Attempting Elasticsearch reconnection to ${this.maskUrl(config.url)}`,
            true,
            GENERIC_EMOJIS.EMOJI_OCEAN_WAVE,
            LOG_LEVELS_STR.LEVEL_INFO
          )
          await this.createNewConnection(config, customConfig)
          this.isRetrying = false
          this.connectionLostEmitted = false
          DATABASE_LOGGER.logMessageWithEmoji(
            `Elasticsearch connection restored to ${this.maskUrl(config.url)}`,
            true,
            GENERIC_EMOJIS.EMOJI_CHECK_MARK,
            LOG_LEVELS_STR.LEVEL_INFO
          )
          ES_CONNECTION_EVENTS.emit(DB_EVENTS.CONNECTION_RESTORED)
        } catch {
          this.isRetrying = false
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

  private async checkConnectionHealth(): Promise<boolean> {
    if (!this.client) return false

    try {
      await this.client.ping()
      return true
    } catch (error) {
      DATABASE_LOGGER.logMessageWithEmoji(
        `Elasticsearch health check failed: ${error.message}`,
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
        )} (attempt ${this.connectionAttempts}) last successful connection ${this.lastConnectionTime}`,
        true,
        GENERIC_EMOJIS.EMOJI_CHECK_MARK,
        LOG_LEVELS_STR.LEVEL_INFO
      )

      return this.client
    } catch (error) {
      DATABASE_LOGGER.logMessageWithEmoji(
        `Failed to connect to Elasticsearch at ${this.maskUrl(config.url)} (attempt ${
          this.connectionAttempts
        }) last successful connection ${this.lastConnectionTime}: ${error.message}`,
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
    this.connectionLostEmitted = false
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
