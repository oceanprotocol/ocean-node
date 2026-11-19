import type { OceanNodeDBConfig } from '../../../@types/OceanNode.js'
import { validateDDO } from '../../../utils/asset.js'
import { DATABASE_LOGGER } from '../../../utils/logging/common.js'
import {
  AbstractDdoDatabase,
  Condition,
  DdoSchema,
  Found,
  Page,
  SortSpec,
  TagCount
} from '../BaseDatabase.js'
import { DDO_FIELDS } from '../assetQuery.js'
import { DDO_SCHEMA_NAMES, ddoSchemaName } from '../ddoSchemas.js'
import type { SqlClient } from './SqlClient.js'
import { SqlDocuments } from './SqlDocuments.js'
import { orNull } from './orNull.js'

// the DDOs of the indexed chains: id = the DID
export class SqlDdoDatabase extends AbstractDdoDatabase {
  private ddos: SqlDocuments

  constructor(config: OceanNodeDBConfig, db: SqlClient) {
    super(config)
    this.ddos = new SqlDocuments(db, 'ddo')
  }

  init(): Promise<void> {
    return this.ddos.init()
  }

  getSchemas(): DdoSchema[] {
    return DDO_SCHEMA_NAMES.map((index) => ({ index }))
  }

  find(conditions: Condition[], sort: SortSpec[], page: Page): Promise<Found> {
    return this.ddos.find(conditions, sort, page)
  }

  // the field table keeps text in lower case, so the tags are in lower case
  async tags(conditions: Condition[], limit: number): Promise<TagCount[]> {
    const counts = await this.ddos.valueCounts(DDO_FIELDS.tags, conditions, limit)
    return counts.map(({ value, count }) => ({ tag: value, count }))
  }

  create(ddo: Record<string, any>): Promise<any> {
    const schema = ddoSchemaName(ddo)
    if (!DDO_SCHEMA_NAMES.includes(schema)) {
      throw new Error(`Schema for version ${ddo.version} not found`)
    }
    return orNull(`Error when saving DDO entry ${ddo.id}`, async () => {
      // the nft is in indexedMetadata; a second copy fails the validation
      if (ddo?.indexedMetadata?.nft) delete ddo.nft
      if ((await validateDDO(ddo)) !== true) {
        throw new Error(`Validation of DDO with schema version ${ddo.version} failed`)
      }
      await this.ddos.put(ddo.id, ddo)
      return ddo
    })
  }

  async retrieve(id: string): Promise<any> {
    const ddo = await this.ddos.get(id)
    if (!ddo) {
      DATABASE_LOGGER.debug(`DDO entry with ID ${id} not found.`)
    }
    return ddo
  }

  // a DDO has one row, so an update that changes the schema needs no cleanup
  update(ddo: Record<string, any>): Promise<any> {
    return this.create(ddo)
  }

  async delete(id: string): Promise<any> {
    return (await this.ddos.delete(id)) ? { id } : undefined
  }

  deleteAllAssetsFromChain(chainId: number): Promise<number> {
    return this.ddos.deleteMatching([{ paths: DDO_FIELDS.chainId, anyOf: [chainId] }])
  }
}
