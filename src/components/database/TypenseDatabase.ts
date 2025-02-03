import { OceanNodeDBConfig } from '../../@types/OceanNode.js'
import { convertTypesenseConfig, Typesense, TypesenseError } from './typesense.js'
import { TypesenseSchema } from './TypesenseSchemas.js'
import { TypesenseSearchParams } from '../../@types/index.js'
import { LOG_LEVELS_STR, GENERIC_EMOJIS } from '../../utils/logging/Logger.js'
import { DATABASE_LOGGER } from '../../utils/logging/common.js'

import { validateObject } from '../core/utils/validateDdoHandler.js'
import { ENVIRONMENT_VARIABLES, TYPESENSE_HITS_CAP } from '../../utils/constants.js'
import {
  AbstractDdoDatabase,
  AbstractDdoStateDatabase,
  AbstractIndexerDatabase,
  AbstractLogDatabase,
  AbstractOrderDatabase
} from './BaseDatabase.js'

export class TypesenseOrderDatabase extends AbstractOrderDatabase {
  private provider: Typesense

  constructor(config: OceanNodeDBConfig, schema: TypesenseSchema) {
    super(config, schema)
    return (async (): Promise<TypesenseOrderDatabase> => {
      this.provider = new Typesense({
        ...convertTypesenseConfig(this.config.url),
        logger: DATABASE_LOGGER
      })
      try {
        await this.provider.collections(this.getSchema().name).retrieve()
      } catch (error) {
        if (error instanceof TypesenseError && error.httpStatus === 404) {
          await this.provider.collections().create(this.getSchema())
        }
      }
      return this
    })() as unknown as TypesenseOrderDatabase
  }

  getSchema(): TypesenseSchema {
    return this.schema as TypesenseSchema
  }

  async search(
    query: Record<string, any>,
    maxResultsPerPage?: number,
    pageNumber?: number
  ) {
    try {
      let queryObj: TypesenseSearchParams

      // if queryObj is a string
      if (typeof query === 'string') {
        queryObj = JSON.parse(query)
      } else {
        queryObj = query as TypesenseSearchParams
      }

      // Check if the necessary properties are present
      if (!queryObj.q || !queryObj.query_by) {
        throw new Error("The query object must include 'q' and 'query_by' properties.")
      }
      const maxPerPage = maxResultsPerPage
        ? Math.min(maxResultsPerPage, TYPESENSE_HITS_CAP)
        : TYPESENSE_HITS_CAP // Cap maxResultsPerPage at 250
      const page = pageNumber || 1 // Default to the first page if pageNumber is not provided

      // Modify the query to include pagination parameters
      const searchParams: TypesenseSearchParams = {
        ...queryObj,
        per_page: maxPerPage,
        page
      }

      const result = await this.provider
        .collections(this.getSchema().name)
        .documents()
        .search(searchParams)

      // Instead of pushing the entire result, only include the documents
      return result.hits.map((hit) => hit.document)
    } catch (error) {
      const errorMsg =
        `Error when searching order entry by query ${JSON.stringify(query)}: ` +
        error.message
      DATABASE_LOGGER.logMessageWithEmoji(
        errorMsg,
        true,
        GENERIC_EMOJIS.EMOJI_CROSS_MARK,
        LOG_LEVELS_STR.LEVEL_ERROR
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
      return await this.provider.collections(this.getSchema().name).documents().create({
        id: orderId,
        type,
        timestamp,
        consumer,
        payer,
        datatokenAddress,
        nftAddress,
        did,
        startOrderId
      })
    } catch (error) {
      const errorMsg =
        `Error when creating order entry ${orderId} at timestamp ${timestamp} by payer ${payer} for consumer ${consumer}: ` +
        error.message
      DATABASE_LOGGER.logMessageWithEmoji(
        errorMsg,
        true,
        GENERIC_EMOJIS.EMOJI_CROSS_MARK,
        LOG_LEVELS_STR.LEVEL_ERROR
      )
      return null
    }
  }

  async retrieve(orderId: string) {
    try {
      return await this.provider
        .collections(this.getSchema().name)
        .documents()
        .retrieve(orderId)
    } catch (error) {
      const errorMsg = `Error when retrieving order ${orderId}: ` + error.message
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
    orderId: string,
    type: string,
    timestamp: number,
    consumer: string,
    payer: string,
    datatokenAddress?: string,
    startOrderId?: string
  ) {
    try {
      return await this.provider
        .collections(this.getSchema().name)
        .documents()
        .update(orderId, {
          type,
          timestamp,
          consumer,
          payer,
          datatokenAddress,
          startOrderId
        })
    } catch (error) {
      if (error instanceof TypesenseError && error.httpStatus === 404) {
        return await this.provider
          .collections(this.getSchema().name)
          .documents()
          .create({ id: orderId, type, timestamp, consumer, payer, startOrderId })
      }
      const errorMsg =
        `Error when updating order entry ${orderId} at timestamp ${timestamp} by payer ${payer} for consumer ${consumer}: ` +
        error.message
      DATABASE_LOGGER.logMessageWithEmoji(
        errorMsg,
        true,
        GENERIC_EMOJIS.EMOJI_CROSS_MARK,
        LOG_LEVELS_STR.LEVEL_ERROR
      )
      return null
    }
  }

  async delete(orderId: string) {
    try {
      return await this.provider
        .collections(this.getSchema().name)
        .documents()
        .delete(orderId)
    } catch (error) {
      const errorMsg = `Error when deleting order ${orderId}: ` + error.message
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

export class TypesenseDdoStateDatabase extends AbstractDdoStateDatabase {
  private provider: Typesense

  constructor(config: OceanNodeDBConfig, schema: TypesenseSchema) {
    super(config, schema)
    return (async (): Promise<TypesenseDdoStateDatabase> => {
      this.provider = new Typesense({
        ...convertTypesenseConfig(this.config.url),
        logger: DATABASE_LOGGER
      })
      try {
        await this.provider.collections(this.schema.name).retrieve()
      } catch (error) {
        if (error instanceof TypesenseError && error.httpStatus === 404) {
          await this.provider.collections().create(this.schema)
        }
      }
      return this
    })() as unknown as TypesenseDdoStateDatabase
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
      return await this.provider
        .collections(this.schema.name)
        .documents()
        .create({ id: did, chainId, did, nft: nftAddress, txId, valid, error: errorMsg })
    } catch (error) {
      const errorMsg = `Error when saving ddo state for: ${did} Error: ` + error.message
      DATABASE_LOGGER.logMessageWithEmoji(
        errorMsg,
        true,
        GENERIC_EMOJIS.EMOJI_CROSS_MARK,
        LOG_LEVELS_STR.LEVEL_ERROR
      )
      return null
    }
  }

  async retrieve(did: string) {
    try {
      return await this.provider.collections(this.schema.name).documents().retrieve(did)
    } catch (error) {
      const errorMsg =
        `Error when retrieving the state of the ddo with id: ${did}: ` + error.message
      DATABASE_LOGGER.logMessageWithEmoji(
        errorMsg,
        true,
        GENERIC_EMOJIS.EMOJI_CROSS_MARK,
        LOG_LEVELS_STR.LEVEL_ERROR
      )
      return null
    }
  }

  async search(query: Record<string, any>) {
    try {
      const result = await this.provider
        .collections(this.schema.name)
        .documents()
        .search(query as TypesenseSearchParams)
      return result
    } catch (error) {
      const errorMsg = `Error when searching by query ${query}: ` + error.message
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
      return await this.provider
        .collections(this.schema.name)
        .documents()
        .update(did, { chainId, did, nft: nftAddress, txId, valid, error: errorMsg })
    } catch (error) {
      if (error instanceof TypesenseError && error.httpStatus === 404) {
        return await this.provider.collections(this.schema.name).documents().create({
          id: did,
          chainId,
          did,
          nft: nftAddress,
          txId,
          valid,
          error: errorMsg
        })
      }
      const errorMessage =
        `Error when saving ddo state for: ${did} Error: ` + error.message
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
      return await this.provider.collections(this.schema.name).documents().delete(did)
    } catch (error) {
      const errorMsg = `Error when deleting ddo state ${did}: ` + error.message
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

export class TypesenseDdoDatabase extends AbstractDdoDatabase {
  private provider: Typesense

  constructor(config: OceanNodeDBConfig, schemas: TypesenseSchema[]) {
    super(config, schemas)
    return (async (): Promise<TypesenseDdoDatabase> => {
      this.provider = new Typesense({
        ...convertTypesenseConfig(this.config.url),
        logger: DATABASE_LOGGER
      })
      for (const ddoSchema of this.getSchemas()) {
        try {
          await this.provider.collections(ddoSchema.name).retrieve()
        } catch (error) {
          if (error instanceof TypesenseError && error.httpStatus === 404) {
            await this.provider.collections().create(ddoSchema)
          }
        }
      }
      return this
    })() as unknown as TypesenseDdoDatabase
  }

  getSchemas(): TypesenseSchema[] {
    return this.schemas as TypesenseSchema[]
  }

  getDDOSchema(ddo: Record<string, any>): TypesenseSchema {
    // Find the schema based on the DDO version OR use the short DDO schema when state !== 0
    let schemaName: string
    if (ddo.indexedMetadata?.nft?.state !== 0) {
      schemaName = 'op_ddo_short'
    } else if (ddo.version) {
      schemaName = `op_ddo_v${ddo.version}`
    }
    const schema = this.getSchemas().find((s) => s.name === schemaName)
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

  async search(
    query: Record<string, any>,
    maxResultsPerPage?: number,
    pageNumber?: number
  ) {
    try {
      let queryObj: TypesenseSearchParams
      // if queryObj is a string
      if (typeof query === 'string') {
        queryObj = JSON.parse(query) as TypesenseSearchParams
      } else {
        queryObj = query as TypesenseSearchParams
      }

      const maxPerPage = maxResultsPerPage
        ? Math.min(maxResultsPerPage, TYPESENSE_HITS_CAP)
        : TYPESENSE_HITS_CAP // Cap maxResultsPerPage at 250
      const page = pageNumber || 1 // Default to the first page if pageNumber is not provided
      const results = []

      for (const schema of this.getSchemas()) {
        // Extend the query with pagination parameters
        const searchParams: TypesenseSearchParams = {
          ...queryObj,
          per_page: maxPerPage,
          page
        }
        const result = await this.provider
          .collections(schema.name)
          .documents()
          .search(searchParams)
        results.push(result)
      }

      return results
    } catch (error) {
      const errorMsg =
        `Error when searching by query ${JSON.stringify(query)}: ` + error.message
      DATABASE_LOGGER.logMessageWithEmoji(
        errorMsg,
        true,
        GENERIC_EMOJIS.EMOJI_CROSS_MARK,
        LOG_LEVELS_STR.LEVEL_ERROR
      )
      return null
    }
  }

  async create(ddo: Record<string, any>) {
    const schema = this.getDDOSchema(ddo)
    if (!schema) {
      throw new Error(`Schema for version ${ddo.version} not found`)
    }
    try {
      const validation = await this.validateDDO(ddo)
      if (validation === true) {
        return await this.provider
          .collections(schema.name)
          .documents()
          .create({ ...ddo })
      } else {
        throw new Error(`Validation of DDO with schema version ${ddo.version} failed`)
      }
    } catch (error) {
      const errorMsg = `Error when creating DDO entry ${ddo.id}: ` + error.message
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
        ddo = await this.provider.collections(schema.name).documents().retrieve(id)
        if (ddo) {
          break
        }
      } catch (error) {
        if (!(error instanceof TypesenseError && error.httpStatus === 404)) {
          // Log error other than not found
          DATABASE_LOGGER.logMessageWithEmoji(
            `Error when retrieving DDO entry ${id} from schema ${schema.name}: ` +
              error.message,
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

  async update(ddo: Record<string, any>) {
    const schema = this.getDDOSchema(ddo)
    if (!schema) {
      throw new Error(`Schema for version ${ddo.version} not found`)
    }
    try {
      const validation = await this.validateDDO(ddo)
      if (validation === true) {
        return await this.provider
          .collections(schema.name)
          .documents()
          .update(ddo.id, ddo)
      } else {
        throw new Error(
          `Validation of DDO with schema version ${ddo.version} failed with errors`
        )
      }
    } catch (error) {
      if (error instanceof TypesenseError && error.httpStatus === 404) {
        // No DDO was found to update so we will create a new one.
        // First we must delete the old version if it exist in another collection
        await this.delete(ddo.id)

        return await this.create(ddo)
      }
      const errorMsg = `Error when updating DDO entry ${ddo.id}: ` + error.message
      DATABASE_LOGGER.logMessageWithEmoji(
        errorMsg,
        true,
        GENERIC_EMOJIS.EMOJI_CROSS_MARK,
        LOG_LEVELS_STR.LEVEL_ERROR
      )
      return null
    }
  }

  async delete(did: string) {
    let isDeleted = false
    for (const schema of this.getSchemas()) {
      try {
        const response = await this.provider
          .collections(schema.name)
          .documents()
          .delete(did)
        if (response.id === did) {
          isDeleted = true
          DATABASE_LOGGER.debug(
            `Response for deleting the ddo: ${response.id}, isDeleted: ${isDeleted}`
          )
          return response
        }
      } catch (error) {
        if (!(error instanceof TypesenseError && error.httpStatus === 404)) {
          // Log error other than not found
          DATABASE_LOGGER.logMessageWithEmoji(
            `Error when deleting DDO entry ${did} from schema ${schema.name}: ` +
              error.message,
            true,
            GENERIC_EMOJIS.EMOJI_CROSS_MARK,
            LOG_LEVELS_STR.LEVEL_ERROR
          )
        }
      }
    }

    if (!isDeleted) {
      DATABASE_LOGGER.logMessageWithEmoji(
        `DDO entry with ID ${did} not found in any schema or could not be deleted.`,
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
        const response = await this.provider
          .collections(schema.name)
          .documents()
          .deleteByChainId(`chainId:${chainId}`, batchSize)

        DATABASE_LOGGER.debug(
          `Number of deleted ddos on schema ${schema} : ${response.num_deleted}`
        )

        numDeleted += response.num_deleted
      } catch (error) {
        if (!(error instanceof TypesenseError && error.httpStatus === 404)) {
          // Log error other than not found
          DATABASE_LOGGER.logMessageWithEmoji(
            `Error when deleting DDOs from schema ${schema.name}: ` + error.message,
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

export class TypesenseIndexerDatabase extends AbstractIndexerDatabase {
  private provider: Typesense

  constructor(config: OceanNodeDBConfig, schema: TypesenseSchema) {
    super(config, schema)
    return (async (): Promise<TypesenseIndexerDatabase> => {
      this.provider = new Typesense({
        ...convertTypesenseConfig(this.config.url),
        logger: DATABASE_LOGGER
      })
      try {
        await this.provider.collections(this.schema.name).retrieve()
      } catch (error) {
        if (error instanceof TypesenseError && error.httpStatus === 404) {
          await this.provider.collections().create(this.schema)
        }
      }
      return this
    })() as unknown as TypesenseIndexerDatabase
  }

  async create(network: number, lastIndexedBlock: number) {
    try {
      return await this.provider
        .collections(this.schema.name)
        .documents()
        .create({ id: network.toString(), lastIndexedBlock })
    } catch (error) {
      const errorMsg =
        `Error when creating indexer entry on network ${network.toString()} with last indexed block ${lastIndexedBlock}: ` +
        error.message
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
      return await this.provider
        .collections(this.schema.name)
        .documents()
        .retrieve(network.toString())
    } catch (error) {
      const errorMsg =
        `Error when retrieving indexer entry on network ${network.toString()}: ` +
        error.message
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
      return await this.provider
        .collections(this.schema.name)
        .documents()
        .update(network.toString(), { lastIndexedBlock })
    } catch (error) {
      if (error instanceof TypesenseError && error.httpStatus === 404) {
        return await this.provider
          .collections(this.schema.name)
          .documents()
          .create({ id: network.toString(), lastIndexedBlock })
      }
      const errorMsg =
        `Error when updating indexer entry on network ${network.toString()} with last indexed block ${lastIndexedBlock}: ` +
        error.message
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
      return await this.provider
        .collections(this.schema.name)
        .documents()
        .delete(network.toString())
    } catch (error) {
      const errorMsg =
        `Error when deleting indexer entry on network ${network.toString()}: ` +
        error.message
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

export class TypesenseLogDatabase extends AbstractLogDatabase {
  private provider: Typesense

  constructor(config: OceanNodeDBConfig, schema: TypesenseSchema) {
    super(config, schema)
    return (async (): Promise<TypesenseLogDatabase> => {
      this.provider = new Typesense({
        ...convertTypesenseConfig(this.config.url),
        logger: DATABASE_LOGGER
      })
      try {
        await this.provider.collections(this.schema.name).retrieve()
      } catch (error) {
        if (error instanceof TypesenseError && error.httpStatus === 404) {
          try {
            await this.provider.collections().create(this.schema)
          } catch (creationError) {
            // logger.log(
            // 'info',
            // `Error creating schema for '${this.schema.name}' collection: '${creationError}'`
            // )
          }
        }
      }
      return this
    })() as unknown as TypesenseLogDatabase
  }

  async insertLog(logEntry: Record<string, any>) {
    try {
      return await this.provider
        .collections(this.schema.name)
        .documents()
        .create(logEntry)
    } catch (error) {
      const errorMsg = `Error when inserting log entry: ` + error.message
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
      return await this.provider.collections(this.schema.name).documents().retrieve(id)
    } catch (error) {
      const errorMsg = `Error when retrieving log entry: ` + error.message
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
      let filterConditions = `timestamp:>=${startTime.getTime()} && timestamp:<${endTime.getTime()}`
      if (moduleName) {
        filterConditions += ` && moduleName:${moduleName}`
      }
      if (level) {
        filterConditions += ` && level:${level}`
      }

      const logsLimit = Math.min(maxLogs, TYPESENSE_HITS_CAP)
      if (maxLogs > TYPESENSE_HITS_CAP) {
        DATABASE_LOGGER.logMessageWithEmoji(
          `Max logs is capped at 250 as Typesense is unable to return more results per page.`,
          true,
          GENERIC_EMOJIS.EMOJI_OCEAN_WAVE,
          LOG_LEVELS_STR.LEVEL_INFO
        )
      }

      // Define search parameters
      const searchParameters = {
        q: '*',
        query_by: 'message,level,meta',
        filter_by: filterConditions,
        sort_by: 'timestamp:desc',
        per_page: logsLimit,
        page: page || 1 // Default to the first page if page number is not provided
      }

      // Execute search query
      const result = await this.provider
        .collections(this.schema.name)
        .documents()
        .search(searchParameters)

      // Map and return the search hits as log entries
      return result.hits.map((hit) => hit.document)
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
      await this.provider.collections(this.schema.name).documents().delete(logId)
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
    const xTime = parseInt(
      ENVIRONMENT_VARIABLES.LOG_RETENTION_TIME.value || defaultLogRetention
    )
    const deleteBeforeTime = new Date(currentTime - xTime)

    try {
      const oldLogs = await this.retrieveMultipleLogs(
        new Date(0),
        deleteBeforeTime,
        200,
        undefined,
        undefined
      )

      if (oldLogs) {
        for (const log of oldLogs) {
          if (log.id) {
            await this.delete(log.id)
          }
        }
      }
      return oldLogs.length
    } catch (error) {
      DATABASE_LOGGER.logMessageWithEmoji(
        `Error when deleting old log entries: ${error.message}`,
        true,
        GENERIC_EMOJIS.EMOJI_CROSS_MARK,
        LOG_LEVELS_STR.LEVEL_ERROR
      )
    }
  }

  async getLogsCount(): Promise<number> {
    try {
      const res = await this.provider.collections(this.schema.name).retrieve()
      return res && res.num_documents ? res.num_documents : 0
    } catch (e) {
      DATABASE_LOGGER.error('Unable to retrieve logs count: ' + e.message)
      return 0
    }
  }
}
