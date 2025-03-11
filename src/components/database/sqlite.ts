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
  private schemaNonce: TypesenseSchema
  private configSchema: string

  constructor(private dbFilePath: string) {
    this.db = new sqlite3.Database(dbFilePath)
    this.schemaNonce = typesenseSchemas.nonceSchemas
    this.configSchema = 'config'
  }

  // eslint-disable-next-line require-await
  async createTable() {
    const createTableSQL = `
      CREATE TABLE IF NOT EXISTS ${this.schemaNonce.name} (
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
  async createTableForConfig() {
    const createTableSQL = `
        CREATE TABLE IF NOT EXISTS ${this.configSchema} (
          key TEXT PRIMARY KEY DEFAULT 'version',
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
  async create(address: string, nonce: number) {
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
  async createConfig(version: string) {
    const insertSQL = `
    INSERT INTO ${this.configSchema} (key, value)
    VALUES ('version', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value;
  `
    return new Promise<{ version: string }>((resolve, reject) => {
      this.db.run(insertSQL, [version], (err) => {
        if (err) reject(err)
        else resolve({ version })
      })
    })
  }

  // eslint-disable-next-line require-await
  async retrieve(address: string) {
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
  async retrieveVersion() {
    const selectSQL = `
      SELECT value FROM ${this.configSchema};
    `
    return new Promise<{ version: string | null }>((resolve, reject) => {
      this.db.get(selectSQL, [], (err, row: { value: string } | undefined) => {
        if (err) reject(err)
        else resolve(row ? { version: row.value } : { version: null }) // Returns null if no version exists
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
