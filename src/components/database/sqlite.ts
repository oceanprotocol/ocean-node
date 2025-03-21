import { TypesenseSchema, typesenseSchemas } from './TypesenseSchemas.js'
import sqlite3 from 'sqlite3'

interface DatabaseProvider {
  create(address: string, nonce: number): Promise<{ id: string; nonce: number }>
  retrieve(address: string): Promise<{ id: string; nonce: number | null }>
  update(address: string, nonce: number): Promise<{ id: string; nonce: number }>
  delete(address: string): Promise<{ id: string; nonce: number | null }>
}

export class SQLiteProvider implements DatabaseProvider {
  private db: sqlite3.Database
  private schema: TypesenseSchema

  constructor(dbFilePath: string) {
    this.db = new sqlite3.Database(dbFilePath)
    this.schema = typesenseSchemas.nonceSchemas
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
    return new Promise<{ id: string; nonce: number }>((resolve, reject) => {
      this.db.run(insertSQL, [address, nonce], (err) => {
        if (err) reject(err)
        else resolve({ id: address, nonce })
      })
    })
  }

  // eslint-disable-next-line require-await
  async retrieve(address: string) {
    const selectSQL = `
      SELECT * FROM ${this.schema.name} WHERE id = ?
    `
    return new Promise<{ id: string; nonce: number | null }>((resolve, reject) => {
      this.db.get(selectSQL, [address], (err, row: { nonce: number } | undefined) => {
        if (err) reject(err)
        else
          resolve(row ? { id: address, nonce: row.nonce } : { id: address, nonce: null })
      })
    })
  }

  // eslint-disable-next-line require-await
  async update(address: string, nonce: number) {
    return this.create(address, nonce)
  }

  // eslint-disable-next-line require-await
  async delete(address: string) {
    const selectSQL = `
      SELECT nonce FROM ${this.schema.name} WHERE id = ?
    `

    const deleteSQL = `
      DELETE FROM ${this.schema.name} WHERE id = ?
    `

    return new Promise<{ id: string; nonce: number | null }>((resolve, reject) => {
      this.db.get(selectSQL, [address], (err, row: { nonce: number } | undefined) => {
        if (err) return reject(err)
        if (!row) return resolve({ id: address, nonce: null })

        this.db.run(deleteSQL, [address], (err) => {
          if (err) reject(err)
          else resolve({ id: address, nonce: row.nonce })
        })
      })
    })
  }
}
