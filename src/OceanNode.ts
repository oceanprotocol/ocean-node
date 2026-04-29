import { OceanP2P } from './components/P2P/index.js'
import { OceanProvider } from './components/Provider/index.js'
import { OceanIndexer } from './components/Indexer/index.js'
import {
  AccessListContract,
  OceanNodeConfig,
  P2PCommandResponse
} from './@types/OceanNode.js'
import { ValidateChainId } from './@types/commands.js'

import { Database } from './components/database/index.js'
import { Escrow } from './components/core/utils/escrow.js'
import { CoreHandlersRegistry } from './components/core/handler/coreHandlersRegistry.js'
import { OCEAN_NODE_LOGGER } from './utils/logging/common.js'
import { GENERIC_EMOJIS, LOG_LEVELS_STR } from './utils/logging/Logger.js'
import { BaseHandler } from './components/core/handler/handler.js'
import { C2DEngines } from './components/c2d/compute_engines.js'
import { Auth } from './components/Auth/index.js'
import { KeyManager } from './components/KeyManager/index.js'
import { BlockchainRegistry } from './components/BlockchainRegistry/index.js'
import { Blockchain } from './utils/blockchain.js'
import { createPersistentStorage } from './components/persistentStorage/createPersistentStorage.js'
import { PersistentStorageFactory } from './components/persistentStorage/PersistentStorageFactory.js'
import { isAddress, FallbackProvider, ethers } from 'ethers'
import { create256Hash } from './utils/crypt.js'

export interface RequestLimiter {
  requester: string | string[] // IP address or peer ID
  lastRequestTime: number // time of the last request done (in miliseconds)
  numRequests: number // number of requests done in the specific time period
}

export interface RequestDataCheck {
  valid: boolean
  updatedRequestData: RequestLimiter
}
export class OceanNode {
  // eslint-disable-next-line no-use-before-define
  private static instance: OceanNode
  // handlers
  private coreHandlers: CoreHandlersRegistry
  // compute engines
  private c2dEngines: C2DEngines
  // escrow
  public escrow: Escrow
  // requester
  private remoteCaller: string | string[]
  private requestMap: Map<string, RequestLimiter>
  private auth: Auth
  private persistentStorage: PersistentStorageFactory
  private database: Database

  // eslint-disable-next-line no-useless-constructor
  private constructor(
    private config: OceanNodeConfig,
    private db?: Database,
    private node?: OceanP2P,
    private provider?: OceanProvider,
    private indexer?: OceanIndexer,
    public keyManager?: KeyManager,
    public blockchainRegistry?: BlockchainRegistry
  ) {
    this.keyManager = keyManager
    this.blockchainRegistry = blockchainRegistry
    this.coreHandlers = CoreHandlersRegistry.getInstance(this, true)
    this.requestMap = new Map<string, RequestLimiter>()
    this.config = config
    this.database = db

    if (this.db && this.db?.authToken) {
      this.auth = new Auth(this.db.authToken, config)
    }
    if (node) {
      node.setCoreHandlers(this.coreHandlers)
    }
    if (this.config) {
      this.escrow = new Escrow(
        this.config.supportedNetworks,
        this.config.claimDurationTimeout,
        this.blockchainRegistry
      )
      if (this.config.persistentStorage?.enabled) {
        OCEAN_NODE_LOGGER.info(
          `Starting PersistenStorage with type ${this.config.persistentStorage.type}`
        )
        this.persistentStorage = createPersistentStorage(this)
      } else {
        OCEAN_NODE_LOGGER.info(`Starting without PersistenStorage`)
        this.persistentStorage = null
      }
    }
    this.addIndexer(indexer)
  }

  // Singleton instance
  public static getInstance(
    config?: OceanNodeConfig,
    db?: Database,
    node?: OceanP2P,
    provider?: OceanProvider,
    indexer?: OceanIndexer,
    keyManager?: KeyManager,
    blockchainRegistry?: BlockchainRegistry,
    newInstance: boolean = false
  ): OceanNode {
    if (!OceanNode.instance || newInstance) {
      if (!keyManager || !blockchainRegistry) {
        if (!config) {
          throw new Error('KeyManager and BlockchainRegistry are required')
        }
        if (!keyManager) keyManager = new KeyManager(config)
        if (!blockchainRegistry)
          blockchainRegistry = new BlockchainRegistry(keyManager, config)
      }
      // teardown old instance if needed
      this.instance?.tearDownAll().catch((err: unknown) => {
        OCEAN_NODE_LOGGER.warn(
          `Failed to tear down previous OceanNode instance: ${
            err instanceof Error ? err.message : String(err)
          }`
        )
      })
      OCEAN_NODE_LOGGER.debug('Creating new OceanNode instance')
      this.instance = new OceanNode(
        config,
        db,
        node,
        provider,
        indexer,
        keyManager,
        blockchainRegistry
      )
    } else {
      OCEAN_NODE_LOGGER.debug('Return cached OceanNode instance')
    }
    return this.instance
  }

  // in the future we should remove these 'add' methods as well
  public addProvider(_provider: OceanProvider) {
    this.provider = _provider
  }

  public addIndexer(_indexer: OceanIndexer) {
    const previous = this.indexer
    this.indexer = _indexer
    if (previous) {
      previous.stop().catch((err: unknown) => {
        OCEAN_NODE_LOGGER.warn(
          `Failed to stop replaced indexer: ${err instanceof Error ? err.message : String(err)}`
        )
      })
    }
  }

  public async tearDownAll() {
    if (this.c2dEngines) {
      await this.c2dEngines.stopAllEngines()
      this.c2dEngines = null
    }
    if (this.indexer) {
      await this.indexer.stop()
      this.indexer = null
    }
    if (this.blockchainRegistry) {
      this.blockchainRegistry.stop()
      this.blockchainRegistry = null
    }
    if (OceanNode.instance === this) {
      OceanNode.instance = null
    }
    OCEAN_NODE_LOGGER.debug('OceanNode instance stopped & cleared')
  }

  public async addC2DEngines() {
    if (this.c2dEngines) {
      await this.c2dEngines.stopAllEngines()
    }
    if (this.config && this.config.c2dClusters) {
      if (!this.db || !this.db.c2d) {
        OCEAN_NODE_LOGGER.error('C2DDatabase is mandatory for compute engines!')
        return
      }
      this.c2dEngines = new C2DEngines(
        this.config,
        this.db.c2d,
        this.escrow,
        this.keyManager
      )
      await this.c2dEngines.startAllEngines()
    }
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

  public getC2DEngines(): C2DEngines | undefined {
    return this.c2dEngines
  }

  public getCoreHandlers(): CoreHandlersRegistry {
    return this.coreHandlers
  }

  public getRequestMapSize(): number {
    return this.requestMap.size
  }

  public getRequestMap(): Map<string, RequestLimiter> {
    return this.requestMap
  }

  public getAuth(): Auth {
    return this.auth
  }

  public getKeyManager(): KeyManager {
    return this.keyManager
  }

  public getBlockchainRegistry(): BlockchainRegistry {
    return this.blockchainRegistry
  }

  public getPersistentStorage(): PersistentStorageFactory | null {
    return this.persistentStorage
  }

  /**
   * Get a Blockchain instance for the given chainId.
   * Delegates to BlockchainRegistry.
   */
  public getBlockchain(chainId: number): Blockchain | null {
    return this.blockchainRegistry.getBlockchain(chainId)
  }

  public setConfig(config: OceanNodeConfig) {
    this.config = config
    if (this.config) {
      this.escrow = new Escrow(
        this.config.supportedNetworks,
        this.config.claimDurationTimeout,
        this.blockchainRegistry
      )
    }
  }

  public getConfig(): OceanNodeConfig {
    return this.config
  }

  /**
   * v3: Direct protocol command handler - no P2P, just call handler directly
   * Returns {status, stream} without buffering
   * @param message - JSON command string
   */
  async handleDirectProtocolCommand(message: string): Promise<P2PCommandResponse> {
    OCEAN_NODE_LOGGER.logMessage('Incoming direct command for ocean peer', true)
    OCEAN_NODE_LOGGER.logMessage('Performing task: ' + message, true)

    try {
      const task = JSON.parse(message)
      const handler: BaseHandler = this.coreHandlers.getHandler(task.command)

      if (!handler) {
        return {
          stream: null,
          status: {
            httpStatus: 501,
            error: 'Unknown command or missing handler for: ' + task.command
          }
        }
      }

      // Return response directly without buffering
      return await handler.handle(task)
    } catch (err) {
      OCEAN_NODE_LOGGER.logMessageWithEmoji(
        'handleDirectProtocolCommands Error: ' + err.message,
        true,
        GENERIC_EMOJIS.EMOJI_CROSS_MARK,
        LOG_LEVELS_STR.LEVEL_ERROR
      )

      return {
        stream: null,
        status: { httpStatus: 500, error: err.message }
      }
    }
  }

  getAdminAddresses(): { addresses: string[]; accessLists: any } {
    const ret = {
      addresses: [] as string[],
      accessLists: undefined as AccessListContract | undefined
    }

    if (this.config.allowedAdmins && this.config.allowedAdmins.length > 0) {
      for (const admin of this.config.allowedAdmins) {
        if (isAddress(admin) === true) {
          ret.addresses.push(admin)
        }
      }
    }
    ret.accessLists = this.config.allowedAdminsList
    return ret
  }

  checkSupportedChainId(chainId: number): ValidateChainId {
    if (!chainId || !(`${chainId.toString()}` in this.config.supportedNetworks)) {
      OCEAN_NODE_LOGGER.error(`Chain ID ${chainId} is not supported`)
      return {
        validation: false,
        networkRpc: ''
      }
    }
    return {
      validation: true,
      networkRpc: this.config.supportedNetworks[chainId.toString()].rpc
    }
  }

  async getJsonRpcProvider(chainId: number): Promise<FallbackProvider> {
    const checkResult = this.checkSupportedChainId(chainId)
    if (!checkResult.validation) {
      return null
    }
    const blockchain = this.getBlockchain(chainId)
    if (!blockchain) return null
    return await blockchain.getProvider()
  }

  hasP2PInterface() {
    return this.config.hasP2P || false
  }

  private dbInitPromise: Promise<Database> | null = null
  async getDatabase(forceReload: boolean = false): Promise<Database> {
    if (!this.database || forceReload) {
      if (!this.dbInitPromise || forceReload) {
        const { dbConfig } = this.config
        if (dbConfig && dbConfig.url) {
          this.dbInitPromise = Database.init(dbConfig).then((db) => {
            this.database = db
            return db
          })
        }
      }
      return await this.dbInitPromise
    }
    return this.database
  }

  async getValidationSignature(ddo: string): Promise<any> {
    try {
      const hashedDDO = create256Hash(ddo)
      const providerWallet = await this.keyManager.getEthWallet()
      const messageHash = ethers.solidityPackedKeccak256(
        ['bytes'],
        [ethers.hexlify(ethers.toUtf8Bytes(hashedDDO))]
      )
      const signed32Bytes = await providerWallet.signMessage(
        new Uint8Array(ethers.toBeArray(messageHash))
      )
      const signatureSplitted = ethers.Signature.from(signed32Bytes)
      const v = signatureSplitted.v <= 1 ? signatureSplitted.v + 27 : signatureSplitted.v
      const r = ethers.hexlify(signatureSplitted.r) // 32 bytes
      const s = ethers.hexlify(signatureSplitted.s)
      return { hash: hashedDDO, publicKey: providerWallet.address, r, s, v }
    } catch (error) {
      OCEAN_NODE_LOGGER.logMessage(`Validation signature error: ${error}`, true)
      return { hash: '', publicKey: '', r: '', s: '', v: '' }
    }
  }
}
