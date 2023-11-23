import { OceanP2P } from './components/P2P/index.js'
import { OceanProvider } from './components/Provider/index.js'
import { OceanIndexer } from './components/Indexer/index.js'
import { OceanNodeConfig } from './@types'

export class OceanNode {
  private config: OceanNodeConfig
  private node: OceanP2P
  private provider: OceanProvider
  private indexer: OceanIndexer
  public constructor(config: OceanNodeConfig) {
    this.config = config
  }

  public getConfig(): OceanNodeConfig {
    return this.config
  }

  public getP2PNode(): OceanP2P {
    return this.node
  }

  public getProvider(): OceanProvider {
    return this.provider
  }

  public getIndexer(): OceanIndexer {
    return this.indexer
  }

  public setOceanNode(
    newNode: OceanP2P,
    newIndexer: OceanIndexer,
    newProvider: OceanProvider
  ): void {
    this.node = newNode
    this.indexer = newIndexer
    this.provider = newProvider
  }
}
