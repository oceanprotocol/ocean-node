import { Client } from '@elastic/elasticsearch'
import { AbstractDdoDatabase, AbstractNonceDatabase } from './BaseDatabase'
import { createElasticsearchClient } from './ElasticsearchConfigHelper'
import { OceanNodeDBConfig } from '../../@types'
import { Schema } from './schemas'
import { DATABASE_LOGGER } from '../../utils/logging/common'
import { GENERIC_EMOJIS, LOG_LEVELS_STR } from '../../utils/logging/Logger'
import { validateObject } from '../core/utils/validateDdoHandler'

export class ElasticsearchNonceDatabase extends AbstractNonceDatabase {
  private client: Client
  private index: string

  constructor(config: OceanNodeDBConfig, index: string) {
    super(config)
    this.client = new Client({ node: config.url })
    this.index = index
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

export class ElasticsearchDdoDatabase extends AbstractDdoDatabase {
  private client: Client

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
