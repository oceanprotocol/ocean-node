import { Database } from '../database/index.js'

export class OceanProvider {
  private db: Database
  constructor(db: Database) {
    this.db = db
  }
}
