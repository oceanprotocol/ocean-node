import { OceanNodeDBConfig } from '../../@types/OceanNode.js'
import { convertTypesenseConfig, Typesense, TypesenseError } from './typesense.js'
import { Schema, schemas } from './schemas.js'
import { TypesenseSearchParams } from '../../@types/index.js'
import {
  LOG_LEVELS_STR,
  configureCustomDBTransport,
  GENERIC_EMOJIS,
  isDevelopmentEnvironment
} from '../../utils/logging/Logger.js'
import { DATABASE_LOGGER } from '../../utils/logging/common.js'
import { validateObject } from '../core/utils/validateDdoHandler.js'
import { ENVIRONMENT_VARIABLES } from '../../utils/constants.js'

export class OrderDatabase {
  private provider: Typesense

  constructor(
    private config: OceanNodeDBConfig,
    private schema: Schema
  ) {
    return (async (): Promise<OrderDatabase> => {
      this.provider = new Typesense(convertTypesenseConfig(this.config.url))
      try {
        await this.provider.collections(this.schema.name).retrieve()
      } catch (error) {
        if (error instanceof TypesenseError && error.httpStatus === 404) {
          await this.provider.collections().create(this.schema)
        }
      }
      return this
    })() as unknown as OrderDatabase
  }

  async search(query: Record<string, any>) {
    try {
      const results = []
      const result = await this.provider
        .collections(this.schema.name)
        .documents()
        .search(query as TypesenseSearchParams)
      results.push(result)
      return results
    } catch (error) {
      const errorMsg =
        `Error when searching order entry by query ${query}: ` + error.message
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
    startOrderId?: string
  ) {
    try {
      return await this.provider
        .collections(this.schema.name)
        .documents()
        .create({ id: orderId, type, timestamp, consumer, payer, startOrderId })
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
        .collections(this.schema.name)
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
    startOrderId?: string
  ) {
    try {
      return await this.provider
        .collections(this.schema.name)
        .documents()
        .update(orderId, { type, timestamp, consumer, payer, startOrderId })
    } catch (error) {
      if (error instanceof TypesenseError && error.httpStatus === 404) {
        return await this.provider
          .collections(this.schema.name)
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
      return await this.provider.collections(this.schema.name).documents().delete(orderId)
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

export class DdoDatabase {
  private provider: Typesense

  constructor(
    private config: OceanNodeDBConfig,
    private schemas: Schema[]
  ) {
    return (async (): Promise<DdoDatabase> => {
      this.provider = new Typesense({
        ...convertTypesenseConfig(this.config.url),
        logger: DATABASE_LOGGER
      })
      for (const ddoSchema of this.schemas) {
        try {
          await this.provider.collections(ddoSchema.name).retrieve()
        } catch (error) {
          if (error instanceof TypesenseError && error.httpStatus === 404) {
            await this.provider.collections().create(ddoSchema)
          }
        }
      }
      return this
    })() as unknown as DdoDatabase
  }

  getSchemas(): Schema[] {
    return this.schemas
  }

  getDDOSchema(ddo: Record<string, any>): Schema {
    // Find the schema based on the DDO version OR use the short DDO schema when state !== 0
    let schemaName: string
    if (ddo.nft?.state !== 0) {
      schemaName = 'op_ddo_short'
    } else if (ddo.version) {
      schemaName = `op_ddo_v${ddo.version}`
    }
    const schema = this.schemas.find((s) => s.name === schemaName)
    DATABASE_LOGGER.logMessageWithEmoji(
      `Returning schema: ${schemaName}`,
      true,
      GENERIC_EMOJIS.EMOJI_OCEAN_WAVE,
      LOG_LEVELS_STR.LEVEL_INFO
    )
    return schema
  }

  async validateDDO(ddo: Record<string, any>): Promise<boolean> {
    if (ddo.nft?.state !== 0) {
      // Skipping validation for short DDOs as it currently doesn't work
      // TODO: DDO validation needs to be updated to consider the fields required by the schema
      // See github issue: https://github.com/oceanprotocol/ocean-node/issues/256
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

  async search(query: Record<string, any>) {
    try {
      const results = []
      for (const schema of this.schemas) {
        const result = await this.provider
          .collections(schema.name)
          .documents()
          .search(query as TypesenseSearchParams)
        results.push(result)
      }
      return results
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
    for (const schema of this.schemas) {
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
    for (const schema of this.schemas) {
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

  async deleteAllAssetsFromChain(chainId: number) {
    const searchParameters = {
      q: '*',
      query_by: `chainId:${chainId}`
    }
    const results = await this.search(searchParameters)
    for (const res of results) {
      if (res && res.hits) {
        for (const h of res.hits) {
          await this.delete(h.document.id)
        }
      }
    }
  }
}

export class NonceDatabase {
  private provider: Typesense

  constructor(
    private config: OceanNodeDBConfig,
    private schema: Schema
  ) {
    return (async (): Promise<NonceDatabase> => {
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
    })() as unknown as NonceDatabase
  }

  async create(address: string, nonce: number) {
    try {
      return await this.provider
        .collections(this.schema.name)
        .documents()
        .create({ id: address, nonce })
    } catch (error) {
      const errorMsg =
        `Error when creating new nonce entry ${nonce} for address ${address}: ` +
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

  async retrieve(address: string) {
    try {
      return await this.provider
        .collections(this.schema.name)
        .documents()
        .retrieve(address)
    } catch (error) {
      const errorMsg =
        `Error when retrieving nonce entry for address ${address}: ` + error.message
      DATABASE_LOGGER.logMessageWithEmoji(
        errorMsg,
        true,
        GENERIC_EMOJIS.EMOJI_CROSS_MARK,
        LOG_LEVELS_STR.LEVEL_ERROR
      )
      return null
    }
  }

  async update(address: string, nonce: number) {
    try {
      return await this.provider
        .collections(this.schema.name)
        .documents()
        .update(address, { nonce })
    } catch (error) {
      if (error instanceof TypesenseError && error.httpStatus === 404) {
        return await this.provider
          .collections(this.schema.name)
          .documents()
          .create({ id: address, nonce })
      }
      const errorMsg =
        `Error when updating nonce entry ${nonce} for address ${address}: ` +
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

  async delete(address: string) {
    try {
      return await this.provider.collections(this.schema.name).documents().delete(address)
    } catch (error) {
      const errorMsg =
        `Error when deleting nonce entry for address ${address}: ` + error.message
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

export class IndexerDatabase {
  private provider: Typesense

  constructor(
    private config: OceanNodeDBConfig,
    private schema: Schema
  ) {
    return (async (): Promise<IndexerDatabase> => {
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
    })() as unknown as IndexerDatabase
  }

  // async create(fields: Record<string, any>) {
  //   try {
  //     return await this.provider.collections(this.schema.name).documents().create(fields)
  //   } catch (error) {
  //     return null
  //   }
  // }

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

export class LogDatabase {
  private provider: Typesense

  constructor(
    private config: OceanNodeDBConfig,
    private schema: Schema
  ) {
    return (async (): Promise<LogDatabase> => {
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
    })() as unknown as LogDatabase
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
    level?: string
  ): Promise<Record<string, any>[] | null> {
    try {
      let filterConditions = `timestamp:>=${startTime.getTime()} && timestamp:<${endTime.getTime()}`
      if (moduleName) {
        filterConditions += ` && moduleName:${moduleName}`
      }
      if (level) {
        filterConditions += ` && level:${level}`
      }
      if (maxLogs > 250) {
        maxLogs = 250
        DATABASE_LOGGER.logMessageWithEmoji(
          `Max logs is capped at 250 as Typesense is unable to return more results per page.`,
          true,
          GENERIC_EMOJIS.EMOJI_OCEAN_WAVE,
          LOG_LEVELS_STR.LEVEL_INFO
        )
      }

      const searchParameters = {
        q: '*',
        query_by: 'message,level,meta',
        filter_by: filterConditions,
        sort_by: 'timestamp:desc',
        per_page: maxLogs
      }

      const result = await this.provider
        .collections(this.schema.name)
        .documents()
        .search(searchParameters)
      return result.hits.map((hit) => hit.document)
    } catch (error) {
      const errorMsg = `Error when retrieving mutliple log entries: ` + error.message
      DATABASE_LOGGER.logMessageWithEmoji(
        errorMsg,
        true,
        GENERIC_EMOJIS.EMOJI_CROSS_MARK,
        LOG_LEVELS_STR.LEVEL_ERROR
      )
      return null
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
      return oldLogs ? oldLogs.length : 0
    } catch (error) {
      DATABASE_LOGGER.logMessageWithEmoji(
        `Error when deleting old log entries: ${error.message}`,
        true,
        GENERIC_EMOJIS.EMOJI_CROSS_MARK,
        LOG_LEVELS_STR.LEVEL_ERROR
      )
    }
  }
}

export class Database {
  ddo: DdoDatabase
  nonce: NonceDatabase
  indexer: IndexerDatabase
  logs: LogDatabase
  order: OrderDatabase

  constructor(private config: OceanNodeDBConfig) {
    // add this DB transport too
    // once we create a DB instance, the logger will be using this transport as well
    // we cannot have this the other way around because of the dependencies cycle
    if (!isDevelopmentEnvironment()) {
      configureCustomDBTransport(this, DATABASE_LOGGER)
    }
    return (async (): Promise<Database> => {
      this.ddo = await new DdoDatabase(this.config, schemas.ddoSchemas)
      this.nonce = await new NonceDatabase(this.config, schemas.nonceSchemas)
      this.indexer = await new IndexerDatabase(this.config, schemas.indexerSchemas)
      this.logs = await new LogDatabase(this.config, schemas.logSchemas)
      this.order = await new OrderDatabase(this.config, schemas.orderSchema)
      return this
    })() as unknown as Database
  }
}
