import type { OceanNodeDBConfig } from '../../../@types/OceanNode.js'
import { addressCasingVariants, normalizeAddress } from '../../../utils/evmAddress.js'
import { AbstractNonceDatabase } from '../BaseDatabase.js'
import { orNull } from './orNull.js'
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

  create(address: string, nonce: number) {
    return orNull(`Error when writing nonce ${nonce} for address ${address}`, () =>
      this.write(address, nonce)
    )
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
    return orNull(`Error when updating nonce ${nonce} for address ${address}`, () =>
      this.write(address, nonce, 'WHERE nonce."nonce" < excluded."nonce"')
    )
  }

  delete(address: string) {
    const id = normalizeAddress(address)
    return orNull(`Error when deleting the nonce of address ${address}`, async () => {
      const row = await this.db.get<{ nonce: number }>(
        'SELECT "nonce" FROM nonce WHERE "id" = ?',
        [id]
      )
      if (!row) return { id, nonce: null }
      await this.db.run('DELETE FROM nonce WHERE "id" = ?', [id])
      return { id, nonce: row.nonce }
    })
  }

  // null when the condition kept the stored row
  private async write(address: string, nonce: number, condition = '') {
    const id = normalizeAddress(address)
    const { changes } = await this.db.run(
      `INSERT INTO nonce ("id", "nonce") VALUES (?, ?)
       ON CONFLICT ("id") DO UPDATE SET "nonce" = excluded."nonce" ${condition}`,
      [id, nonce]
    )
    return changes > 0 ? { id, nonce } : null
  }
}
