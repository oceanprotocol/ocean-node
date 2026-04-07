import { OceanNode } from '../../OceanNode.js'

import type { PersistentStorageFactory } from './PersistentStorageFactory.js'
import { PersistentStorageLocalFS } from './PersistentStorageLocalFS.js'
import { PersistentStorageS3 } from './PersistentStorageS3.js'

export function createPersistentStorage(node: OceanNode): PersistentStorageFactory {
  const config = node.getConfig().persistentStorage
  if (!config?.enabled) {
    throw new Error('Persistent storage is disabled')
  }

  switch (config.type) {
    case 'localfs':
      return new PersistentStorageLocalFS(node)
    case 's3':
      return new PersistentStorageS3(node)
    default:
      throw new Error(
        `Unsupported persistent storage type: ${(config as { type?: string })?.type}`
      )
  }
}
