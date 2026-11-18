import { Client } from '@elastic/elasticsearch'
import {
  AbstractAccessListDatabase,
  AbstractDdoDatabase,
  AbstractDdoStateDatabase,
  AbstractEscrowDatabase,
  AbstractIndexerDatabase,
  AbstractLogDatabase,
  AbstractNonceDatabase,
  AbstractOrderDatabase,
  MAX_RESULT_WINDOW,
  queryPage
} from './BaseDatabase.js'
import { AccessListUser } from '../../@types/AccessList.js'
import { EscrowEvent } from '../../@types/Escrow.js'
import { buildElasticQuery, escrowPage } from './escrowSearch.js'
import {
  createElasticsearchClientWithRetry,
  deleteMatching,
  ensureIndex,
  getOrNull,
  isStatus
} from './ElasticsearchConfigHelper.js'
import { OceanNodeDBConfig } from '../../@types'
import { ElasticsearchSchema, elasticSchemas } from './ElasticSchemas.js'
import { addressCasingVariants, normalizeAddress } from '../../utils/evmAddress.js'
import { DATABASE_LOGGER } from '../../utils/logging/common.js'
import { LOG_LEVELS_STR } from '../../utils/logging/Logger.js'
import { safeStringify } from '../../utils/logging/redact.js'

import { validateDDO } from '../../utils/asset.js'
import { ddoSchemaName } from './ddoSchemas.js'

const LOG_INSERT_FAILED_KEY = 'es-log-insert-failed'
let logInsertFailing = false

// Each store gets the client on each call: the health monitor replaces the client after a
// reconnect, and a client that it closed fails every request.

// Nonces are read only by real-time `get`, never by search, so writes skip `refresh: 'wait_for'`.
export class ElasticsearchNonceDatabase extends AbstractNonceDatabase {
  private readonly index = elasticSchemas.nonceSchemas.index

  private constructor(config: OceanNodeDBConfig) {
    super(config)
  }

  static async create(config: OceanNodeDBConfig): Promise<ElasticsearchNonceDatabase> {
    await ensureIndex(config, elasticSchemas.nonceSchemas)
    return new ElasticsearchNonceDatabase(config)
  }

  private client(): Promise<Client> {
    return createElasticsearchClientWithRetry(this.config)
  }

  private async write(address: string, nonce: number) {
    const id = normalizeAddress(address)
    const client = await this.client()
    await client.index({
      index: this.index,
      id,
      body: { nonce }
    })
    return { id, nonce }
  }

  async create(address: string, nonce: number) {
    try {
      return await this.write(address, nonce)
    } catch (error) {
      const errorMsg =
        `Error when creating new nonce entry ${nonce} for address ${address}: ` +
        error.message
      DATABASE_LOGGER.error(errorMsg)
      return null
    }
  }

  // Documents are keyed by the checksummed address. Read every casing variant of the SAME
  // address and keep the HIGHEST nonce: the nonce must stay monotonic, dropping back to 0
  // would briefly re-open the replay window that the nonce exists to close.
  // A failed read throws: the callers must not take it for "no nonce yet" and start from 0.
  async retrieve(address: string) {
    const id = normalizeAddress(address)
    try {
      const client = await this.client()
      let highest: number | null = null
      for (const variant of addressCasingVariants(address)) {
        const row = await getOrNull<{ nonce: number }>(client, this.index, variant)
        const nonce = row?.source?.nonce
        if (typeof nonce === 'number' && (highest === null || nonce > highest)) {
          highest = nonce
        }
      }
      return { id, nonce: highest }
    } catch (error) {
      const errorMsg =
        `Error when retrieving nonce entry for address ${address}: ` + error.message
      DATABASE_LOGGER.error(errorMsg)
      throw error
    }
  }

  async update(address: string, nonce: number) {
    try {
      return await this.write(address, nonce)
    } catch (error) {
      const errorMsg =
        `Error when updating nonce entry ${nonce} for address ${address}: ` +
        error.message
      DATABASE_LOGGER.error(errorMsg)
      return null
    }
  }

  async delete(address: string) {
    const id = normalizeAddress(address)
    try {
      const client = await this.client()
      const row = await getOrNull<{ nonce: number }>(client, this.index, id)
      if (!row) return { id, nonce: null }
      await client.delete({ index: this.index, id })
      return { id, nonce: row.source.nonce }
    } catch (error) {
      const errorMsg =
        `Error when deleting nonce entry for address ${address}: ` + error.message
      DATABASE_LOGGER.error(errorMsg)
      return null
    }
  }
}

export class ElasticsearchIndexerDatabase extends AbstractIndexerDatabase {
  private readonly index = elasticSchemas.indexerSchemas.index

  private constructor(config: OceanNodeDBConfig) {
    super(config)
  }

  static async create(config: OceanNodeDBConfig): Promise<ElasticsearchIndexerDatabase> {
    await ensureIndex(config, elasticSchemas.indexerSchemas)
    return new ElasticsearchIndexerDatabase(config)
  }

  private client(): Promise<Client> {
    return createElasticsearchClientWithRetry(this.config)
  }

  async create(network: number, lastIndexedBlock: number) {
    try {
      const client = await this.client()
      await client.index({
        index: this.index,
        id: network.toString(),
        body: { lastIndexedBlock },
        refresh: 'wait_for'
      })
      return { id: network.toString(), lastIndexedBlock }
    } catch (error) {
      const errorMsg = `Error when creating indexer entry on network ${network} with last indexed block ${lastIndexedBlock}: ${error.message}`
      DATABASE_LOGGER.error(errorMsg)
      return null
    }
  }

  async retrieve(network: number) {
    try {
      const client = await this.client()
      const result = await client.get({
        index: this.index,
        id: network.toString(),
        refresh: true
      })
      return result._source
    } catch (error) {
      const errorMsg = `Error when retrieving indexer entry on network ${network}: ${error.message}`
      DATABASE_LOGGER.error(errorMsg)
      return null
    }
  }

  async update(network: number, lastIndexedBlock: number) {
    try {
      const client = await this.client()
      const exists = await client.exists({
        index: this.index,
        id: network.toString()
      })

      if (exists) {
        await client.update({
          index: this.index,
          id: network.toString(),
          body: {
            doc: { lastIndexedBlock }
          },
          refresh: 'wait_for'
        })
      } else {
        await this.create(network, lastIndexedBlock)
      }

      return { id: network.toString(), lastIndexedBlock }
    } catch (error) {
      const errorMsg = `Error when updating indexer entry on network ${network} with last indexed block ${lastIndexedBlock}: ${error.message}`
      DATABASE_LOGGER.error(errorMsg)
      return null
    }
  }

  async delete(network: number) {
    try {
      const client = await this.client()
      await client.delete({
        index: this.index,
        id: network.toString(),
        refresh: 'wait_for'
      })
      return { id: network.toString() }
    } catch (error) {
      const errorMsg = `Error when deleting indexer entry on network ${network}: ${error.message}`
      DATABASE_LOGGER.error(errorMsg)
      return null
    }
  }
}

export class ElasticsearchDdoStateDatabase extends AbstractDdoStateDatabase {
  private readonly index = elasticSchemas.ddoStateSchema.index

  private constructor(config: OceanNodeDBConfig) {
    super(config)
  }

  static async create(config: OceanNodeDBConfig): Promise<ElasticsearchDdoStateDatabase> {
    await ensureIndex(config, elasticSchemas.ddoStateSchema)
    return new ElasticsearchDdoStateDatabase(config)
  }

  private client(): Promise<Client> {
    return createElasticsearchClientWithRetry(this.config)
  }

  async create(
    chainId: number,
    did: string,
    nftAddress: string,
    txId: string = ' ',
    valid: boolean = true,
    errorMsg: string = ' '
  ) {
    try {
      const client = await this.client()
      await client.index({
        index: this.index,
        id: did,
        body: { chainId, did, nft: nftAddress, txId, valid, error: errorMsg },
        // refresh: 'wait_for'
        refresh: true
      })
      return { id: did, chainId, nft: nftAddress, txId, valid, error: errorMsg }
    } catch (error) {
      const errorMessage = `Error when saving ddo state for: ${did} Error: ${error.message}`
      DATABASE_LOGGER.error(errorMessage)
      return null
    }
  }

  async retrieve(did: string) {
    try {
      const client = await this.client()
      const result = await client.get({
        index: this.index,
        id: did
      })
      return result._source
    } catch (error) {
      const errorMessage = `Error when retrieving the state of the ddo with id: ${did}: ${error.message}`
      DATABASE_LOGGER.error(errorMessage)
      return null
    }
  }

  async search(query: Record<string, any>) {
    try {
      const client = await this.client()
      const result = await client.search({
        index: this.index,
        body: {
          query
        }
      })
      return result.hits.hits.map((hit: any) => {
        return normalizeDocumentId(hit._source, hit._id)
      })
    } catch (error) {
      DATABASE_LOGGER.error(
        `Error when searching ddo state (query ${safeStringify(query, { maxLength: 200 })}): ${error.message}`
      )
      return null
    }
  }

  async update(
    chainId: number,
    did: string,
    nftAddress: string,
    txId: string = ' ',
    valid: boolean = true,
    errorMsg: string = ' '
  ) {
    try {
      const client = await this.client()
      const exists = await client.exists({
        index: this.index,
        id: did
      })

      if (exists) {
        await client.update({
          index: this.index,
          id: did,
          body: {
            doc: { chainId, did, nft: nftAddress, txId, valid, error: errorMsg }
          },
          // refresh: 'wait_for'
          refresh: true
        })
      } else {
        return await this.create(chainId, did, nftAddress, txId, valid, errorMsg)
      }

      return { id: did, chainId, nft: nftAddress, txId, valid, error: errorMsg }
    } catch (error) {
      const errorMessage = `Error when updating ddo state for: ${did} Error: ${error.message}`
      DATABASE_LOGGER.error(errorMessage)
      return null
    }
  }

  async delete(did: string) {
    try {
      const client = await this.client()
      await client.delete({
        index: this.index,
        id: did,
        // refresh: 'wait_for'
        refresh: true
      })
      return { id: did }
    } catch (error) {
      const errorMessage = `Error when deleting ddo state ${did}: ${error.message}`
      DATABASE_LOGGER.error(errorMessage)
      return null
    }
  }
}

export class ElasticsearchOrderDatabase extends AbstractOrderDatabase {
  private readonly index = elasticSchemas.orderSchema.index

  private constructor(config: OceanNodeDBConfig) {
    super(config)
  }

  static async create(config: OceanNodeDBConfig): Promise<ElasticsearchOrderDatabase> {
    // without it, the first order would create the index with dynamic mappings
    await ensureIndex(config, elasticSchemas.orderSchema)
    return new ElasticsearchOrderDatabase(config)
  }

  private client(): Promise<Client> {
    return createElasticsearchClientWithRetry(this.config)
  }

  async search(query: Record<string, any>) {
    try {
      const client = await this.client()
      const { size, offset } = queryPage(query)
      const result = await client.search({
        index: this.index,
        body: { ...query, from: offset, size }
      })
      return result.hits.hits.map((hit: any) => {
        return normalizeDocumentId(hit._source, hit._id)
      })
    } catch (error) {
      DATABASE_LOGGER.error(
        `Error when searching orders (query ${safeStringify(query, { maxLength: 200 })}): ${error.message}`
      )
      return null
    }
  }

  async create(
    orderId: string,
    type: string,
    timestamp: number,
    consumer: string,
    payer: string,
    datatokenAddress: string,
    nftAddress: string,
    did: string,
    startOrderId?: string
  ) {
    try {
      const client = await this.client()
      const document = {
        orderId,
        type,
        timestamp,
        consumer,
        payer,
        datatokenAddress,
        nftAddress,
        did,
        startOrderId
      }
      await client.index({
        index: this.index,
        id: orderId,
        body: document
      })
      return document
    } catch (error) {
      const errorMsg =
        `Error when creating order entry ${orderId} at timestamp ${timestamp} by payer ${payer} for consumer ${consumer}: ` +
        error.message
      DATABASE_LOGGER.error(errorMsg)
      return null
    }
  }

  async retrieve(orderId: string) {
    try {
      const client = await this.client()
      const result = await client.get({
        index: this.index,
        id: orderId
      })
      return normalizeDocumentId(result._source, result._id)
    } catch (error) {
      const errorMsg = `Error when retrieving order ${orderId}: ` + error.message
      DATABASE_LOGGER.error(errorMsg)
      return null
    }
  }

  async update(
    orderId: string,
    type: string,
    timestamp: number,
    consumer: string,
    payer: string,
    startOrderId?: string,
    datatokenAddress?: string
  ) {
    try {
      const client = await this.client()
      const document = {
        type,
        timestamp,
        consumer,
        payer,
        datatokenAddress,
        startOrderId
      }
      await client.update({
        index: this.index,
        id: orderId,
        body: {
          doc: document,
          doc_as_upsert: true
        }
      })
      return document
    } catch (error) {
      const errorMsg =
        `Error when updating order entry ${orderId} at timestamp ${timestamp} by payer ${payer} for consumer ${consumer}: ` +
        error.message
      DATABASE_LOGGER.error(errorMsg)
      return null
    }
  }

  async delete(orderId: string) {
    try {
      const client = await this.client()
      await client.delete({
        index: this.index,
        id: orderId
      })
      return { id: orderId }
    } catch (error) {
      const errorMsg = `Error when deleting order ${orderId}: ` + error.message
      DATABASE_LOGGER.error(errorMsg)
      return null
    }
  }
}

export class ElasticsearchEscrowDatabase extends AbstractEscrowDatabase {
  private readonly index = elasticSchemas.escrowSchema.index

  private constructor(config: OceanNodeDBConfig) {
    super(config)
  }

  static async create(config: OceanNodeDBConfig): Promise<ElasticsearchEscrowDatabase> {
    await ensureIndex(config, elasticSchemas.escrowSchema)
    return new ElasticsearchEscrowDatabase(config)
  }

  private client(): Promise<Client> {
    return createElasticsearchClientWithRetry(this.config)
  }

  async create(event: EscrowEvent) {
    try {
      const client = await this.client()
      await client.index({
        index: this.index,
        id: event.id,
        body: event
      })
      return event
    } catch (error) {
      const errorMsg = `Error when creating escrow event ${event.id}: ` + error.message
      DATABASE_LOGGER.error(errorMsg)
      return null
    }
  }

  async retrieve(id: string) {
    try {
      const client = await this.client()
      const result = await client.get({
        index: this.index,
        id
      })
      return normalizeDocumentId(result._source, result._id)
    } catch (error) {
      const errorMsg = `Error when retrieving escrow event ${id}: ` + error.message
      DATABASE_LOGGER.error(errorMsg)
      return null
    }
  }

  async search(filters: Record<string, any>, offset?: number, size?: number) {
    try {
      const client = await this.client()
      const { from, limit } = escrowPage(offset, size)

      // Values may be equality scalars or RangeFilter objects (range on numeric fields).
      const query = buildElasticQuery(filters)

      const searchParams = {
        index: this.index,
        body: { query, from, size: limit }
      }
      const result = await client.search(searchParams)
      return result.hits.hits.map((hit: any) => normalizeDocumentId(hit._source, hit._id))
    } catch (error) {
      const errorMsg =
        `Error when searching escrow events (filters ${safeStringify(filters, { maxLength: 200 })}): ` +
        error.message
      DATABASE_LOGGER.error(errorMsg)
      return null
    }
  }

  async delete(id: string) {
    try {
      const client = await this.client()
      await client.delete({
        index: this.index,
        id
      })
      return { id }
    } catch (error) {
      const errorMsg = `Error when deleting escrow event ${id}: ` + error.message
      DATABASE_LOGGER.error(errorMsg)
      return null
    }
  }
}

export class ElasticsearchDdoDatabase extends AbstractDdoDatabase {
  private readonly schemas = elasticSchemas.ddoSchemas

  private constructor(config: OceanNodeDBConfig) {
    super(config)
  }

  static async create(config: OceanNodeDBConfig): Promise<ElasticsearchDdoDatabase> {
    // a failure stops the startup, which tries again
    for (const schema of elasticSchemas.ddoSchemas) {
      await ensureIndex(config, schema)
    }
    return new ElasticsearchDdoDatabase(config)
  }

  private client(): Promise<Client> {
    return createElasticsearchClientWithRetry(this.config)
  }

  getSchemas(): ElasticsearchSchema[] {
    return this.schemas
  }

  getDDOSchema(ddo: Record<string, any>) {
    const schemaName = ddoSchemaName(ddo)
    const schema = this.getSchemas().find((s) => s.index === schemaName)
    DATABASE_LOGGER.debug(`Returning schema: ${schemaName}`)
    return schema
  }

  private async deleteDDOFromOtherSchemas(
    id: string,
    currentSchema: ElasticsearchSchema
  ): Promise<void> {
    for (const schema of this.getSchemas()) {
      if (schema.index === currentSchema.index) {
        continue
      }

      try {
        const client = await this.client()
        await client.delete({
          index: schema.index,
          id
        })
      } catch (error) {
        if (!isStatus(error, 404)) {
          DATABASE_LOGGER.error(
            `Error when deleting stale DDO entry ${id} from schema ${schema.index}: ${error.message}`
          )
        }
      }
    }
  }

  // `index` selects the DDOs of one schema. All other values search all DDOs: the search
  // never reads an index that is not a DDO index.
  async search({ index, ...query }: Record<string, any>): Promise<any> {
    const results = []
    const { size, offset } = queryPage(query)
    const named = this.getSchemas().filter((schema) => schema.index === index)
    for (const schema of named.length > 0 ? named : this.getSchemas()) {
      try {
        const client = await this.client()
        const response = await client.search({
          index: schema.index,
          body: { ...query, from: offset, size }
        })
        if (response.hits?.hits.length > 0) {
          results.push(
            response.hits.hits.map((hit: any) =>
              normalizeDocumentId(hit._source, hit._id)
            )
          )
        }
      } catch (error) {
        DATABASE_LOGGER.error(`Error for schema ${schema.index}: ${error.message}`)
      }
    }
    return results
  }

  async create(ddo: Record<string, any>): Promise<any> {
    const schema = this.getDDOSchema(ddo)
    if (!schema) {
      throw new Error(`Schema for version ${ddo.version} not found`)
    }
    try {
      const client = await this.client()
      // avoid issue with nft fields, due to schema
      if (ddo?.indexedMetadata?.nft) delete ddo.nft
      const validation = await validateDDO(ddo)

      if (validation === true) {
        await client.index({ index: schema.index, id: ddo.id, body: ddo })
        return ddo
      } else {
        throw new Error(`Validation of DDO with schema version ${ddo.version} failed`)
      }
    } catch (error) {
      const errorMsg = `Error when creating DDO entry ${ddo.id}: ${error.message}`
      DATABASE_LOGGER.error(errorMsg)
      return null
    }
  }

  async retrieve(id: string): Promise<any> {
    let ddo = null
    for (const schema of this.getSchemas()) {
      try {
        const client = await this.client()
        const response = await client.get({
          index: schema.index,
          id
        })
        if (response.found) {
          ddo = response._source
          break
        }
      } catch (error) {
        if (!isStatus(error, 404)) {
          DATABASE_LOGGER.error(
            `Error when retrieving DDO entry ${id} from schema ${schema.index}: ${error.message}`
          )
        }
      }
    }

    if (!ddo) {
      DATABASE_LOGGER.debug(`DDO entry with ID ${id} not found in any schema.`)
    }

    return ddo
  }

  // returns the DDO, as the SQL store does: the indexer reads its fields
  async update(ddo: Record<string, any>): Promise<any> {
    const schema = this.getDDOSchema(ddo)
    if (!schema) {
      throw new Error(`Schema for version ${ddo.version} not found`)
    }
    try {
      const client = await this.client()
      // avoid issue with nft fields, due to schema
      if (ddo?.indexedMetadata?.nft) delete ddo.nft
      const validation = await validateDDO(ddo)
      if (validation === true) {
        await client.index({ index: schema.index, id: ddo.id, body: ddo })
        await this.deleteDDOFromOtherSchemas(ddo.id, schema)
        return ddo
      } else {
        throw new Error(
          `Validation of DDO with schema version ${ddo.version} failed with errors`
        )
      }
    } catch (error) {
      if (isStatus(error, 404)) {
        await this.delete(ddo.id)
        return this.create(ddo)
      }
      const errorMsg = `Error when updating DDO entry ${ddo.id}: ${error.message}`
      DATABASE_LOGGER.error(errorMsg)
      return null
    }
  }

  async delete(id: string): Promise<any> {
    let isDeleted = false
    for (const schema of this.getSchemas()) {
      try {
        const client = await this.client()
        const response = await client.delete({
          index: schema.index,
          id
        })
        isDeleted = response.result === 'deleted'
        if (isDeleted) {
          DATABASE_LOGGER.debug(`Deleted DDO ${id} from schema ${schema.index}`)
          return { id }
        }
      } catch (error) {
        if (!isStatus(error, 404)) {
          DATABASE_LOGGER.error(
            `Error when deleting DDO entry ${id} from schema ${schema.index}: ${error.message}`
          )
        }
      }
    }

    if (!isDeleted) {
      DATABASE_LOGGER.debug(
        `DDO entry with ID ${id} not found in any schema or could not be deleted.`
      )
    }
  }

  // throws, as the SQL store does: a reindex must not continue over DDOs that are still there
  async deleteAllAssetsFromChain(chainId: number): Promise<number> {
    const client = await this.client()
    let numDeleted = 0
    for (const schema of this.getSchemas()) {
      try {
        numDeleted += await deleteMatching(client, schema.index, { term: { chainId } })
      } catch (error) {
        if (!isStatus(error, 404)) throw error
      }
    }
    return numDeleted
  }
}

export class ElasticsearchLogDatabase extends AbstractLogDatabase {
  private readonly index = elasticSchemas.logSchemas.index

  private constructor(config: OceanNodeDBConfig) {
    super(config)
  }

  static async create(config: OceanNodeDBConfig): Promise<ElasticsearchLogDatabase> {
    await ensureIndex(config, elasticSchemas.logSchemas)
    return new ElasticsearchLogDatabase(config)
  }

  private client(): Promise<Client> {
    return createElasticsearchClientWithRetry(this.config)
  }

  async insertLog(logEntry: Record<string, any>) {
    try {
      const client = await this.client()
      const timestamp = new Date().toISOString()
      const result = await client.index({
        index: this.index,
        body: { ...logEntry, timestamp },
        // refresh: 'wait_for'
        refresh: true
      })
      if (logInsertFailing) {
        logInsertFailing = false
        DATABASE_LOGGER.resetThrottle(LOG_INSERT_FAILED_KEY)
        DATABASE_LOGGER.info('Log DB writes resumed')
      }
      // uniformize result response (we need an id for the retrieveLog API)
      if (result._id) {
        return normalizeDocumentId(logEntry, result._id)
      }
      return logEntry
    } catch (error) {
      const errorMsg = `Error when inserting log entry: ${error.message}`
      logInsertFailing = true
      // one line per failed write would double the output during a log DB outage
      DATABASE_LOGGER.throttled(
        LOG_INSERT_FAILED_KEY,
        LOG_LEVELS_STR.LEVEL_ERROR,
        errorMsg
      )
      return null
    }
  }

  async retrieveLog(id: string): Promise<Record<string, any> | null> {
    try {
      const client = await this.client()
      const result = await client.get({
        index: this.index,
        id
      })
      return normalizeDocumentId(result._source, result._id)
    } catch (error) {
      const errorMsg = `Error when retrieving log entry: ${error.message}`
      DATABASE_LOGGER.error(errorMsg)
      return null
    }
  }

  async retrieveMultipleLogs(
    startTime: Date,
    endTime: Date,
    maxLogs: number,
    moduleName?: string,
    level?: string,
    page?: number
  ): Promise<Record<string, any>[]> {
    try {
      const client = await this.client()
      const filterConditions: any = {
        bool: {
          must: [{ range: { timestamp: { gte: startTime, lte: endTime } } }]
        }
      }

      if (moduleName) {
        filterConditions.bool.must.push({ match: { moduleName } })
      }
      if (level) {
        filterConditions.bool.must.push({ match: { level } })
      }

      if (page !== undefined && page !== null) {
        return await this.fetchLogPage(filterConditions, page, Math.min(maxLogs, 250))
      }

      const allLogs: Record<string, any>[] = []
      let currentPage = 0
      const pageSize = 250

      while (allLogs.length < maxLogs) {
        const from = currentPage * pageSize
        const size = Math.min(pageSize, maxLogs - allLogs.length)

        if (from + size > MAX_RESULT_WINDOW) {
          DATABASE_LOGGER.debug(
            `Reached the result window limit (${MAX_RESULT_WINDOW}). Returning ${allLogs.length} logs.`
          )
          break
        }

        const result = await client.search({
          index: this.index,
          body: {
            query: filterConditions,
            sort: [{ timestamp: { order: 'desc' } }]
          },
          size,
          from
        })

        const hits = result.hits.hits.map((hit: any) =>
          normalizeDocumentId(hit._source, hit._id)
        )
        allLogs.push(...hits)

        if (hits.length < size) break
        currentPage++
      }

      return allLogs.slice(0, maxLogs)
    } catch (error) {
      const errorMsg = `Error when retrieving multiple log entries: ${error.message}`
      DATABASE_LOGGER.error(errorMsg)
      return []
    }
  }

  private async fetchLogPage(
    filterConditions: any,
    page: number,
    size: number
  ): Promise<Record<string, any>[]> {
    const client = await this.client()
    const from = page * size
    if (from + size > MAX_RESULT_WINDOW) {
      DATABASE_LOGGER.debug(
        `Result window is too large, from + size must be less than or equal to: [${MAX_RESULT_WINDOW}]. "from": ${from}, "size": ${size}`
      )
      return []
    }
    const result = await client.search({
      index: this.index,
      body: {
        query: filterConditions,
        sort: [{ timestamp: { order: 'desc' } }]
      },
      size,
      from
    })
    return result.hits.hits.map((hit: any) => normalizeDocumentId(hit._source, hit._id))
  }

  async delete(logId: string): Promise<void> {
    if (!logId) {
      throw new Error('Log ID is required for deletion.')
    }
    try {
      const client = await this.client()
      await client.delete({
        index: this.index,
        id: logId,
        // refresh: 'wait_for'
        refresh: true
      })
      DATABASE_LOGGER.debug(`Deleted log with ID: ${logId}`)
    } catch (error) {
      DATABASE_LOGGER.error(`Error when deleting log entry: ${error.message}`)
      throw error
    }
  }

  async deleteOldLogs(): Promise<number> {
    const defaultLogRetention = '2592000000' // 30 days in milliseconds
    const currentTime = new Date().getTime()
    const xTime = parseInt(process.env.LOG_RETENTION_TIME || defaultLogRetention)
    const deleteBeforeTime = new Date(currentTime - xTime)

    try {
      const oldLogs = await this.retrieveMultipleLogs(new Date(0), deleteBeforeTime, 200)

      for (const log of oldLogs) {
        if (log.id) {
          await this.delete(log.id)
        }
      }

      return oldLogs ? oldLogs.length : 0
    } catch (error) {
      DATABASE_LOGGER.error(`Error when deleting old log entries: ${error.message}`)
      return 0
    }
  }

  async getLogsCount(): Promise<number> {
    try {
      const client = await this.client()
      const res = await client.count({
        index: this.index
      })
      return res && res.count ? res.count : 0
    } catch (e) {
      DATABASE_LOGGER.error('Unable to retrieve logs count: ' + e.message)
      return 0
    }
  }
}

export class ElasticsearchAccessListDatabase extends AbstractAccessListDatabase {
  private readonly index = elasticSchemas.accessListSchema.index

  private constructor(config: OceanNodeDBConfig) {
    super(config)
  }

  static async create(
    config: OceanNodeDBConfig
  ): Promise<ElasticsearchAccessListDatabase> {
    await ensureIndex(config, elasticSchemas.accessListSchema)
    return new ElasticsearchAccessListDatabase(config)
  }

  private client(): Promise<Client> {
    return createElasticsearchClientWithRetry(this.config)
  }

  private docId(chainId: number, contractAddress: string): string {
    return `${chainId}-${contractAddress.toLowerCase()}`
  }

  async create(
    chainId: number,
    contractAddress: string,
    transferable: boolean,
    block: number,
    txId: string,
    name?: string,
    symbol?: string
  ) {
    const id = this.docId(chainId, contractAddress)
    const lowerContract = contractAddress.toLowerCase()
    try {
      const client = await this.client()
      await client.update({
        index: this.index,
        id,
        body: {
          script: {
            source: `
              ctx._source.transferable = params.transferable;
              ctx._source.deploymentBlock = params.block;
              ctx._source.deploymentTxId = params.txId;
              if (params.name != null) { ctx._source.name = params.name; }
              if (params.symbol != null) { ctx._source.symbol = params.symbol; }
            `,
            lang: 'painless',
            params: { transferable, block, txId, name, symbol }
          },
          upsert: {
            chainId,
            contractAddress: lowerContract,
            name,
            symbol,
            transferable,
            users: [],
            deploymentBlock: block,
            deploymentTxId: txId
          }
        },
        refresh: 'wait_for'
      })
      return { id }
    } catch (error) {
      const errorMsg = `Error when upserting access list ${id}: ${error.message}`
      DATABASE_LOGGER.error(errorMsg)
      return null
    }
  }

  async retrieve(chainId: number, contractAddress: string) {
    const id = this.docId(chainId, contractAddress)
    try {
      const client = await this.client()
      const result = await client.get({
        index: this.index,
        id,
        refresh: true
      })
      return result._source
    } catch (error) {
      if (isStatus(error, 404)) {
        return null
      }
      const errorMsg = `Error when retrieving access list ${id}: ${error.message}`
      DATABASE_LOGGER.error(errorMsg)
      return null
    }
  }

  async addUser(chainId: number, contractAddress: string, user: AccessListUser) {
    const id = this.docId(chainId, contractAddress)
    const lowerContract = contractAddress.toLowerCase()
    const normalized: AccessListUser = { ...user, wallet: user.wallet.toLowerCase() }
    try {
      const client = await this.client()
      await client.update({
        index: this.index,
        id,
        body: {
          script: {
            source: `
              if (ctx._source.users == null) { ctx._source.users = []; }
              boolean exists = false;
              for (int i = 0; i < ctx._source.users.length; i++) {
                if (ctx._source.users[i].tokenId == params.user.tokenId) { exists = true; break; }
              }
              if (!exists) { ctx._source.users.add(params.user); }
            `,
            lang: 'painless',
            params: { user: normalized }
          },
          upsert: {
            chainId,
            contractAddress: lowerContract,
            transferable: false,
            users: [normalized]
          }
        },
        refresh: 'wait_for'
      })
      return { id }
    } catch (error) {
      const errorMsg = `Error when adding user ${normalized.wallet} to access list ${id}: ${error.message}`
      DATABASE_LOGGER.error(errorMsg)
      return null
    }
  }

  async removeUserByTokenId(chainId: number, contractAddress: string, tokenId: number) {
    const id = this.docId(chainId, contractAddress)
    try {
      const client = await this.client()
      await client.update({
        index: this.index,
        id,
        body: {
          script: {
            source: `
              if (ctx._source.users != null) {
                ctx._source.users.removeIf(u -> u.tokenId == params.tokenId);
              }
            `,
            lang: 'painless',
            params: { tokenId }
          }
        },
        refresh: 'wait_for'
      })
      return { id }
    } catch (error) {
      if (isStatus(error, 404)) {
        DATABASE_LOGGER.error(
          `AddressRemoved on missing access list ${id} (tokenId=${tokenId}); ignoring.`
        )
        return null
      }
      const errorMsg = `Error when removing tokenId ${tokenId} from access list ${id}: ${error.message}`
      DATABASE_LOGGER.error(errorMsg)
      return null
    }
  }

  async searchByWallet(wallet: string, chainId?: number): Promise<any[]> {
    const lowerWallet = wallet.toLowerCase()
    const filters: any[] = [
      {
        nested: {
          path: 'users',
          query: { term: { 'users.wallet': lowerWallet } }
        }
      }
    ]
    if (chainId !== undefined) {
      filters.push({ term: { chainId } })
    }
    try {
      const client = await this.client()
      const result = await client.search({
        index: this.index,
        size: 250,
        body: {
          query: { bool: { must: filters } }
        }
      } as any)
      return result.hits.hits.map((h: any) => h._source)
    } catch (error) {
      const errorMsg = `Error when searching access lists by wallet ${lowerWallet}: ${error.message}`
      DATABASE_LOGGER.error(errorMsg)
      return []
    }
  }

  async delete(chainId: number, contractAddress: string) {
    const id = this.docId(chainId, contractAddress)
    try {
      const client = await this.client()
      await client.delete({
        index: this.index,
        id,
        refresh: 'wait_for'
      })
      return { id }
    } catch (error) {
      const errorMsg = `Error when deleting access list ${id}: ${error.message}`
      DATABASE_LOGGER.error(errorMsg)
      return null
    }
  }
}

/**
 * Normalizes the document responses: adds an `id` property from the Elasticsearch `_id`
 * @param dbResult response from DB
 * @param _id id of the element
 * @returns result object with id property
 */
export function normalizeDocumentId(dbResult: any, _id?: any): any {
  if (_id && !dbResult.id) {
    dbResult.id = _id
  }
  return dbResult
}
