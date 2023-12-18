import { Database } from '../../database/index.js'
import { OceanNodeConfig, P2PCommandResponse } from '../../../@types/OceanNode.js'
import { Command } from '../../../utils/constants.js'

export abstract class Handler {
  private config: OceanNodeConfig
  // Put database separately because of async constructor
  // that Database class has
  private db: Database
  private task: Command
  public constructor(config: OceanNodeConfig, db: Database, task: Command) {
    this.config = config
    this.db = db
    this.task = task
  }

  abstract handle(): Promise<P2PCommandResponse>
  getDatabse(): Database {
    return this.db
  }

  getTask(): Command {
    return this.task
  }

  getConfig(): OceanNodeConfig {
    return this.config
  }
}
