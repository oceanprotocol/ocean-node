import { OceanP2P } from './components/P2P/index.js'
import { OceanProvider } from './components/Provider/index.js'
import { OceanIndexer } from './components/Indexer/index.js'
import { OceanNodeConfig } from './@types/OceanNode.js'
import { Database } from './components/database/index.js'

export class OceanNode {
  // private config: OceanNodeConfig
  // private node: OceanP2P
  // private provider: OceanProvider
  // private indexer: OceanIndexer
  // private db: Database
  // eslint-disable-next-line no-useless-constructor
  public constructor(
    private config: OceanNodeConfig,
    private db: Database,
    private node?: OceanP2P,
    private provider?: OceanProvider,
    private indexer?: OceanIndexer
  ) {}

  public addP2PNode(_node: OceanP2P) {
    this.node = _node
  }

  public addProvider(_provider: OceanProvider) {
    this.provider = _provider
  }

  public addIndexer(_indexer: OceanIndexer) {
    this.indexer = _indexer
  }

  public getConfig(): OceanNodeConfig {
    return this.config
  }

  public getP2PNode(): OceanP2P | undefined {
    return this.node
  }

  public getProvider(): OceanProvider | undefined {
    return this.provider
  }

  public getIndexer(): OceanIndexer | undefined {
    return this.indexer
  }

  public getDatabase(): Database {
    return this.db
  }
}
