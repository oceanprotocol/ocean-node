import { OceanNode } from '../../OceanNode.js'
import type { BucketRegistry } from '../database/BucketRegistry.js'

import type { PersistentStorageFactory } from './PersistentStorageFactory.js'
import { PersistentStorageLocalFS } from './PersistentStorageLocalFS.js'
import { PersistentStorageS3 } from './PersistentStorageS3.js'

export function createPersistentStorage(
  node: OceanNode,
  buckets: BucketRegistry | undefined
): PersistentStorageFactory {
  const config = node.getConfig().persistentStorage
  if (!config?.enabled) {
    throw new Error('Persistent storage is disabled')
  }
  if (!buckets) {
    throw new Error(
      'Persistent storage is enabled but the database is not available: the bucket registry is stored in Elasticsearch'
    )
  }

  switch (config.type) {
    case 'localfs':
      return new PersistentStorageLocalFS(node, buckets)
    case 's3':
      return new PersistentStorageS3(node, buckets)
    default:
      throw new Error(
        `Unsupported persistent storage type: ${(config as { type?: string })?.type}`
      )
  }
}
