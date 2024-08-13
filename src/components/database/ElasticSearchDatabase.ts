import { Client } from '@elastic/elasticsearch'
import {
  AbstractDdoDatabase,
  AbstractDdoStateDatabase,
  AbstractIndexerDatabase,
  AbstractLogDatabase,
  AbstractNonceDatabase
} from './BaseDatabase'
import { createElasticsearchClient } from './ElasticsearchConfigHelper'
import { OceanNodeDBConfig } from '../../@types'
import { Schema } from './schemas'
import { DATABASE_LOGGER } from '../../utils/logging/common'
import { GENERIC_EMOJIS, LOG_LEVELS_STR } from '../../utils/logging/Logger'
import { validateObject } from '../core/utils/validateDdoHandler'

export class ElasticsearchNonceDatabase extends AbstractNonceDatabase {
  private client: Client
  private index: string

  constructor(config: OceanNodeDBConfig) {
    super(config)
    this.client = new Client({ node: config.url })
    this.index = 'nonce'
    this.initializeIndex()
  }

  private async initializeIndex() {
    const indexExists = await this.client.indices.exists({ index: this.index })
    if (!indexExists) {
      await this.client.indices.create({
        index: this.index,
        body: {
          mappings: {
            properties: {
              id: { type: 'keyword' },
              nonce: { type: 'integer' }
            }
          }
        }
      })
    }
  }

  async create(address: string, nonce: number) {
    try {
      await this.client.index({
        index: this.index,
        id: address,
        body: { nonce },
        refresh: 'wait_for'
      })
      return { id: address, nonce }
    } catch (error) {
      const errorMsg = `Error when creating new nonce entry ${nonce} for address ${address}: ${error.message}`
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
      const result = await this.client.get({
        index: this.index,
        id: address
      })
      return result._source
    } catch (error) {
      const errorMsg = `Error when retrieving nonce entry for address ${address}: ${error.message}`
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
      const exists = await this.client.exists({
        index: this.index,
        id: address
      })

      if (exists) {
        await this.client.update({
          index: this.index,
          id: address,
          body: {
            doc: { nonce }
          },
          refresh: 'wait_for'
        })
      } else {
        await this.create(address, nonce)
      }

      return { id: address, nonce }
    } catch (error) {
      const errorMsg = `Error when updating nonce entry ${nonce} for address ${address}: ${error.message}`
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
      await this.client.delete({
        index: this.index,
        id: address,
        refresh: 'wait_for'
      })
      return { id: address }
    } catch (error) {
      const errorMsg = `Error when deleting nonce entry for address ${address}: ${error.message}`
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
        body: {
          query: {
            match: query
          }
        }
      })
      return result.hits.hits.map((hit: any) => hit._source)
    } catch (error) {
      const errorMessage = `Error when searching by query ${JSON.stringify(query)}: ${
        error.message
      }`
      DATABASE_LOGGER.logMessageWithEmoji(
        errorMessage,
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

export class ElasticsearchDdoDatabase extends AbstractDdoDatabase {
  private client: Client

  // TODO: update schemas logic to fit elastic
  constructor(config: OceanNodeDBConfig, schemas: Schema[]) {
    super(config, schemas)
    this.client = createElasticsearchClient(config)
  }

  getSchemas(): Schema[] {
    return this.schemas
  }

  getDDOSchema(ddo: Record<string, any>): Schema | undefined {
    let schemaName: string | undefined
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
  ): Promise<any> {
    try {
      const results = []
      const maxPerPage = maxResultsPerPage || 100
      const from = (pageNumber || 1) * maxPerPage - maxPerPage

      for (const schema of this.schemas) {
        const response = await this.client.search({
          index: schema.name,
          body: {
            query: {
              match: query
            },
            from,
            size: maxPerPage
          }
        })
        results.push(response.hits.hits)
      }

      return results
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

  async create(ddo: Record<string, any>): Promise<any> {
    const schema = this.getDDOSchema(ddo)
    if (!schema) {
      throw new Error(`Schema for version ${ddo.version} not found`)
    }
    try {
      const validation = await this.validateDDO(ddo)
      if (validation === true) {
        const response = await this.client.index({
          index: schema.name,
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
    for (const schema of this.schemas) {
      try {
        const response = await this.client.get({
          index: schema.name,
          id
        })
        if (response.found) {
          ddo = response._source
          break
        }
      } catch (error) {
        if (error.statusCode !== 404) {
          DATABASE_LOGGER.logMessageWithEmoji(
            `Error when retrieving DDO entry ${id} from schema ${schema.name}: ${error.message}`,
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

  async update(ddo: Record<string, any>): Promise<any> {
    const schema = this.getDDOSchema(ddo)
    if (!schema) {
      throw new Error(`Schema for version ${ddo.version} not found`)
    }
    try {
      const validation = await this.validateDDO(ddo)
      if (validation === true) {
        const response = await this.client.update({
          index: schema.name,
          id: ddo.id,
          body: {
            doc: ddo
          }
        })
        return response
      } else {
        throw new Error(
          `Validation of DDO with schema version ${ddo.version} failed with errors`
        )
      }
    } catch (error) {
      if (error.statusCode === 404) {
        await this.delete(ddo.id)
        return await this.create(ddo)
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
    for (const schema of this.schemas) {
      try {
        const response = await this.client.delete({
          index: schema.name,
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
            `Error when deleting DDO entry ${id} from schema ${schema.name}: ${error.message}`,
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
    for (const schema of this.schemas) {
      try {
        // add batch size logic
        const response = await this.client.deleteByQuery({
          index: schema.name,
          body: {
            query: {
              match: { chainId }
            }
          }
        })

        DATABASE_LOGGER.debug(
          `Number of deleted ddos on schema ${schema.name}: ${response.deleted}`
        )

        numDeleted += response.deleted
      } catch (error) {
        if (error.statusCode !== 404) {
          DATABASE_LOGGER.logMessageWithEmoji(
            `Error when deleting DDOs from schema ${schema.name}: ${error.message}`,
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
  }

  async insertLog(logEntry: Record<string, any>) {
    try {
      const timestamp = new Date().toISOString()
      await this.client.index({
        index: this.index,
        body: { ...logEntry, timestamp },
        refresh: 'wait_for'
      })
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
      return result._source
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
  ): Promise<Record<string, any>[] | null> {
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

      const result = await this.client.search({
        index: this.index,
        body: {
          query: filterConditions,
          sort: [{ timestamp: { order: 'desc' } }]
        },
        size: Math.min(maxLogs, 250),
        from: (page || 0) * Math.min(maxLogs, 250)
      })

      return result.hits.hits.map((hit: any) => hit._source)
    } catch (error) {
      const errorMsg = `Error when retrieving multiple log entries: ${error.message}`
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
      return 0
    }
  }
}