import fs from 'fs'
import path from 'path'
import { OceanNodeDBConfig } from '../../@types/OceanNode.js'
import { DATABASE_LOGGER } from '../../utils/logging/common.js'
import { GENERIC_EMOJIS, LOG_LEVELS_STR } from '../../utils/logging/Logger.js'
import { AbstractNonceDatabase } from './BaseDatabase.js'
import { SQLiteProvider } from './sqlite.js'
import { TypesenseSchema } from './TypesenseSchemas.js'

export class SQLLiteNonceDatabase extends AbstractNonceDatabase {
  private provider: SQLiteProvider

  constructor(config: OceanNodeDBConfig, schema: TypesenseSchema) {
    super(config, schema)
    return (async (): Promise<SQLLiteNonceDatabase> => {
      DATABASE_LOGGER.info('Nonce Database initiated with SQLite provider')

      // Ensure the directory exists before instantiating SQLiteProvider
      const dbDir = path.dirname('databases/nonceDatabase.sqlite')
      if (!fs.existsSync(dbDir)) {
        fs.mkdirSync(dbDir, { recursive: true })
      }
      this.provider = new SQLiteProvider('databases/nonceDatabase.sqlite')
      await this.provider.createTableForNonce()

      return this
    })() as unknown as SQLLiteNonceDatabase
  }

  async create(address: string, nonce: number) {
    try {
      return await this.provider.createNonce(address, nonce)
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
      return await this.provider.retrieveNonce(address)
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
      return await this.provider.updateNonce(address, nonce)
    } catch (error) {
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
      return await this.provider.deleteNonceEntry(address)
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
