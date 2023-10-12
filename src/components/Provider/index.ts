import { Database } from "../database"

export class OceanProvider{
    private db:Database
    constructor (db:Database) {
        this.db=db
      }
}