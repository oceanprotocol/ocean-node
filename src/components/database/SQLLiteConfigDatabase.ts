import fs from 'fs'
import path from 'path'
import { DATABASE_LOGGER } from '../../utils/logging/common.js'
import { GENERIC_EMOJIS, LOG_LEVELS_STR } from '../../utils/logging/Logger.js'
import { SQLiteProvider } from './sqlite.js'

export class SQLLiteConfigDatabase {
  private provider: SQLiteProvider

  constructor() {
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

  async retrieveLatestVersion() {
    try {
      return await this.provider.retrieveVersion()
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
}
