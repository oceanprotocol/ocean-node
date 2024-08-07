import { schemas, Schema } from './schemas.js'
import sqlite3 from 'sqlite3'

export class SQLiteProvider {
  private db: sqlite3.Database
  private schema: Schema

  constructor(private dbFilePath: string) {
    this.db = new sqlite3.Database(dbFilePath)
    this.schema = schemas.nonceSchemas
  }

  // eslint-disable-next-line require-await
  async createTable() {
    const createTableSQL = `
      CREATE TABLE IF NOT EXISTS ${this.schema.name} (
        id TEXT PRIMARY KEY,
        nonce INTEGER
      );
    `
    return new Promise<void>((resolve, reject) => {
      this.db.run(createTableSQL, (err) => {
        if (err) reject(err)
        else resolve()
      })
    })
  }

  // eslint-disable-next-line require-await
  async create(address: string, nonce: number) {
    const insertSQL = `
      INSERT INTO ${this.schema.name} (id, nonce)
      VALUES (?, ?)
      ON CONFLICT(id) DO UPDATE SET nonce=excluded.nonce;
    `
    return new Promise<void>((resolve, reject) => {
      this.db.run(insertSQL, [address, nonce], (err) => {
        if (err) reject(err)
        else resolve()
      })
    })
  }

  // eslint-disable-next-line require-await
  async retrieve(address: string) {
    const selectSQL = `
      SELECT * FROM ${this.schema.name} WHERE id = ?
    `
    return new Promise<any>((resolve, reject) => {
      this.db.get(selectSQL, [address], (err, row) => {
        if (err) reject(err)
        else resolve(row)
      })
    })
  }

  // eslint-disable-next-line require-await
  async update(address: string, nonce: number) {
    return this.create(address, nonce)
  }

  // eslint-disable-next-line require-await
  async delete(address: string) {
    const deleteSQL = `
      DELETE FROM ${this.schema.name} WHERE id = ?
    `
    return new Promise<void>((resolve, reject) => {
      this.db.run(deleteSQL, [address], (err) => {
        if (err) reject(err)
        else resolve()
      })
    })
  }
}
