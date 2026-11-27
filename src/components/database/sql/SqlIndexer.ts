import type { OceanNodeDBConfig } from '../../../@types/OceanNode.js'
import { AbstractIndexerDatabase } from '../BaseDatabase.js'
import type { SqlClient } from './SqlClient.js'
import { orNull } from './orNull.js'

// the last indexed block of each chain: id = the chain id
export class SqlIndexerDatabase extends AbstractIndexerDatabase {
  constructor(
    config: OceanNodeDBConfig,
    private db: SqlClient
  ) {
    super(config)
  }

  init(): Promise<void> {
    return this.db.exec(
      'CREATE TABLE IF NOT EXISTS indexer ("id" TEXT PRIMARY KEY, "lastIndexedBlock" BIGINT)'
    )
  }

  create(network: number, lastIndexedBlock: number) {
    const id = network.toString()
    return orNull(
      `Error when writing the indexer entry of network ${network}`,
      async () => {
        await this.db.run(
          `INSERT INTO indexer ("id", "lastIndexedBlock") VALUES (?, ?)
         ON CONFLICT ("id") DO UPDATE SET "lastIndexedBlock" = excluded."lastIndexedBlock"`,
          [id, lastIndexedBlock]
        )
        return { id, lastIndexedBlock }
      }
    )
  }

  // null for a chain that is not indexed yet
  retrieve(network: number) {
    return orNull(
      `Error when reading the indexer entry of network ${network}`,
      async () => {
        const row = await this.db.get<{ lastIndexedBlock: number }>(
          'SELECT "lastIndexedBlock" FROM indexer WHERE "id" = ?',
          [network.toString()]
        )
        return row ?? null
      }
    )
  }

  update(network: number, lastIndexedBlock: number) {
    return this.create(network, lastIndexedBlock)
  }

  delete(network: number) {
    const id = network.toString()
    return orNull(
      `Error when deleting the indexer entry of network ${network}`,
      async () => {
        const { changes } = await this.db.run('DELETE FROM indexer WHERE "id" = ?', [id])
        return changes === 1 ? { id } : null
      }
    )
  }
}
