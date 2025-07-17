import { Client } from '@elastic/elasticsearch'
import { OceanNodeDBConfig } from '../../@types'
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

export function createElasticsearchClientWithRetry(
  config: OceanNodeDBConfig,
  customConfig: Partial<ElasticsearchRetryConfig> = {}
): Client {
  const finalConfig = {
    ...DEFAULT_ELASTICSEARCH_CONFIG,
    ...customConfig
  }

  return new Client({
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
}

export function createElasticsearchClientWithCustomRetry(
  config: OceanNodeDBConfig,
  customRetryConfig: Partial<ElasticsearchRetryConfig>
): Client {
  return createElasticsearchClientWithRetry(config, customRetryConfig)
}

export function getElasticsearchConfig(
  retryConfig: ElasticsearchRetryConfig = {}
): Required<ElasticsearchRetryConfig> {
  return {
    ...DEFAULT_ELASTICSEARCH_CONFIG,
    ...retryConfig
  }
}
