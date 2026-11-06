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
import { errorSummary } from './utils/logging/redact.js'
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
import {
  MAINTENANCE_MODE_CONFIG_KEY,
  SUPPORTED_PROTOCOL_COMMANDS
} from './utils/constants.js'

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
  private static instance: OceanNode
  // In-flight teardown of the previous instance (set by getInstance). A newly-created
  // OceanIndexer awaits this before crawling, so it never overlaps a dying indexer on
  // the same DB/chain while that instance's provider is being destroyed.
  private static pendingTeardown: Promise<void> | null = null
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
  // In-memory cache of the maintenance (drain) flag so the hot path (every compute/service
  // start) does not hit SQLite per request. Source of truth is the SQLite config DB; this is
  // loaded from it at startup (loadMaintenanceMode) and kept in sync on every toggle.
  private maintenanceMode = false
  // Serializes maintenance toggles so a DB write and its cache update are atomic relative to
  // any concurrent toggle (prevents DB/cache divergence under overlapping calls).
  private maintenanceWriteLock: Promise<unknown> = Promise.resolve()

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
          `Persistent storage enabled (type: ${this.config.persistentStorage.type})`
        )
        this.persistentStorage = createPersistentStorage(this)
      } else {
        OCEAN_NODE_LOGGER.info('Persistent storage disabled')
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
      // Teardown the old instance if needed, and retain the promise so a newly-created
      // OceanIndexer can await it before crawling (see awaitPendingTeardown). Chain onto any
      // still-pending teardown from an earlier replacement instead of overwriting it, so the
      // barrier keeps covering every outstanding teardown, not just the most recent one.
      const previousTeardown = OceanNode.pendingTeardown
      const instanceToTearDown = this.instance
      OceanNode.pendingTeardown = (async () => {
        if (previousTeardown) {
          await previousTeardown
        }
        if (instanceToTearDown) {
          try {
            await instanceToTearDown.tearDownAll()
          } catch (err: unknown) {
            OCEAN_NODE_LOGGER.error(
              `Failed to tear down previous OceanNode instance: ${
                err instanceof Error ? err.message : String(err)
              }`
            )
          }
        }
      })()
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
    }
    return this.instance
  }

  /**
   * Await a previous instance's in-flight teardown (set by getInstance) so callers such as a
   * freshly-constructed OceanIndexer don't start crawling while the old instance is still
   * shutting down its indexer and destroying its provider. No-op when nothing is pending.
   */
  public static async awaitPendingTeardown(): Promise<void> {
    const pending = OceanNode.pendingTeardown
    if (pending) {
      await pending
      // Only clear if a newer teardown didn't replace it while we were awaiting.
      if (OceanNode.pendingTeardown === pending) {
        OceanNode.pendingTeardown = null
      }
    }
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
        OCEAN_NODE_LOGGER.error(
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
   * Whether the node is in maintenance (drain) mode. Hot-path read of the in-memory cache.
   */
  public isInMaintenance(): boolean {
    return this.maintenanceMode
  }

  /**
   * Toggle maintenance mode. Persists the flag to the SQLite config DB (durable, sticky across
   * restarts) and only THEN updates the in-memory cache, so a failed write never leaves the
   * cache claiming a drain that was not persisted (it would silently revert on reboot). Calls
   * are serialized on a promise chain so two overlapping toggles cannot end with the DB and the
   * cache disagreeing. Throws if the write fails — the admin handler maps that to a 500.
   */
  public setMaintenanceMode(enabled: boolean): Promise<void> {
    // Serialize: chain onto the previous write so DB-write + cache-assignment are atomic
    // relative to any concurrent toggle. Keep the chain alive even if an op throws.
    const run = this.maintenanceWriteLock.then(() => this.applyMaintenanceMode(enabled))
    this.maintenanceWriteLock = run.catch(() => {})
    return run
  }

  private async applyMaintenanceMode(enabled: boolean): Promise<void> {
    const db = await this.getDatabase()
    if (db?.sqliteConfig) {
      // createOrUpdateConfig swallows DB errors and returns null; treat that as a failure and
      // do NOT update the cache, so the node never reports an un-persisted drain.
      const result = await db.sqliteConfig.createOrUpdateConfig(
        MAINTENANCE_MODE_CONFIG_KEY,
        enabled ? 'true' : 'false'
      )
      if (result === null) {
        throw new Error('Failed to persist maintenance mode flag to the config DB')
      }
    } else {
      OCEAN_NODE_LOGGER.warn(
        'Maintenance mode set without a config DB: the flag will NOT persist across restarts'
      )
    }
    this.maintenanceMode = enabled
    OCEAN_NODE_LOGGER.info(`Maintenance mode ${enabled ? 'ENABLED' : 'DISABLED'}`)
  }

  /**
   * Load the persisted maintenance flag into the in-memory cache at startup. If the
   * MAINTENANCE_MODE env var is set it wins at boot and is written through to the DB, so the
   * persisted state stays consistent with the env override. Guards for a missing config DB.
   */
  public async loadMaintenanceMode(): Promise<void> {
    const envValue = process.env.MAINTENANCE_MODE
    const db = await this.getDatabase()
    const sqliteConfig = db?.sqliteConfig
    // Env override wins at boot and is written through to the DB (per design). Only the exact
    // strings "true"/"false" are honored; any other non-empty value (a typo, "1", "yes") is
    // IGNORED with a warning, so a leftover malformed env var cannot silently clear a drain.
    if (envValue !== undefined && envValue.trim() !== '') {
      const normalized = envValue.trim().toLowerCase()
      if (normalized !== 'true' && normalized !== 'false') {
        OCEAN_NODE_LOGGER.warn(
          `Ignoring invalid MAINTENANCE_MODE value "${envValue}" (expected "true" or "false"); falling back to the persisted flag`
        )
      } else {
        const enabled = normalized === 'true'
        this.maintenanceMode = enabled
        if (sqliteConfig) {
          const result = await sqliteConfig.createOrUpdateConfig(
            MAINTENANCE_MODE_CONFIG_KEY,
            enabled ? 'true' : 'false'
          )
          if (result === null) {
            OCEAN_NODE_LOGGER.warn(
              'MAINTENANCE_MODE env override could not be persisted to the config DB; it applies for this process only'
            )
          }
        }
        OCEAN_NODE_LOGGER.info(
          `Maintenance mode ${enabled ? 'ENABLED' : 'DISABLED'} from MAINTENANCE_MODE env var`
        )
        return
      }
    }
    if (!sqliteConfig) {
      return
    }
    try {
      const stored = await sqliteConfig.retrieveValue(MAINTENANCE_MODE_CONFIG_KEY)
      // retrieveValue swallows DB errors and returns { value: null }. A genuinely absent key is
      // normal (never toggled) and also yields null, so this is a warning, not an error: we fail
      // open (maintenance off) but make it visible in the logs.
      if (!stored || stored.value === null || stored.value === undefined) {
        OCEAN_NODE_LOGGER.warn(
          'Maintenance mode flag not present or unreadable in the config DB; defaulting to OFF'
        )
        this.maintenanceMode = false
        return
      }
      this.maintenanceMode = stored.value === 'true'
      if (this.maintenanceMode) {
        OCEAN_NODE_LOGGER.warn(
          'Node started in MAINTENANCE mode (persisted flag): new compute/service requests are rejected until an admin sends setMaintenance { enabled: false }'
        )
      }
    } catch (error) {
      OCEAN_NODE_LOGGER.error(
        `Failed to load maintenance mode flag: ${errorSummary(error)}`
      )
    }
  }

  /**
   * v3: Direct protocol command handler - no P2P, just call handler directly
   * Returns {status, stream} without buffering
   * @param message - JSON command string
   */
  async handleDirectProtocolCommand(message: string): Promise<P2PCommandResponse> {
    let command: string | undefined
    try {
      const task = JSON.parse(message)
      // only known command names are logged: a raw, caller-supplied string could embed
      // control characters and forge extra log lines (CWE-117)
      command = SUPPORTED_PROTOCOL_COMMANDS.includes(task?.command)
        ? task.command
        : 'unknown'
      OCEAN_NODE_LOGGER.debug(`Direct command: ${command}`)
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
      OCEAN_NODE_LOGGER.error(
        `Direct command ${command ?? '(unparsed)'} failed: ${errorSummary(err)}`
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
      OCEAN_NODE_LOGGER.debug(`Chain ID ${chainId} is not supported`)
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
      OCEAN_NODE_LOGGER.error(`Validation signature error: ${errorSummary(error)}`)
      return { hash: '', publicKey: '', r: '', s: '', v: '' }
    }
  }
}
