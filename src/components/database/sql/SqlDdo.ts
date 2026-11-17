import type { OceanNodeDBConfig } from '../../../@types/OceanNode.js'
import { validateDDO } from '../../../utils/asset.js'
import { DATABASE_LOGGER } from '../../../utils/logging/common.js'
import { AbstractDdoDatabase, DdoSchema } from '../BaseDatabase.js'
import { DDO_SCHEMA_NAMES, ddoSchemaName } from '../ddoSchemas.js'
import type { SqlClient } from './SqlClient.js'
import { SqlDocuments } from './SqlDocuments.js'
import { orNull } from './orNull.js'

// The schema of a DDO is not in the DDO. It is a field of the search only, so that the
// `index` of a query selects the DDOs of one schema.
const SCHEMA_FIELD = '_schema'

// the DDOs of the indexed chains: id = the DID
export class SqlDdoDatabase extends AbstractDdoDatabase {
  private ddos: SqlDocuments

  constructor(config: OceanNodeDBConfig, db: SqlClient) {
    super(config)
    this.ddos = new SqlDocuments(db, 'ddo', config.dbType)
  }

  init(): Promise<void> {
    return this.ddos.init()
  }

  getSchemas(): DdoSchema[] {
    return DDO_SCHEMA_NAMES.map((index) => ({ index }))
  }

  // one array with the DDOs of the page, or no array when no DDO matches
  async search({ index, ...query }: Record<string, any>): Promise<any> {
    const ofSchema = index && { term: { [SCHEMA_FIELD]: index } }
    const filter = [ofSchema, query.query].filter(Boolean)
    const ddos = await this.ddos.query({ ...query, query: { bool: { filter } } })
    return ddos.length > 0 ? [ddos] : []
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
      await this.ddos.put(ddo.id, ddo, { [SCHEMA_FIELD]: schema })
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
    return this.ddos.deleteMatching({ term: { chainId } })
  }
}
