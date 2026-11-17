import type { OceanNodeDBConfig } from '../../../@types/OceanNode.js'
import { addressCasingVariants, normalizeAddress } from '../../../utils/evmAddress.js'
import { AbstractNonceDatabase } from '../BaseDatabase.js'
import { SqlClient, placeholders } from './SqlClient.js'

// one row per address: id = the checksummed address
export class SqlNonceDatabase extends AbstractNonceDatabase {
  constructor(
    config: OceanNodeDBConfig,
    private db: SqlClient
  ) {
    super(config)
  }

  init(): Promise<void> {
    return this.db.exec(
      'CREATE TABLE IF NOT EXISTS nonce ("id" TEXT PRIMARY KEY, "nonce" BIGINT)'
    )
  }

  async create(address: string, nonce: number) {
    try {
      return await this.write(address, nonce)
    } catch (error) {
      this.logError(`Error when writing nonce ${nonce} for address ${address}`, error)
      return null
    }
  }

  // Reads every casing of the address and keeps the HIGHEST nonce: a row from before the
  // addresses were normalized must not make the nonce go back, which would open the replay
  // window again. A failed read throws: the callers must not take it for "no nonce yet".
  async retrieve(address: string) {
    try {
      const variants = addressCasingVariants(address)
      const rows = await this.db.all<{ nonce: number }>(
        `SELECT "nonce" FROM nonce WHERE "id" IN (${placeholders(variants.length)})`,
        variants
      )
      const nonces = rows.map((row) => row.nonce).filter((n) => typeof n === 'number')
      return {
        id: normalizeAddress(address),
        nonce: nonces.length > 0 ? Math.max(...nonces) : null
      }
    } catch (error) {
      this.logError(`Error when retrieving the nonce of address ${address}`, error)
      throw error
    }
  }

  update(address: string, nonce: number) {
    return this.create(address, nonce)
  }

  async delete(address: string) {
    const id = normalizeAddress(address)
    try {
      const row = await this.db.get<{ nonce: number }>(
        'SELECT "nonce" FROM nonce WHERE "id" = ?',
        [id]
      )
      if (!row) return { id, nonce: null }
      await this.db.run('DELETE FROM nonce WHERE "id" = ?', [id])
      return { id, nonce: row.nonce }
    } catch (error) {
      this.logError(`Error when deleting the nonce of address ${address}`, error)
      return null
    }
  }

  private async write(address: string, nonce: number) {
    const id = normalizeAddress(address)
    await this.db.run(
      `INSERT INTO nonce ("id", "nonce") VALUES (?, ?)
       ON CONFLICT ("id") DO UPDATE SET "nonce" = excluded."nonce"`,
      [id, nonce]
    )
    return { id, nonce }
  }
}
