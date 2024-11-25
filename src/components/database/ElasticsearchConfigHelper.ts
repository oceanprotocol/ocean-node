import { Client } from '@elastic/elasticsearch'
import { OceanNodeDBConfig } from '../../@types'

export function createElasticsearchClient(config: OceanNodeDBConfig): Client {
  return new Client({
    node: config.url,
    auth:
      config.username && config.password
        ? { username: config.username, password: config.password }
        : undefined
  })
}
