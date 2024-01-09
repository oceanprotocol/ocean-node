import {
  CustomNodeLogger,
  getCustomLoggerForModule,
  LOGGER_MODULE_NAMES,
  LOG_LEVELS_STR,
  defaultConsoleTransport
} from '../../utils/logging/Logger.js'
import { Database } from '../database/index.js'

// this should be actually part of provider, so lets put this as module name
export const PROVIDER_LOGGER: CustomNodeLogger = getCustomLoggerForModule(
  LOGGER_MODULE_NAMES.PROVIDER,
  LOG_LEVELS_STR.LEVEL_INFO, // Info level
  defaultConsoleTransport // console only Transport
)
export class OceanProvider {
  private db: Database
  constructor(db: Database) {
    this.db = db
  }

  public getDatabase(): Database {
    return this.db
  }
}
