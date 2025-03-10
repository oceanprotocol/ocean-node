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
  private schemaConfig: TypesenseSchema

  constructor(private dbFilePath: string) {
    this.db = new sqlite3.Database(dbFilePath)
    this.schemaNonce = typesenseSchemas.nonceSchemas
    this.schemaConfig = typesenseSchemas.configSchemas
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
        CREATE TABLE IF NOT EXISTS ${this.schemaConfig.name} (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          version TEXT
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
      INSERT INTO ${this.schemaConfig.name} (version)
      VALUES (?);
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
  async retrieveLatestVersion() {
    const selectSQL = `
      SELECT version FROM ${this.schemaConfig.name} ORBER BY id DESC LIMIT 1;
    `
    return new Promise<{ version: string }>((resolve, reject) => {
      this.db.get(selectSQL, [], (err, row: { version: string } | undefined) => {
        if (err) reject(err)
        else resolve(row ? { version: row.version } : { version: null })
      })
    })
  }

  // eslint-disable-next-line require-await
  async retrieveVersionById(id: number) {
    const selectSQL = `
      SELECT version FROM ${this.schemaConfig.name} WHERE id = ?;
    `
    return new Promise<{ id: number; version: string }>((resolve, reject) => {
      this.db.get(selectSQL, [id], (err, row: { version: string } | undefined) => {
        if (err) reject(err)
        else resolve(row ? { id, version: row.version } : { id, version: null })
      })
    })
  }

  // eslint-disable-next-line require-await
  async update(address: string, nonce: number) {
    return this.create(address, nonce)
  }

  // eslint-disable-next-line require-await
  async updateVersion(newVersion: string, version: string) {
    const updateSQL = `
      UPDATE ${this.schemaConfig.name} SET version = ? WHERE version = ?;
    `
    return new Promise<{ updatedVersion: string }>((resolve, reject) => {
      this.db.run(updateSQL, [newVersion, version], function (err) {
        if (err) reject(err)
        else if (this.changes === 0)
          reject(new Error('No record found with the given version'))
        else resolve({ updatedVersion: newVersion })
      })
    })
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

  // eslint-disable-next-line require-await
  async deleteVersion(version: string) {
    const selectSQL = `
      SELECT id, version FROM ${this.schemaConfig.name} WHERE version = ?
    `

    const deleteSQL = `
      DELETE FROM ${this.schemaConfig.name} WHERE version = ?
    `

    return new Promise<{ id: string; version: string | null }>((resolve, reject) => {
      this.db.get(
        selectSQL,
        [version],
        (err, row: { id: string; version: string } | undefined) => {
          if (err) return reject(err)
          if (!row) return resolve({ id: null, version: null })

          this.db.run(deleteSQL, [version], (err) => {
            if (err) reject(err)
            else resolve({ id: row.id, version })
          })
        }
      )
    })
  }
}
