import { OceanNodeDBConfig } from '../../@types/OceanNode'
import Typesense from './typesense.js'

export class Database {
  typesense: Typesense
  // typesense configuration
  constructor(config: OceanNodeDBConfig) {
    this.typesense = new Typesense(config.typesense)
  }

  // These functions will be refactored eventually
  async getNonce(id: string): Promise<number> {
    const document = await this.typesense.collections('nonce').documents().retrieve(id)
    if (document) {
      return document.nonce
    }
    return 0
  }

  // set nonce for a specific address
  async setNonce(id: string, nonce: number): Promise<boolean> {
    try {
      const data = await this.typesense.collections('nonce').documents().create({
        id,
        nonce
      })
      return true
    } catch (err) {
      return false
    }
  }

  // the id is the consumer address
  async updateNonce(id: string, nonce: number): Promise<boolean> {
    const document = await this.typesense.collections('nonce').documents().retrieve(id)
    if (document) {
      const updated = {
        id,
        nonce
      }
      const update = await this.typesense
        .collections('nonce')
        .documents()
        .update(id, updated)
      return true
    }
    return false
  }
}
