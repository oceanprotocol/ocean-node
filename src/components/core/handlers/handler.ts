import { Database } from '../../database/index.js'
import { OceanNodeConfig, P2PCommandResponse } from '../../../@types/OceanNode.js'
import { Command } from '../../../utils/constants.js'

export abstract class Handler {
  private config: OceanNodeConfig
  // Put database separately because of async constructor
  // that Database class has
  private db: Database
  private task: Command
  public constructor(task: Command, config?: OceanNodeConfig, db?: Database) {
    this.config = config
    this.db = db
    this.task = task
  }

  abstract handle(): Promise<P2PCommandResponse>
  getDatabse(): Database | null {
    if (!this.db) {
      return null
    }
    return this.db
  }

  getTask(): Command {
    return this.task
  }

  getConfig(): OceanNodeConfig | null {
    if (!this.config) {
      return null
    }
    return this.config
  }
}
