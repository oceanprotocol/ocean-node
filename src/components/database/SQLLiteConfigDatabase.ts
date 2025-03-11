import fs from 'fs'
import path from 'path'
import { OceanNodeDBConfig } from '../../@types/OceanNode.js'
import { DATABASE_LOGGER } from '../../utils/logging/common.js'
import { GENERIC_EMOJIS, LOG_LEVELS_STR } from '../../utils/logging/Logger.js'
import { AbstractVersionDatabase } from './BaseDatabase.js'
import { SQLiteProvider } from './sqlite.js'
import { TypesenseSchema } from './TypesenseSchemas.js'

export class SQLLiteConfigDatabase extends AbstractVersionDatabase {
  private provider: SQLiteProvider

  constructor(config: OceanNodeDBConfig, schema: TypesenseSchema) {
    super(config, schema)
    return (async (): Promise<SQLLiteConfigDatabase> => {
      DATABASE_LOGGER.info('Version Database initiated with SQLite provider')

      // Ensure the directory exists before instantiating SQLiteProvider
      const dbDir = path.dirname('databases/config.sqlite')
      if (!fs.existsSync(dbDir)) {
        fs.mkdirSync(dbDir, { recursive: true })
      }
      this.provider = new SQLiteProvider('databases/config.sqlite')
      await this.provider.createTableForConfig()

      return this
    })() as unknown as SQLLiteConfigDatabase
  }

  async create(version: string) {
    try {
      return await this.provider.createConfig(version)
    } catch (error) {
      const errorMsg =
        `Error when creating new version entry ${version}: ` + error.message
      DATABASE_LOGGER.logMessageWithEmoji(
        errorMsg,
        true,
        GENERIC_EMOJIS.EMOJI_CROSS_MARK,
        LOG_LEVELS_STR.LEVEL_ERROR
      )
      return null
    }
  }

  async retrieveById(id: number) {
    try {
      return await this.provider.retrieveVersionById(id)
    } catch (error) {
      const errorMsg =
        `Error when retrieving version entry for id ${id}: ` + error.message
      DATABASE_LOGGER.logMessageWithEmoji(
        errorMsg,
        true,
        GENERIC_EMOJIS.EMOJI_CROSS_MARK,
        LOG_LEVELS_STR.LEVEL_ERROR
      )
      return null
    }
  }

  async retrieveLatestVersion() {
    try {
      return await this.provider.retrieveLatestVersion()
    } catch (error) {
      const errorMsg = `Error when retrieving latest version entry: ` + error.message
      DATABASE_LOGGER.logMessageWithEmoji(
        errorMsg,
        true,
        GENERIC_EMOJIS.EMOJI_CROSS_MARK,
        LOG_LEVELS_STR.LEVEL_ERROR
      )
      return null
    }
  }

  async retrieveAllVersions() {
    try {
      return await this.provider.retrieveAllVersions()
    } catch (error) {
      const errorMsg = `Error when retrieving all version entries: ` + error.message
      DATABASE_LOGGER.logMessageWithEmoji(
        errorMsg,
        true,
        GENERIC_EMOJIS.EMOJI_CROSS_MARK,
        LOG_LEVELS_STR.LEVEL_ERROR
      )
      return null
    }
  }

  async update(newVersion: string, version: string) {
    try {
      return await this.provider.updateVersion(newVersion, version)
    } catch (error) {
      const errorMsg =
        `Error when updating existing version entry ${version} with new ${newVersion}: ` +
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

  async delete(version: string) {
    try {
      return await this.provider.deleteVersion(version)
    } catch (error) {
      const errorMsg = `Error when deleting version entry: ` + error.message
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
