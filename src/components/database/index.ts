import { OceanNodeDBConfig } from '../../@types/OceanNode'
import Typesense from './typesense.js'

import {
  CustomNodeLogger,
  GENERIC_EMOJIS,
  LOGGER_MODULE_NAMES,
  LOG_LEVELS_STR,
  defaultConsoleTransport,
  getCustomLoggerForModule
} from '../../utils/logging/Logger.js'

export const DB_CONSOLE_LOGGER: CustomNodeLogger = getCustomLoggerForModule(
  LOGGER_MODULE_NAMES.DATABASE,
  LOG_LEVELS_STR.LEVEL_INFO,
  defaultConsoleTransport
)
// main db class
export class Database {
  // _config: OceanNodeDBConfig
  _typesense: Typesense
  // typesense configuration
  constructor(config: OceanNodeDBConfig) {
    // this._config = config
    this._typesense = new Typesense({
      apiKey: 'xyz',
      nodes: [
        {
          host: 'localhost',
          port: 8108,
          protocol: 'http'
        }
      ],
      logLevel: LOG_LEVELS_STR.LEVEL_INFO,
      logger: DB_CONSOLE_LOGGER.getLogger()
    })
  }

  async getNonce(consumerAddress: string): Promise<string> {
    // const collection = await this._typesense.collections('nonce').retrieve()

    const searchParameters = {
      q: consumerAddress,
      query_by: 'address'
    }

    const searchResults = await this._typesense
      .collections('nonce')
      .documents()
      .search(searchParameters)

    console.log('query result: ', searchResults)
    if (!searchResults.found || searchResults.hits.length === 0) {
      return '0'
    } else if (searchResults.found) {
      return searchResults.hits[0].document.nonce
    }
  }

  async setNonce(consumerAddress: string, nonce: number): Promise<boolean> {
    return true
  }
}
