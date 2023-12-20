import { Database } from '../database/index.js'
import { OceanNodeConfig, P2PCommandResponse } from '../../@types/OceanNode.js'
import { OceanP2P } from '../P2P/index.js'

export abstract class Handler {
  private config: OceanNodeConfig
  // Put database separately because of async constructor
  // that Database class has
  private db: Database
  private task: any
  private p2pNode: OceanP2P
  public constructor(task: any, config?: OceanNodeConfig, db?: Database) {
    this.config = config
    this.db = db
    this.task = task
    if (this.config && this.db) {
      this.p2pNode = new OceanP2P(this.db, this.config)
    }
  }

  abstract handle(): Promise<P2PCommandResponse>
  getDatabase(): Database | null {
    if (!this.db) {
      return null
    }
    return this.db
  }

  getTask(): any {
    return this.task
  }

  getConfig(): OceanNodeConfig | null {
    if (!this.config) {
      return null
    }
    return this.config
  }

  getP2PNode(): OceanP2P | null {
    if (!this.p2pNode) {
      return null
    }
    return this.p2pNode
  }

  setTask(task: any): void {
    this.task = task
  }
}
