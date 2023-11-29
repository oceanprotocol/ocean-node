import { OceanP2P } from './components/P2P/index.js'
import { OceanProvider } from './components/Provider/index.js'
import { OceanIndexer } from './components/Indexer/index.js'
import { OceanNodeConfig } from './@types/OceanNode.js'
import { Database } from './components/database/index.js'

export class OceanNode {
  private config: OceanNodeConfig
  private node: OceanP2P
  private provider: OceanProvider
  private indexer: OceanIndexer
  private db: Database
  public constructor(config: OceanNodeConfig) {
    this.config = config
  }

  public buildOceanNode(config: OceanNodeConfig): OceanNode {
    this.db = new Database(config.dbConfig)
    if (config.hasP2P) {
      this.node = new OceanP2P(this.db, config)
    }
    if (config.hasIndexer) {
      this.indexer = new OceanIndexer(this.db, config.supportedNetworks)
    }
    if (config.hasProvider) {
      this.provider = new OceanProvider(this.db)
    }
    return this
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

  public getDatabase(): Database {
    return this.db
  }
}
