import { TypesenseSchema, typesenseSchemas } from './TypesenseSchemas.js'
import sqlite3 from 'sqlite3'

interface DatabaseProvider {
  createNonce(address: string, nonce: number): Promise<{ id: string; nonce: number }>
  retrieveNonce(address: string): Promise<{ id: string; nonce: number | null }>
  updateNonce(address: string, nonce: number): Promise<{ id: string; nonce: number }>
  deleteNonceEntry(address: string): Promise<{ id: string; nonce: number | null }>
}

export class SQLiteProvider implements DatabaseProvider {
  private db: sqlite3.Database
  private schemaNonce: TypesenseSchema
  private configSchema: string

  constructor(dbFilePath: string) {
    this.db = new sqlite3.Database(dbFilePath)
    this.schemaNonce = typesenseSchemas.nonceSchemas
    this.configSchema = 'config'
  }

  // eslint-disable-next-line require-await
  async createTableForNonce() {
    const createTableSQL = `
      CREATE TABLE IF NOT EXISTS ${this.schemaNonce.name} (
        id TEXT PRIMARY KEY,
        nonce REAL
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
  async createTableForConfig() {
    const createTableSQL = `
        CREATE TABLE IF NOT EXISTS ${this.configSchema} (
          key TEXT NOT NULL PRIMARY KEY,
          value TEXT
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
  async createNonce(address: string, nonce: number) {
    const insertSQL = `
      INSERT INTO ${this.schemaNonce.name} (id, nonce)
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
  async createOrUpdateConfig(key: string, value: string) {
    const insertSQL = `
    INSERT INTO ${this.configSchema} (key, value)
    VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value;
  `
    return new Promise<{ key: string; value: string }>((resolve, reject) => {
      this.db.run(insertSQL, [key, value], (err) => {
        if (err) reject(err)
        else resolve({ key, value })
      })
    })
  }

  // eslint-disable-next-line require-await
  async retrieveNonce(address: string) {
    const selectSQL = `
      SELECT * FROM ${this.schemaNonce.name} WHERE id = ?
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
  async retrieveValue(key: string) {
    const selectSQL = `
      SELECT value FROM ${this.configSchema} WHERE key = ?;
    `
    return new Promise<{ value: string | null }>((resolve, reject) => {
      this.db.get(selectSQL, [key], (err, row: { value: string } | undefined) => {
        if (err) reject(err)
        else resolve(row ? { value: row.value } : { value: null }) // Returns null if no version exists
      })
    })
  }

  // eslint-disable-next-line require-await
  async updateNonce(address: string, nonce: number) {
    return this.createNonce(address, nonce)
  }

  // eslint-disable-next-line require-await
  async deleteNonceEntry(address: string) {
    const selectSQL = `
      SELECT nonce FROM ${this.schemaNonce.name} WHERE id = ?
    `

    const deleteSQL = `
      DELETE FROM ${this.schemaNonce.name} WHERE id = ?
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
