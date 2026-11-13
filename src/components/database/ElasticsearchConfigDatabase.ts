import { Client } from '@elastic/elasticsearch'
import { OceanNodeDBConfig } from '../../@types/OceanNode.js'
import { DATABASE_LOGGER } from '../../utils/logging/common.js'
import { ConfigDatabase } from './ConfigDatabase.js'
import {
  createElasticsearchClientWithRetry,
  ensureIndex,
  getOrNull
} from './ElasticsearchConfigHelper.js'
import { stateSchemas } from './ElasticSchemas.js'

const INDEX = stateSchemas.nodeConfig.index

// one document per key: id = key, body = { value }
export class ElasticsearchConfigDatabase implements ConfigDatabase {
  private constructor(private config: OceanNodeDBConfig) {}

  // resolved per call: the health monitor replaces the client after a reconnect
  private client(): Promise<Client> {
    return createElasticsearchClientWithRetry(this.config)
  }

  static async create(config: OceanNodeDBConfig): Promise<ElasticsearchConfigDatabase> {
    await ensureIndex(config, stateSchemas.nodeConfig)
    return new ElasticsearchConfigDatabase(config)
  }

  async createOrUpdateConfig(key: string, value: string) {
    try {
      const client = await this.client()
      await client.index({
        index: INDEX,
        id: key,
        body: { value },
        refresh: 'wait_for'
      })
      return { key, value }
    } catch (error) {
      const errorMsg = `Error when creating new version entry ${value}: ` + error.message
      DATABASE_LOGGER.error(errorMsg)
      return null
    }
  }

  async retrieveValue(key: string = 'version') {
    try {
      const row = await getOrNull<{ value: string }>(await this.client(), INDEX, key)
      return { value: row?.source?.value ?? null }
    } catch (error) {
      const errorMsg = `Error when retrieving latest version entry: ` + error.message
      DATABASE_LOGGER.error(errorMsg)
      return null
    }
  }
}
