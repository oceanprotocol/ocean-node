import EventEmitter from 'node:events'
import { Client, estypes } from '@elastic/elasticsearch'
import { OceanNodeDBConfig } from '../../@types'
import { DATABASE_LOGGER } from '../../utils/logging/common.js'
import { LOG_LEVELS_STR } from '../../utils/logging/Logger.js'
import { ElasticsearchSchema } from './ElasticSchemas.js'

export const DB_EVENTS = {
  CONNECTION_LOST: 'db:connection:lost',
  CONNECTION_RESTORED: 'db:connection:restored'
} as const
export const ES_CONNECTION_EVENTS = new EventEmitter()
const ES_CONNECT_FAILED_KEY = 'es-connect-failed'

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
  sniffOnStart: process.env.ELASTICSEARCH_SNIFF_ON_START !== 'false',
  sniffInterval:
    process.env.ELASTICSEARCH_SNIFF_INTERVAL === 'false'
      ? false
      : parseInt(process.env.ELASTICSEARCH_SNIFF_INTERVAL || '30000', 10) || 30000,
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

  public async getClient(
    config: OceanNodeDBConfig,
    customConfig: Partial<ElasticsearchRetryConfig> = {}
  ): Promise<Client> {
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
        DATABASE_LOGGER.warn(
          `Elasticsearch connection unhealthy at ${this.maskUrl(this.config.url)} - health monitoring will handle reconnection`
        )
        this.startHealthMonitoring(config, customConfig)
        throw new Error('Elasticsearch connection is not healthy')
      }
    }

    // The health monitor is the only reconnect path while it runs: its reconnect resets
    // connectionLostEmitted and emits CONNECTION_RESTORED, which restarts the indexers. A
    // reconnect from a store call would skip both, so store calls fail fast here instead.
    if (this.isMonitoring) {
      throw new Error('Elasticsearch connection not available (reconnecting)')
    }

    const client = await this.createNewConnection(config, customConfig)
    this.startHealthMonitoring(config, customConfig)
    return client
  }

  private startHealthMonitoring(
    config: OceanNodeDBConfig,
    customConfig: Partial<ElasticsearchRetryConfig> = {}
  ): void {
    if (this.isMonitoring || !this.client) return

    const finalConfig = {
      ...DEFAULT_ELASTICSEARCH_CONFIG,
      ...customConfig
    }

    this.isMonitoring = true
    DATABASE_LOGGER.debug(
      `Starting Elasticsearch health monitoring (interval: ${finalConfig.healthCheckInterval}ms)`
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
          } catch (err) {
            DATABASE_LOGGER.error(
              `Error closing Elasticsearch client during health check: ${err instanceof Error ? err.message : String(err)}`
            )
          }
          this.client = null
          this.config = null
        }

        // Emit CONNECTION_LOST
        if (!this.connectionLostEmitted) {
          this.connectionLostEmitted = true
          DATABASE_LOGGER.warn(
            `Elasticsearch connection lost to ${this.maskUrl(config.url)} - starting reconnection attempts every ${finalConfig.healthCheckInterval}ms`
          )
          ES_CONNECTION_EVENTS.emit(DB_EVENTS.CONNECTION_LOST)
        }

        // Single reconnection attempt
        this.isRetrying = true
        try {
          DATABASE_LOGGER.debug(
            `Attempting Elasticsearch reconnection to ${this.maskUrl(config.url)}`
          )
          await this.createNewConnection(config, customConfig)
          this.isRetrying = false
          this.connectionLostEmitted = false
          DATABASE_LOGGER.info(
            `Elasticsearch connection restored to ${this.maskUrl(config.url)}`
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
      DATABASE_LOGGER.debug(`Stopped Elasticsearch connection monitoring`)
    }
  }

  private async checkConnectionHealth(): Promise<boolean> {
    if (!this.client) return false

    try {
      await this.client.ping()
      return true
    } catch (error) {
      DATABASE_LOGGER.error(`Elasticsearch health check failed: ${error.message}`)
      return false
    }
  }

  private async createNewConnection(
    config: OceanNodeDBConfig,
    customConfig: Partial<ElasticsearchRetryConfig> = {}
  ): Promise<Client> {
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

      DATABASE_LOGGER.resetThrottle(ES_CONNECT_FAILED_KEY)
      DATABASE_LOGGER.info(`Connected to Elasticsearch at ${this.maskUrl(config.url)}`)

      return this.client
    } catch (error) {
      // fires every health-check interval during an outage
      DATABASE_LOGGER.throttled(
        ES_CONNECT_FAILED_KEY,
        LOG_LEVELS_STR.LEVEL_ERROR,
        `Failed to connect to Elasticsearch at ${this.maskUrl(config.url)} (attempt ${this.connectionAttempts}): ${error.message}`
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

// creates the index with its mappings when it does not exist yet; throws on failure
export async function ensureIndex(
  config: OceanNodeDBConfig,
  schema: ElasticsearchSchema
): Promise<void> {
  const client = await createElasticsearchClientWithRetry(config)
  if (await client.indices.exists({ index: schema.index })) return
  try {
    await client.indices.create({ index: schema.index, body: schema.body as any })
  } catch (error) {
    // another instance created it between the two calls
    if (error?.meta?.body?.error?.type === 'resource_already_exists_exception') return
    throw error
  }
}

// Elasticsearch's default result window: one search returns at most this many hits
export const SEARCH_PAGE_SIZE = 10000

// Reads every match, page by page, on a point in time. For internal scans that must see all
// documents; a plain search stops at SEARCH_PAGE_SIZE hits.
export async function searchAllPages<T>(
  client: Client,
  request: Pick<estypes.SearchRequest, 'index' | 'query' | '_source'> & {
    sort?: estypes.SortCombinations[]
  },
  pageSize: number = SEARCH_PAGE_SIZE
): Promise<estypes.SearchHit<T>[]> {
  const { index, sort = [], ...rest } = request
  const keepAlive = '1m'
  let pitId = (await client.openPointInTime({ index, keep_alive: keepAlive })).id
  const hits: estypes.SearchHit<T>[] = []
  try {
    let searchAfter: estypes.SortResults | undefined
    for (;;) {
      const page = await client.search<T>({
        ...rest,
        pit: { id: pitId, keep_alive: keepAlive },
        // _shard_doc makes the order total, so search_after never skips or repeats a hit
        sort: [...sort, { _shard_doc: 'asc' }],
        size: pageSize,
        search_after: searchAfter,
        track_total_hits: false,
        allow_partial_search_results: false
      })
      // a short page must mean "no more hits", never "a shard did not answer"
      if (page.timed_out || page._shards.failed > 0) {
        throw new Error(`Incomplete search on index ${index}: a page is partial`)
      }
      pitId = page.pit_id ?? pitId
      hits.push(...page.hits.hits)
      if (page.hits.hits.length < pageSize) return hits
      searchAfter = page.hits.hits[page.hits.hits.length - 1].sort
    }
  } finally {
    // the point in time expires by itself; a failed close must not hide the result
    await client.closePointInTime({ id: pitId }).catch(() => {})
  }
}

// real-time read by id; a missing document is null, any other error (a missing index too)
// is thrown
export async function getOrNull<T>(
  client: Client,
  index: string,
  id: string
): Promise<{ source: T; seqNo: number; primaryTerm: number } | null> {
  try {
    const result = await client.get<T>({ index, id })
    return {
      source: result._source,
      seqNo: result._seq_no,
      primaryTerm: result._primary_term
    }
  } catch (error) {
    const missingIndex = error?.meta?.body?.error?.type === 'index_not_found_exception'
    if (error?.meta?.statusCode === 404 && !missingIndex) return null
    throw error
  }
}
