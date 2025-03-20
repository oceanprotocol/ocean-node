import { Client } from '@elastic/elasticsearch'
import {
  AbstractDdoDatabase,
  AbstractDdoStateDatabase,
  AbstractIndexerDatabase,
  AbstractLogDatabase,
  AbstractOrderDatabase
} from './BaseDatabase.js'
import { createElasticsearchClient } from './ElasticsearchConfigHelper.js'
import { OceanNodeDBConfig } from '../../@types'
import { ElasticsearchSchema } from './ElasticSchemas.js'
import { DATABASE_LOGGER } from '../../utils/logging/common.js'
import { GENERIC_EMOJIS, LOG_LEVELS_STR } from '../../utils/logging/Logger.js'
import { validateObject } from '../core/utils/validateDdoHandler.js'

export class ElasticsearchIndexerDatabase extends AbstractIndexerDatabase {
  private client: Client
  private index: string

  constructor(config: OceanNodeDBConfig) {
    super(config)
    this.client = new Client({ node: config.url })
    this.index = 'indexer'

    this.initializeIndex()
  }

  private async initializeIndex() {
    try {
      const indexExists = await this.client.indices.exists({ index: this.index })
      if (!indexExists) {
        await this.client.indices.create({
          index: this.index,
          body: {
            mappings: {
              properties: {
                id: { type: 'keyword' },
                lastIndexedBlock: { type: 'long' }
              }
            }
          }
        })
      }
    } catch (e) {
      DATABASE_LOGGER.error(e.message)
    }
  }

  async create(network: number, lastIndexedBlock: number) {
    try {
      await this.client.index({
        index: this.index,
        id: network.toString(),
        body: { lastIndexedBlock },
        refresh: 'wait_for'
      })
      return { id: network.toString(), lastIndexedBlock }
    } catch (error) {
      const errorMsg = `Error when creating indexer entry on network ${network} with last indexed block ${lastIndexedBlock}: ${error.message}`
      DATABASE_LOGGER.logMessageWithEmoji(
        errorMsg,
        true,
        GENERIC_EMOJIS.EMOJI_CROSS_MARK,
        LOG_LEVELS_STR.LEVEL_ERROR
      )
      return null
    }
  }

  async retrieve(network: number) {
    try {
      const result = await this.client.get({
        index: this.index,
        id: network.toString()
      })
      return result._source
    } catch (error) {
      const errorMsg = `Error when retrieving indexer entry on network ${network}: ${error.message}`
      DATABASE_LOGGER.logMessageWithEmoji(
        errorMsg,
        true,
        GENERIC_EMOJIS.EMOJI_CROSS_MARK,
        LOG_LEVELS_STR.LEVEL_ERROR
      )
      return null
    }
  }

  async update(network: number, lastIndexedBlock: number) {
    try {
      const exists = await this.client.exists({
        index: this.index,
        id: network.toString()
      })

      if (exists) {
        await this.client.update({
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
      DATABASE_LOGGER.logMessageWithEmoji(
        errorMsg,
        true,
        GENERIC_EMOJIS.EMOJI_CROSS_MARK,
        LOG_LEVELS_STR.LEVEL_ERROR
      )
      return null
    }
  }

  async delete(network: number) {
    try {
      await this.client.delete({
        index: this.index,
        id: network.toString(),
        refresh: 'wait_for'
      })
      return { id: network.toString() }
    } catch (error) {
      const errorMsg = `Error when deleting indexer entry on network ${network}: ${error.message}`
      DATABASE_LOGGER.logMessageWithEmoji(
        errorMsg,
        true,
        GENERIC_EMOJIS.EMOJI_CROSS_MARK,
        LOG_LEVELS_STR.LEVEL_ERROR
      )
      return null
    }
  }
}
export class ElasticsearchDdoStateDatabase extends AbstractDdoStateDatabase {
  private client: Client
  private index: string

  constructor(config: OceanNodeDBConfig) {
    super(config)
    this.client = new Client({ node: config.url })
    this.index = 'ddo_state'

    this.initializeIndex()
  }

  private async initializeIndex() {
    try {
      const indexExists = await this.client.indices.exists({ index: this.index })
      if (!indexExists) {
        await this.client.indices.create({
          index: this.index,
          body: {
            mappings: {
              properties: {
                id: { type: 'keyword' },
                chainId: { type: 'integer' },
                did: { type: 'keyword' },
                nft: { type: 'keyword' },
                txId: { type: 'keyword' },
                valid: { type: 'boolean' },
                error: { type: 'text' }
              }
            }
          }
        })
      }
    } catch (e) {
      DATABASE_LOGGER.error(e.message)
    }
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
      await this.client.index({
        index: this.index,
        id: did,
        body: { chainId, did, nft: nftAddress, txId, valid, error: errorMsg },
        refresh: 'wait_for'
      })
      return { id: did, chainId, nft: nftAddress, txId, valid, error: errorMsg }
    } catch (error) {
      const errorMessage = `Error when saving ddo state for: ${did} Error: ${error.message}`
      DATABASE_LOGGER.logMessageWithEmoji(
        errorMessage,
        true,
        GENERIC_EMOJIS.EMOJI_CROSS_MARK,
        LOG_LEVELS_STR.LEVEL_ERROR
      )
      return null
    }
  }

  async retrieve(did: string) {
    try {
      const result = await this.client.get({
        index: this.index,
        id: did
      })
      return result._source
    } catch (error) {
      const errorMessage = `Error when retrieving the state of the ddo with id: ${did}: ${error.message}`
      DATABASE_LOGGER.logMessageWithEmoji(
        errorMessage,
        true,
        GENERIC_EMOJIS.EMOJI_CROSS_MARK,
        LOG_LEVELS_STR.LEVEL_ERROR
      )
      return null
    }
  }

  async search(query: Record<string, any>) {
    try {
      const result = await this.client.search({
        index: this.index,
        query: {
          match: {
            [query.query_by]: query.q
          }
        }
      })
      return result.hits.hits.map((hit: any) => {
        return normalizeDocumentId(hit._source, hit._id)
      })
    } catch (error) {
      const errorMsg = `Error when searching by query ${JSON.stringify(query)}: ${
        error.message
      }`
      DATABASE_LOGGER.logMessageWithEmoji(
        errorMsg,
        true,
        GENERIC_EMOJIS.EMOJI_CROSS_MARK,
        LOG_LEVELS_STR.LEVEL_ERROR
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
      const exists = await this.client.exists({
        index: this.index,
        id: did
      })

      if (exists) {
        await this.client.update({
          index: this.index,
          id: did,
          body: {
            doc: { chainId, did, nft: nftAddress, txId, valid, error: errorMsg }
          },
          refresh: 'wait_for'
        })
      } else {
        return await this.create(chainId, did, nftAddress, txId, valid, errorMsg)
      }

      return { id: did, chainId, nft: nftAddress, txId, valid, error: errorMsg }
    } catch (error) {
      const errorMessage = `Error when updating ddo state for: ${did} Error: ${error.message}`
      DATABASE_LOGGER.logMessageWithEmoji(
        errorMessage,
        true,
        GENERIC_EMOJIS.EMOJI_CROSS_MARK,
        LOG_LEVELS_STR.LEVEL_ERROR
      )
      return null
    }
  }

  async delete(did: string) {
    try {
      await this.client.delete({
        index: this.index,
        id: did,
        refresh: 'wait_for'
      })
      return { id: did }
    } catch (error) {
      const errorMessage = `Error when deleting ddo state ${did}: ${error.message}`
      DATABASE_LOGGER.logMessageWithEmoji(
        errorMessage,
        true,
        GENERIC_EMOJIS.EMOJI_CROSS_MARK,
        LOG_LEVELS_STR.LEVEL_ERROR
      )
      return null
    }
  }
}
export class ElasticsearchOrderDatabase extends AbstractOrderDatabase {
  private provider: Client

  constructor(config: OceanNodeDBConfig, schema: ElasticsearchSchema) {
    super(config, schema)
    this.provider = createElasticsearchClient(config)
  }

  getSchema(): ElasticsearchSchema {
    return this.schema as ElasticsearchSchema
  }

  async search(
    query: Record<string, any>,
    maxResultsPerPage?: number,
    pageNumber?: number
  ) {
    try {
      const { q, ...queryObj } = query

      const searchParams = {
        index: this.getSchema().index,
        body: {
          query: {
            match: q ? { _all: q } : queryObj
          },
          from: (pageNumber - 1) * maxResultsPerPage || 0,
          size: maxResultsPerPage || 10
        }
      }
      const result = await this.provider.search(searchParams)
      return result.hits.hits.map((hit: any) => {
        return normalizeDocumentId(hit._source, hit._id)
      })
    } catch (error) {
      const errorMsg =
        `Error when searching order entry by query ${JSON.stringify(query)}: ` +
        error.message
      DATABASE_LOGGER.logMessageWithEmoji(errorMsg, true, LOG_LEVELS_STR.LEVEL_ERROR)
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
      await this.provider.index({
        index: this.getSchema().index,
        id: orderId,
        body: document
      })
      return document
    } catch (error) {
      const errorMsg =
        `Error when creating order entry ${orderId} at timestamp ${timestamp} by payer ${payer} for consumer ${consumer}: ` +
        error.message
      DATABASE_LOGGER.logMessageWithEmoji(errorMsg, true, LOG_LEVELS_STR.LEVEL_ERROR)
      return null
    }
  }

  async retrieve(orderId: string) {
    try {
      const result = await this.provider.get({
        index: this.getSchema().index,
        id: orderId
      })
      return normalizeDocumentId(result._source, result._id)
    } catch (error) {
      const errorMsg = `Error when retrieving order ${orderId}: ` + error.message
      DATABASE_LOGGER.logMessageWithEmoji(errorMsg, true, LOG_LEVELS_STR.LEVEL_ERROR)
      return null
    }
  }

  async update(
    orderId: string,
    type: string,
    timestamp: number,
    consumer: string,
    payer: string,
    datatokenAddress?: string,
    startOrderId?: string
  ) {
    try {
      const document = {
        type,
        timestamp,
        consumer,
        payer,
        datatokenAddress,
        startOrderId
      }
      await this.provider.update({
        index: this.getSchema().index,
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
      DATABASE_LOGGER.logMessageWithEmoji(errorMsg, true, LOG_LEVELS_STR.LEVEL_ERROR)
      return null
    }
  }

  async delete(orderId: string) {
    try {
      await this.provider.delete({
        index: this.getSchema().index,
        id: orderId
      })
      return { id: orderId }
    } catch (error) {
      const errorMsg = `Error when deleting order ${orderId}: ` + error.message
      DATABASE_LOGGER.logMessageWithEmoji(errorMsg, true, LOG_LEVELS_STR.LEVEL_ERROR)
      return null
    }
  }
}

export class ElasticsearchDdoDatabase extends AbstractDdoDatabase {
  private client: Client

  constructor(config: OceanNodeDBConfig, schemas: ElasticsearchSchema[]) {
    super(config, schemas)
    this.client = createElasticsearchClient(config)
  }

  getSchemas(): ElasticsearchSchema[] {
    return this.schemas as ElasticsearchSchema[]
  }

  getDDOSchema(ddo: Record<string, any>) {
    let schemaName: string | undefined
    if (ddo.indexedMetadata?.nft?.state !== 0) {
      schemaName = 'op_ddo_short'
    } else if (ddo.version) {
      schemaName = `op_ddo_v${ddo.version}`
    }
    const schema = this.getSchemas().find((s) => s.index === schemaName)
    DATABASE_LOGGER.logMessageWithEmoji(
      `Returning schema: ${schemaName}`,
      true,
      GENERIC_EMOJIS.EMOJI_OCEAN_WAVE,
      LOG_LEVELS_STR.LEVEL_INFO
    )
    return schema
  }

  async validateDDO(ddo: Record<string, any>): Promise<boolean> {
    if ('indexedMetadata' in ddo && ddo.indexedMetadata.nft?.state !== 0) {
      // Skipping validation for short DDOs as it currently doesn't work
      // TODO: DDO validation needs to be updated to consider the fields required by the schema
      // See github issue: https://github.com/oceanprotocol/ocean-node/issues/256
      return true
    } else if ('nft' in ddo && ddo.nft?.state !== 0) {
      return true
    } else {
      const validation = await validateObject(ddo, ddo.chainId, ddo.nftAddress)
      if (validation[0] === true) {
        DATABASE_LOGGER.logMessageWithEmoji(
          `Validation of DDO with did: ${ddo.id} has passed`,
          true,
          GENERIC_EMOJIS.EMOJI_OCEAN_WAVE,
          LOG_LEVELS_STR.LEVEL_INFO
        )
        return true
      } else {
        DATABASE_LOGGER.logMessageWithEmoji(
          `Validation of DDO with schema version ${ddo.version} failed with errors: ` +
            JSON.stringify(validation[1]),
          true,
          GENERIC_EMOJIS.EMOJI_CROSS_MARK,
          LOG_LEVELS_STR.LEVEL_ERROR
        )
        return false
      }
    }
  }

  async search(query: Record<string, any>): Promise<any> {
    const results = []
    const maxPerPage = query.size || 100
    const from = (query.from || 1) * maxPerPage - maxPerPage

    if (query.index) {
      const { index, ...queryWithoutIndex } = query
      try {
        const response = await this.client.search({
          index,
          body: {
            ...queryWithoutIndex,
            from,
            size: maxPerPage
          }
        })
        if (response.hits?.hits.length > 0) {
          const nomalizedResponse = response.hits.hits.map((hit: any) => {
            return normalizeDocumentId(hit._source, hit._id)
          })
          results.push(nomalizedResponse)
        }
      } catch (error) {
        const schemaErrorMsg = `Error for schema ${query.index}: ${error.message}`
        DATABASE_LOGGER.logMessageWithEmoji(
          schemaErrorMsg,
          true,
          GENERIC_EMOJIS.EMOJI_CROSS_MARK,
          LOG_LEVELS_STR.LEVEL_WARN
        )
      }
    } else {
      for (const schema of this.getSchemas()) {
        try {
          const response = await this.client.search({
            index: schema.index,
            body: {
              ...query,
              from,
              size: maxPerPage
            }
          })
          if (response.hits?.hits.length > 0) {
            const nomalizedResponse = response.hits.hits.map((hit: any) => {
              return normalizeDocumentId(hit._source, hit._id)
            })
            results.push(nomalizedResponse)
          }
        } catch (error) {
          const schemaErrorMsg = `Error for schema ${schema.index}: ${error.message}`
          DATABASE_LOGGER.logMessageWithEmoji(
            schemaErrorMsg,
            true,
            GENERIC_EMOJIS.EMOJI_CROSS_MARK,
            LOG_LEVELS_STR.LEVEL_WARN
          )
          continue
        }
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
      // avoid issue with nft fields, due to schema
      // ddo.nft = ddo?.indexedMetadata?.nft
      if (ddo?.indexedMetadata?.nft) delete ddo.nft
      const validation = await this.validateDDO(ddo)
      if (validation === true) {
        const response = await this.client.index({
          index: schema.index,
          id: ddo.id,
          body: ddo
        })
        return response
      } else {
        throw new Error(`Validation of DDO with schema version ${ddo.version} failed`)
      }
    } catch (error) {
      const errorMsg = `Error when creating DDO entry ${ddo.id}: ${error.message}`
      DATABASE_LOGGER.logMessageWithEmoji(
        errorMsg,
        true,
        GENERIC_EMOJIS.EMOJI_CROSS_MARK,
        LOG_LEVELS_STR.LEVEL_ERROR
      )
      return null
    }
  }

  async retrieve(id: string): Promise<any> {
    let ddo = null
    for (const schema of this.getSchemas()) {
      try {
        const response = await this.client.get({
          index: schema.index,
          id
        })
        if (response.found) {
          ddo = response._source
          break
        }
      } catch (error) {
        if (error.statusCode !== 404) {
          DATABASE_LOGGER.logMessageWithEmoji(
            `Error when retrieving DDO entry ${id} from schema ${schema.index}: ${error.message}`,
            true,
            GENERIC_EMOJIS.EMOJI_CROSS_MARK,
            LOG_LEVELS_STR.LEVEL_ERROR
          )
        }
      }
    }

    if (!ddo) {
      DATABASE_LOGGER.logMessageWithEmoji(
        `DDO entry with ID ${id} not found in any schema.`,
        true,
        GENERIC_EMOJIS.EMOJI_CROSS_MARK,
        LOG_LEVELS_STR.LEVEL_ERROR
      )
    }

    return ddo
  }

  // This is called from indexer "createOrUpdateDDO"
  // we add the "id" field to match the response API with typesense
  // since here we have an "_id"
  async update(ddo: Record<string, any>): Promise<any> {
    const schema = this.getDDOSchema(ddo)
    if (!schema) {
      throw new Error(`Schema for version ${ddo.version} not found`)
    }
    try {
      // avoid issue with nft fields, due to schema
      // ddo.nft = ddo?.indexedMetadata?.nft
      if (ddo?.indexedMetadata?.nft) delete ddo.nft
      const validation = await this.validateDDO(ddo)
      if (validation === true) {
        const response: any = await this.client.update({
          index: schema.index,
          id: ddo.id,
          body: {
            doc: ddo
          }
        })
        // make sure we do not have different responses 4 between DBs
        // do the same thing on other methods
        if (response._id === ddo.id) {
          return normalizeDocumentId(response, response._id)
        }
        return response
      } else {
        throw new Error(
          `Validation of DDO with schema version ${ddo.version} failed with errors`
        )
      }
    } catch (error) {
      if (error.statusCode === 404) {
        await this.delete(ddo.id)
        const response = await this.create(ddo)
        if (response._id === ddo.id) {
          return normalizeDocumentId(response, response._id)
        }
        return response
      }
      const errorMsg = `Error when updating DDO entry ${ddo.id}: ${error.message}`
      DATABASE_LOGGER.logMessageWithEmoji(
        errorMsg,
        true,
        GENERIC_EMOJIS.EMOJI_CROSS_MARK,
        LOG_LEVELS_STR.LEVEL_ERROR
      )
      return null
    }
  }

  async delete(id: string): Promise<any> {
    let isDeleted = false
    for (const schema of this.getSchemas()) {
      try {
        const response = await this.client.delete({
          index: schema.index,
          id
        })
        isDeleted = response.result === 'deleted'
        if (isDeleted) {
          DATABASE_LOGGER.debug(
            `Response for deleting the ddo: ${response.result}, isDeleted: ${isDeleted}`
          )
          return response
        }
      } catch (error) {
        if (error.statusCode !== 404) {
          DATABASE_LOGGER.logMessageWithEmoji(
            `Error when deleting DDO entry ${id} from schema ${schema.index}: ${error.message}`,
            true,
            GENERIC_EMOJIS.EMOJI_CROSS_MARK,
            LOG_LEVELS_STR.LEVEL_ERROR
          )
        }
      }
    }

    if (!isDeleted) {
      DATABASE_LOGGER.logMessageWithEmoji(
        `DDO entry with ID ${id} not found in any schema or could not be deleted.`,
        true,
        GENERIC_EMOJIS.EMOJI_CROSS_MARK,
        LOG_LEVELS_STR.LEVEL_ERROR
      )
    }
  }

  async deleteAllAssetsFromChain(chainId: number, batchSize?: number): Promise<number> {
    let numDeleted = 0
    for (const schema of this.getSchemas()) {
      try {
        // add batch size logic
        const response = await this.client.deleteByQuery({
          index: schema.index,
          body: {
            query: {
              match: { chainId }
            }
          }
        })

        DATABASE_LOGGER.debug(
          `Number of deleted ddos on schema ${schema.index}: ${response.deleted}`
        )

        numDeleted += response.deleted
      } catch (error) {
        if (error.statusCode !== 404) {
          DATABASE_LOGGER.logMessageWithEmoji(
            `Error when deleting DDOs from schema ${schema.index}: ${error.message}`,
            true,
            GENERIC_EMOJIS.EMOJI_CROSS_MARK,
            LOG_LEVELS_STR.LEVEL_ERROR
          )
        }
      }
    }

    return numDeleted
  }
}

export class ElasticsearchLogDatabase extends AbstractLogDatabase {
  private client: Client
  private index: string

  constructor(config: OceanNodeDBConfig) {
    super(config)
    this.client = new Client({ node: config.url })
    this.index = 'log'

    this.initializeIndex()
  }

  private async initializeIndex() {
    try {
      const indexExists = await this.client.indices.exists({ index: this.index })
      if (!indexExists) {
        await this.client.indices.create({
          index: this.index,
          body: {
            mappings: {
              properties: {
                timestamp: { type: 'date' },
                level: { type: 'keyword' },
                moduleName: { type: 'keyword' },
                message: { type: 'text' },
                meta: { type: 'object', enabled: false }
              }
            }
          }
        })
      }
    } catch (e) {
      DATABASE_LOGGER.error(e.message)
    }
  }

  async insertLog(logEntry: Record<string, any>) {
    try {
      const timestamp = new Date().toISOString()
      const result = await this.client.index({
        index: this.index,
        body: { ...logEntry, timestamp },
        refresh: 'wait_for'
      })
      // uniformize result response (we need an id for the retrieveLog API)
      if (result._id) {
        return normalizeDocumentId(logEntry, result._id)
      }
      return logEntry
    } catch (error) {
      const errorMsg = `Error when inserting log entry: ${error.message}`
      DATABASE_LOGGER.logMessageWithEmoji(
        errorMsg,
        true,
        GENERIC_EMOJIS.EMOJI_CROSS_MARK,
        LOG_LEVELS_STR.LEVEL_ERROR
      )
      return null
    }
  }

  async retrieveLog(id: string): Promise<Record<string, any> | null> {
    try {
      const result = await this.client.get({
        index: this.index,
        id
      })
      return normalizeDocumentId(result._source, result._id)
    } catch (error) {
      const errorMsg = `Error when retrieving log entry: ${error.message}`
      DATABASE_LOGGER.logMessageWithEmoji(
        errorMsg,
        true,
        GENERIC_EMOJIS.EMOJI_CROSS_MARK,
        LOG_LEVELS_STR.LEVEL_ERROR
      )
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

      const numLogs = await this.getLogsCount()
      const from = (page || 0) * Math.min(maxLogs, 250)
      const size = Math.min(maxLogs, 250)
      // not checking this limits will throw:
      // illegal_argument_exception: Result window is too large, from + size must be less than or equal to: [10000] but was [XYZ]
      if (from > 10000 || size > 10000 || size > numLogs) {
        DATABASE_LOGGER.logMessageWithEmoji(
          `Result window is too large, from + size must be less than or equal to: [10000]. "from": ${from}", "size": ${size}, "num": ${numLogs}`,
          true,
          GENERIC_EMOJIS.EMOJI_CROSS_MARK,
          LOG_LEVELS_STR.LEVEL_ERROR
        )
        return []
      }
      const result = await this.client.search({
        index: this.index,
        body: {
          query: filterConditions,
          sort: [{ timestamp: { order: 'desc' } }]
        },
        size,
        from
      })

      return result.hits.hits.map((hit: any) => {
        return normalizeDocumentId(hit._source, hit._id)
      })
    } catch (error) {
      const errorMsg = `Error when retrieving multiple log entries: ${error.message}`
      DATABASE_LOGGER.logMessageWithEmoji(
        errorMsg,
        true,
        GENERIC_EMOJIS.EMOJI_CROSS_MARK,
        LOG_LEVELS_STR.LEVEL_ERROR
      )
      return []
    }
  }

  async delete(logId: string): Promise<void> {
    if (!logId) {
      throw new Error('Log ID is required for deletion.')
    }
    try {
      await this.client.delete({
        index: this.index,
        id: logId,
        refresh: 'wait_for'
      })
      DATABASE_LOGGER.logMessageWithEmoji(
        `Deleted log with ID: ${logId}`,
        true,
        GENERIC_EMOJIS.EMOJI_CHECK_MARK,
        LOG_LEVELS_STR.LEVEL_INFO
      )
    } catch (error) {
      DATABASE_LOGGER.logMessageWithEmoji(
        `Error when deleting log entry: ${error.message}`,
        true,
        GENERIC_EMOJIS.EMOJI_CROSS_MARK,
        LOG_LEVELS_STR.LEVEL_ERROR
      )
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
      DATABASE_LOGGER.logMessageWithEmoji(
        `Error when deleting old log entries: ${error.message}`,
        true,
        GENERIC_EMOJIS.EMOJI_CROSS_MARK,
        LOG_LEVELS_STR.LEVEL_ERROR
      )
      return 0
    }
  }

  async getLogsCount(): Promise<number> {
    try {
      const res = await this.client.count({
        index: this.index
      })
      return res && res.count ? res.count : 0
    } catch (e) {
      DATABASE_LOGGER.error('Unable to retrieve logs count: ' + e.message)
      return 0
    }
  }
}

/**
 * Make DB agnostic APIs. The response should be similar, no matter what DB engine is used
 * Normalizes the document responses to match same kind of typesense ones
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
