import { TypesenseSchema, typesenseSchemas } from './TypesenseSchemas.js'
import { SqliteClient } from './sqliteClient.js'

interface DatabaseProvider {
  createNonce(address: string, nonce: number): Promise<{ id: string; nonce: number }>
  retrieveNonce(address: string): Promise<{ id: string; nonce: number | null }>
  updateNonce(address: string, nonce: number): Promise<{ id: string; nonce: number }>
  deleteNonceEntry(address: string): Promise<{ id: string; nonce: number | null }>
}

export class SQLiteProvider implements DatabaseProvider {
  private db: SqliteClient
  private schemaNonce: TypesenseSchema
  private configSchema: string

  constructor(dbFilePath: string) {
    this.db = new SqliteClient(dbFilePath)
    this.schemaNonce = typesenseSchemas.nonceSchemas
    this.configSchema = 'config'
  }

  // eslint-disable-next-line require-await
  async createTableForNonce() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ${this.schemaNonce.name} (
        id TEXT PRIMARY KEY,
        nonce INTEGER
      );
    `)
  }

  // eslint-disable-next-line require-await
  async createTableForConfig() {
    this.db.exec(`
        CREATE TABLE IF NOT EXISTS ${this.configSchema} (
          key TEXT NOT NULL PRIMARY KEY,
          value TEXT
        );
      `)
  }

  // eslint-disable-next-line require-await
  async createNonce(address: string, nonce: number) {
    const insertSQL = `
      INSERT INTO ${this.schemaNonce.name} (id, nonce)
      VALUES (?, ?)
      ON CONFLICT(id) DO UPDATE SET nonce=excluded.nonce;
    `
    this.db.run(insertSQL, [address, nonce])
    return { id: address, nonce }
  }

  // eslint-disable-next-line require-await
  async createOrUpdateConfig(key: string, value: string) {
    const insertSQL = `
    INSERT INTO ${this.configSchema} (key, value)
    VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value;
  `
    this.db.run(insertSQL, [key, value])
    return { key, value }
  }

  // eslint-disable-next-line require-await
  async retrieveNonce(address: string) {
    const selectSQL = `
      SELECT * FROM ${this.schemaNonce.name} WHERE id = ?
    `
    const row = this.db.get<{ nonce: number }>(selectSQL, [address])
    return row ? { id: address, nonce: row.nonce } : { id: address, nonce: null }
  }

  // eslint-disable-next-line require-await
  async retrieveValue(key: string) {
    const selectSQL = `
      SELECT value FROM ${this.configSchema} WHERE key = ?;
    `
    const row = this.db.get<{ value: string }>(selectSQL, [key])
    // Returns null if no version exists
    return row ? { value: row.value } : { value: null }
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

    const row = this.db.get<{ nonce: number }>(selectSQL, [address])
    if (!row) return { id: address, nonce: null }

    this.db.run(deleteSQL, [address])
    return { id: address, nonce: row.nonce }
  }
}
