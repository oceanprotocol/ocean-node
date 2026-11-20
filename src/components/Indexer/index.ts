/**
 * Ocean Node Indexer - Main Module
 *
 * This module implements a multi-chain blockchain event indexer using a
 * single-threaded, non-blocking architecture optimized for I/O-bound operations.
 *
 * Architecture:
 * - Uses ChainIndexer instances (one per blockchain) that run concurrently
 * - All operations are async/await, leveraging Node.js event loop for concurrency
 * - No worker threads - optimal for I/O-bound workloads (RPC calls, DB queries)
 * - Event-driven communication via EventEmitter
 *
 * Key Components:
 * - OceanIndexer: Main orchestrator managing multiple ChainIndexer instances
 * - ChainIndexer: Per-chain indexer running async indexing loop
 * - Event Processors: Handle specific blockchain event types
 *
 * @module Indexer
 * @see {@link docs/indexer.md} for detailed documentation
 */

import EventEmitter from 'node:events'
import { Database } from '../database/index.js'
import { RPCS, SupportedNetwork } from '../../@types/blockchain.js'
import { ChainIndexer, ReindexTask } from './ChainIndexer.js'
import { INDEXER_LOGGER } from '../../utils/logging/common.js'
import {
  Blockchain,
  EVENTS,
  INDEXER_CRAWLING_EVENTS,
  PROTOCOL_COMMANDS
} from '../../utils/index.js'
import { BlockchainRegistry } from '../BlockchainRegistry/index.js'
import { CommandStatus, JobStatus } from '../../@types/commands.js'
import { buildJobIdentifier, getDeployedContractBlock } from './utils.js'
import { create256Hash } from '../../utils/crypt.js'
import { isReachableConnection } from '../../utils/database.js'
import { sleep } from '../../utils/util.js'
import { isReindexingNeeded } from './version.js'
import { getPackageVersion } from '../../utils/version.js'
import { DB_EVENTS, ES_CONNECTION_EVENTS } from '../database/ElasticsearchConfigHelper.js'
import { OceanNodeConfig } from '../../@types/OceanNode.js'
import { clearEventProcessorCache } from './processor.js'
import { OceanNode } from '../../OceanNode.js'

/**
 * Event emitter for DDO (Data Descriptor Object) events
 * External components subscribe to this for asset lifecycle events
 */
export const INDEXER_DDO_EVENT_EMITTER = new EventEmitter()

/**
 * Event emitter for internal indexer events
 * Used for communication between ChainIndexer instances and OceanIndexer
 */
export const INDEXER_CRAWLING_EVENT_EMITTER = new EventEmitter()

let INDEXING_QUEUE: ReindexTask[] = []
// job queue for admin commands or other commands not immediately available
const JOBS_QUEUE: JobStatus[] = []

const MAX_CRAWL_RETRIES = 10

/**
 * OceanIndexer - Multi-chain blockchain event indexer
 *
 * Manages indexing across multiple blockchain networks using a single-threaded,
 * non-blocking architecture. Each chain is monitored by a ChainIndexer instance
 * that runs concurrently via Node.js event loop.
 *
 * Features:
 * - Concurrent multi-chain indexing without worker threads
 * - Event-driven communication via EventEmitter
 * - Automatic version-based reindexing
 * - Admin commands for chain management
 * - Graceful shutdown support
 *
 * @see ChainIndexer for per-chain indexing implementation
 * @see docs/indexer.md for detailed architecture documentation
 */
export class OceanIndexer {
  private db: Database
  private config: OceanNodeConfig
  private networks: RPCS
  private blockchainRegistry?: BlockchainRegistry
  private supportedChains: string[]
  private indexers: Map<number, ChainIndexer> = new Map()
  // Minimum DB schema version: if the version stored in the DB is older than this, every
  // chain is reset to its deployment block and reindexed on startup (see
  // checkAndTriggerReindexing). Bump this to the current release whenever the indexed schema
  // changes in a way that needs a reindex. Bumped to 4.2.0 for the Escrow v2 / subsidy-provider
  // events (Subsidized / LockSponsored / SponsorRefunded) so existing deployments backfill them.
  private MIN_REQUIRED_VERSION = '4.2.0'
  private isDbConnected: boolean = true
  private reconnectTimer: NodeJS.Timeout | null = null
  // This instance's crawling-event handlers, retained so stop() detaches exactly them instead of
  // calling removeAllListeners() on the shared INDEXER_CRAWLING_EVENT_EMITTER (which would also
  // drop other OceanIndexers' handlers). setupEventListeners() also detaches the previous set
  // before re-registering, so repeated startAllChainIndexers() calls (e.g. on DB reconnect) don't
  // stack duplicate handlers on the shared emitter.
  private crawlingEventHandlers: Array<{
    event: string
    handler: (payload: any) => void
  }> = []
  // Pending addJob() status-promotion timers, cleared in stop() so a torn-down indexer's 2 s timer
  // doesn't fire after shutdown and mutate the shared JOBS_QUEUE (which leaks across the
  // shared-process test suite).
  private jobTimers: Set<NodeJS.Timeout> = new Set()
  // Bound ES-connection handlers, retained so stop() can detach them. They were registered as
  // anonymous listeners on the module-level ES_CONNECTION_EVENTS emitter and never removed, so
  // every OceanIndexer created in the shared-process test suite leaked a pair that kept reacting
  // (and could restart a torn-down indexer with its stale config) long after the instance was gone.
  private onDbConnectionLost: () => Promise<void>
  private onDbConnectionRestored: () => void
  // Generation-based cancellation for in-flight starts. Each start operation — a
  // startAllChainIndexers() batch, or a standalone startChainIndexer() — takes the next value of
  // startGeneration; stopAllChainIndexers() records the latest generation in canceledGeneration.
  // A start whose generation is <= canceledGeneration aborts instead of crawling. This closes a
  // start/stop race: startChainIndexer can sleep for seconds inside retryCrawlerWithDelay while
  // the blockchain connection comes up, and during that window the ChainIndexer does not yet
  // exist in `this.indexers`, so a concurrent stop finds nothing to cancel. A single boolean flag
  // was not enough: a later standalone start would reset it and revive an already-stopped start.
  // In the shared-process integration suite this left a stale indexer (whose config lacked the
  // suite's AUTHORIZED_PUBLISHERS gate) crawling chain 8996 and indexing assets a later suite
  // expects to be rejected (the flaky credentials "should NOT allow to index" failures). Tying
  // cancellation to a per-start generation means a stop only cancels the starts already issued,
  // and a fresh start (allocating a higher generation) is never revived or blocked by it.
  private startGeneration = 0
  private canceledGeneration = 0
  // In-flight startChainIndexer() calls. stopAllChainIndexers() awaits these before tearing down
  // registered indexers, so a start that is between ChainIndexer.start() (which launches the
  // background crawl loop) and registration in `this.indexers` is waited for and stopped, instead
  // of slipping through that gap and crawling on after the stop returns.
  private pendingStarts: Set<Promise<ChainIndexer | null>> = new Set()
  // One AbortController per in-flight start, tagged with the start's generation. stopAllChainIndexers()
  // aborts the controllers of canceled generations so a start blocked on the DB-reachability probe
  // (an otherwise-unbounded fetch) unblocks promptly — without which the shutdown join could hang on
  // it. When no stop occurs a probe is never aborted, so its result is unchanged.
  private startProbeControllers: Set<{
    generation: number
    controller: AbortController
  }> = new Set()

  constructor(
    _db: Database,
    _config: OceanNodeConfig,
    _blockchainRegistry: BlockchainRegistry
  ) {
    this.db = _db
    this.config = _config
    this.networks = this.config.indexingNetworks
    this.blockchainRegistry = _blockchainRegistry
    this.supportedChains = Object.keys(this.networks)
    clearEventProcessorCache()
    INDEXING_QUEUE = []
    // JOBS_QUEUE is a module-level global that was never reset, so jobs from a previous OceanIndexer
    // leaked into this one (the shared-process test suite). Reset it like INDEXING_QUEUE above.
    JOBS_QUEUE.length = 0
    this.setupDbConnectionListeners()
    this.startAllChainIndexers()
  }

  /**
   * Listen for Elasticsearch connection events.
   *
   * CONNECTION_LOST  → cancel any pending restart, stop all indexers once.
   * CONNECTION_RESTORED → debounce restart by 5 s so rapid LOST/RESTORED cycles are a single restart.
   */
  private setupDbConnectionListeners(): void {
    this.onDbConnectionLost = async () => {
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer)
        this.reconnectTimer = null
      }

      if (!this.isDbConnected) {
        return
      }

      this.isDbConnected = false
      INDEXER_LOGGER.error(
        'Database connection lost - stopping all chain indexers until DB is back'
      )
      await this.stopAllChainIndexers()
    }

    this.onDbConnectionRestored = () => {
      if (this.isDbConnected) {
        return
      }

      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer)
      }

      this.reconnectTimer = setTimeout(async () => {
        this.reconnectTimer = null
        if (this.isDbConnected) {
          return
        }

        this.isDbConnected = true
        INDEXER_LOGGER.info(
          'Database connection stable - reinitialising DB and restarting all chain indexers'
        )

        await this.startAllChainIndexers()
      }, 5000)
    }

    ES_CONNECTION_EVENTS.on(DB_EVENTS.CONNECTION_LOST, this.onDbConnectionLost)
    ES_CONNECTION_EVENTS.on(DB_EVENTS.CONNECTION_RESTORED, this.onDbConnectionRestored)
  }

  /**
   * Detach this instance's ES-connection listeners and cancel any pending reconnect timer.
   * Called from stop() so a torn-down indexer stops reacting to DB connection events (otherwise
   * every OceanIndexer ever created would keep listening on the shared emitter).
   */
  private teardownDbConnectionListeners(): void {
    if (this.onDbConnectionLost) {
      ES_CONNECTION_EVENTS.removeListener(
        DB_EVENTS.CONNECTION_LOST,
        this.onDbConnectionLost
      )
    }
    if (this.onDbConnectionRestored) {
      ES_CONNECTION_EVENTS.removeListener(
        DB_EVENTS.CONNECTION_RESTORED,
        this.onDbConnectionRestored
      )
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
  }

  public getSupportedNetworks(): RPCS {
    return this.networks
  }

  public getDatabase(): Database {
    return this.db
  }

  public getSupportedNetwork(chainId: number): SupportedNetwork {
    let network: SupportedNetwork
    // the following will us to quickly define rpc
    //  export RPCS="{ \"8996\": \"http://127.0.0.1:8545\"}
    if (typeof this.networks[chainId] === 'string') {
      network = {
        chainId,
        network: String(chainId),
        rpc: String(this.networks[chainId])
      }
    } else {
      network = this.networks[chainId]
    }
    // set some defaults if needed
    if (!network.chunkSize) network.chunkSize = 1
    return network
  }

  // stops all indexers
  public async stopAllChainIndexers(): Promise<boolean> {
    // Cancel any in-flight start (e.g. one still sleeping in retryCrawlerWithDelay before its
    // ChainIndexer is registered): mark every generation issued so far as canceled, so those
    // starts abort instead of beginning to crawl after we return. A later start allocates a
    // higher generation and is unaffected.
    this.canceledGeneration = this.startGeneration

    // Snapshot the in-flight starts at entry, BEFORE any await below. Every start pending right now
    // has a generation <= canceledGeneration (just set), so all are canceled; we join exactly these
    // and never a later, non-canceled start that registers while we await the crawler stops.
    const startsToJoin = [...this.pendingStarts]

    // Abort the DB-reachability probe of every canceled in-flight start, so one blocked on an
    // unresponsive probe fails fast (isReachableConnection → false → the start gives up) instead of
    // hanging the join below. Non-canceled starts (higher generation) keep their probe untouched.
    for (const probe of this.startProbeControllers) {
      if (probe.generation <= this.canceledGeneration) {
        probe.controller.abort()
      }
    }

    // Snapshot the indexers registered right now. We tear down exactly these instances — NOT
    // whatever the map holds after the join below. A start issued after this point has a higher,
    // non-canceled generation and may register during the join; tearing it down here would break
    // the contract that a later start is unaffected by this stop.
    const toStop: Array<[number, ChainIndexer]> = [...this.indexers.entries()]

    // Stop the already-registered crawlers FIRST — before joining in-flight starts below — so a
    // slow or hung start (e.g. one awaiting the DB-reachability probe) cannot keep live crawlers
    // indexing during shutdown. Confirm the map still holds this exact instance and evict it
    // atomically (no await between the check and the delete) before stopping it, so a newer
    // indexer at the same chain is left running.
    const stopPromises: Promise<void>[] = []
    for (const [chainID, indexer] of toStop) {
      if (this.indexers.get(chainID) !== indexer) {
        continue
      }
      this.indexers.delete(chainID)
      INDEXER_LOGGER.debug(`Stopping indexer for chain ${chainID}`)
      stopPromises.push(indexer.stop())
    }
    await Promise.allSettled(stopPromises)

    // Then wait for the starts that were in flight at entry to settle. Each aborts before
    // registering, or stops the indexer it just started (see doStartChainIndexer). A later,
    // non-canceled start issued during the stops above is deliberately NOT in this snapshot, so it
    // registers and keeps running. We aborted canceled starts' DB probes above, so this join cannot
    // block shutdown indefinitely on a start stuck in its connection probe.
    if (startsToJoin.length > 0) {
      await Promise.allSettled(startsToJoin)
    }

    // Preserve the historical always-true result (the previous loop pushed one promise per chain
    // unconditionally); no caller inspects it.
    return true
  }

  // stops indexing for a specific chain
  public async stopChainIndexer(chainID: number): Promise<void> {
    const indexer = this.indexers.get(chainID)
    if (indexer) {
      await indexer.stop()
      this.indexers.delete(chainID)
      INDEXER_LOGGER.debug(`Stopped indexer for chain ${chainID}`)
    } else {
      INDEXER_LOGGER.warn('Unable to find running indexer for chain ' + chainID)
    }
  }

  // A start (batch or standalone) is canceled when its generation has been superseded by a stop.
  private isStartCanceled(generation: number): boolean {
    return this.canceledGeneration >= generation
  }

  // Sleep up to `ms`, but wake early (returning true) as soon as the given start generation is
  // canceled. Keeps a stop during a connection retry from blocking shutdown for the full retry
  // interval (stopAllChainIndexers() awaits in-flight starts).
  private async sleepUnlessCanceled(ms: number, generation: number): Promise<boolean> {
    const sliceMs = 200
    let waited = 0
    while (waited < ms) {
      if (this.isStartCanceled(generation)) {
        return true
      }
      await sleep(Math.min(sliceMs, ms - waited))
      waited += sliceMs
    }
    return this.isStartCanceled(generation)
  }

  // it does not start crawling until the network connectin is ready
  async startCrawler(blockchain: Blockchain): Promise<boolean> {
    if ((await blockchain.isNetworkReady()).ready) {
      return true
    }
    return false
  }

  async retryCrawlerWithDelay(
    blockchain: Blockchain,
    interval: number = 5000, // in milliseconds
    generation?: number,
    // Aborted by stopAllChainIndexers() when this start's generation is canceled, so the
    // DB-reachability probe below cannot hang the start (and the shutdown join) indefinitely.
    probeSignal?: AbortSignal,
    // Retry count carried through the recursion (was a shared instance/global field, so one chain's
    // retries could push another past MAX_CRAWL_RETRIES). Local to this start's retry chain now.
    attempt: number = 0
  ): Promise<boolean> {
    // The start generation this retry belongs to. If that start is stopped while we sleep, abort
    // instead of eventually crawling (see `startGeneration`/`canceledGeneration`).
    const gen = generation ?? this.startGeneration
    try {
      const retryInterval = Math.max(blockchain.getKnownRPCs().length * 3000, interval) // give 2 secs per each one
      const result = await this.startCrawler(blockchain)
      const dbActive = this.getDatabase()
      if (
        !dbActive ||
        !(await isReachableConnection(dbActive.getConfig().url, probeSignal))
      ) {
        INDEXER_LOGGER.error(`Giving up start crawling. DB is not online!`)
        return false
      }
      if (result) {
        INDEXER_LOGGER.debug(
          `Blockchain connection established for chain ${blockchain.getSupportedChain()}`
        )
        // processNetworkData(blockchain.getProvider(), blockchain.getSigner())
        return true
      } else {
        INDEXER_LOGGER.warn(
          `Chain ${blockchain.getSupportedChain()}: blockchain connection is not established, retrying again in ${
            retryInterval / 1000
          } secs....`
        )
        const nextAttempt = attempt + 1
        if (nextAttempt <= MAX_CRAWL_RETRIES) {
          // delay the next call, but abort the retry chain promptly if this start was stopped
          // while we waited, so a stopped indexer doesn't keep retrying (and eventually start
          // crawling) after it was torn down.
          if (await this.sleepUnlessCanceled(retryInterval, gen)) {
            INDEXER_LOGGER.debug(
              'Stop requested during connection retry; aborting crawler start'
            )
            return false
          }
          // recursively call the same func, preserving this start's generation and probe signal
          return this.retryCrawlerWithDelay(
            blockchain,
            retryInterval,
            gen,
            probeSignal,
            nextAttempt
          )
        } else {
          INDEXER_LOGGER.error(
            `Giving up start crawling after ${MAX_CRAWL_RETRIES} retries.`
          )
          return false
        }
      }
    } catch (err) {
      INDEXER_LOGGER.error(`Error starting crawler: ${err.message}`)
      return false
    }
  }

  // starts indexing for a specific chain
  public async startChainIndexer(
    chainID: number,
    // A startAllChainIndexers() batch passes its shared generation so a single stop cancels the
    // whole batch. A standalone start (admin START_THREAD, resetCrawling) omits it and takes a
    // fresh generation, so a prior stop never blocks a later explicit (re)start of this chain.
    batchGeneration?: number
  ): Promise<ChainIndexer | null> {
    const generation = batchGeneration ?? ++this.startGeneration
    // Register this start as in-flight (plus a probe AbortController tagged with its generation) so
    // a concurrent stopAllChainIndexers() can both wait for it to settle and abort its DB probe,
    // rather than racing past it or hanging on it.
    const probe = { generation, controller: new AbortController() }
    this.startProbeControllers.add(probe)
    const startPromise = this.doStartChainIndexer(
      chainID,
      generation,
      probe.controller.signal
    )
    this.pendingStarts.add(startPromise)
    try {
      return await startPromise
    } finally {
      this.pendingStarts.delete(startPromise)
      this.startProbeControllers.delete(probe)
    }
  }

  private async doStartChainIndexer(
    chainID: number,
    generation: number,
    probeSignal: AbortSignal
  ): Promise<ChainIndexer | null> {
    // A standalone start (admin START_THREAD, resetCrawling) does not go through
    // startAllChainIndexers()'s teardown wait, so wait here too: a previous OceanNode instance's
    // teardown (its indexer stop + provider destroy) must finish before this indexer starts
    // crawling, or two indexers run concurrently against the same DB/chain. awaitPendingTeardown()
    // is a no-op when nothing is pending, so the batch path (which already awaited it) is unaffected.
    await OceanNode.awaitPendingTeardown()
    if (this.isStartCanceled(generation)) {
      INDEXER_LOGGER.debug(
        `Stop requested during startup (awaiting teardown); not starting indexer for chain ${chainID}`
      )
      return null
    }

    // If an indexer is already running, stop it first
    const existingIndexer = this.indexers.get(chainID)
    if (existingIndexer && existingIndexer.isIndexing()) {
      INDEXER_LOGGER.info(`Restarting indexer for chain ${chainID}`)
      await existingIndexer.stop()
      this.indexers.delete(chainID)
      await sleep(1000) // Give the indexer time to stop
    }

    const rpcDetails: SupportedNetwork = this.getSupportedNetwork(chainID)
    if (!rpcDetails) {
      INDEXER_LOGGER.error(
        'Unable to start (unsupported network) indexer for chain: ' + chainID
      )
      return null
    }

    // Use BlockchainRegistry if available, otherwise fall back to old pattern
    const blockchain: Blockchain = this.blockchainRegistry.getBlockchain(chainID)
    if (!blockchain) {
      INDEXER_LOGGER.error(`Unable to get Blockchain instance for chain: ${chainID}`)
      return null
    }
    const canStartIndexer = await this.retryCrawlerWithDelay(
      blockchain,
      5000,
      generation,
      probeSignal
    )
    if (!canStartIndexer) {
      INDEXER_LOGGER.error(
        `Cannot start indexer for chain ${chainID}. Check DB and RPC connections!`
      )
      return null
    }

    // A stop may have been requested while retryCrawlerWithDelay was waiting for the connection.
    // Do NOT start crawling in that case — otherwise this indexer outlives the stop and keeps
    // polling the chain with a now-stale config (see `startGeneration`/`canceledGeneration`).
    if (this.isStartCanceled(generation)) {
      INDEXER_LOGGER.debug(
        `Stop requested while connecting; not starting indexer for chain ${chainID}`
      )
      return null
    }

    // Create new ChainIndexer instance
    const indexer = new ChainIndexer(
      blockchain,
      rpcDetails,
      INDEXER_CRAWLING_EVENT_EMITTER,
      this.db,
      this.config
    )

    INDEXER_LOGGER.info(
      `Starting indexer for network ${rpcDetails.network} (chainId: ${chainID})`
    )

    // Start indexing (runs in background, doesn't block)
    await indexer.start()

    // ChainIndexer.start() launches the background crawl loop but does NOT register the indexer in
    // `this.indexers`, so until the set() below a concurrent stopAllChainIndexers() cannot reach
    // it. If a stop landed during start(), stop this freshly started indexer here instead of
    // leaving it crawling past the stop (see `startGeneration`/`canceledGeneration`).
    if (this.isStartCanceled(generation)) {
      INDEXER_LOGGER.debug(
        `Stop requested while starting; stopping freshly started indexer for chain ${chainID}`
      )
      await indexer.stop()
      return null
    }

    this.indexers.set(chainID, indexer)
    return indexer
  }

  // Start all chain indexers
  public async startAllChainIndexers(): Promise<boolean> {
    // Allocate this batch's generation BEFORE any await, so a stop that lands while we are still
    // awaiting teardown/reindex is recorded against this generation and aborts the batch
    // (see `startGeneration`/`canceledGeneration`).
    const generation = ++this.startGeneration

    // Close the overlap at its source: wait for a previous OceanNode instance's teardown
    // (its indexer stop + provider destroy) to finish before this indexer starts crawling,
    // so two indexers never run concurrently against the same DB/chain.
    await OceanNode.awaitPendingTeardown()
    if (this.isStartCanceled(generation)) {
      INDEXER_LOGGER.debug(
        'Stop requested during startup (awaiting teardown); aborting start of all chain indexers'
      )
      return false
    }

    await this.checkAndTriggerReindexing()
    if (this.isStartCanceled(generation)) {
      INDEXER_LOGGER.debug(
        'Stop requested during startup (reindex check); aborting start of all chain indexers'
      )
      return false
    }

    // Setup event listeners for all chains (they all use the same event emitter)
    this.setupEventListeners()

    // Start all indexers - they will run concurrently via async/await
    let count = 0
    for (const network of this.supportedChains) {
      // Stop the batch promptly if a stop landed mid-loop, instead of running a network/DB probe
      // per remaining chain only for each start to self-abort on the canceled generation.
      if (this.isStartCanceled(generation)) {
        INDEXER_LOGGER.debug(
          'Stop requested during startup (starting chains); aborting remaining chain indexers'
        )
        break
      }
      const chainId = parseInt(network)
      // Share this batch's generation across all chains, so a single stop cancels the whole
      // batch — including chains still coming up.
      const indexer = await this.startChainIndexer(chainId, generation)
      if (indexer) {
        count++
      }
    }

    return count === this.supportedChains.length
  }

  // Register a crawling-event handler and track it so stop() can detach exactly this instance's set.
  private onCrawling(event: string, handler: (payload: any) => void): void {
    this.crawlingEventHandlers.push({ event, handler })
    INDEXER_CRAWLING_EVENT_EMITTER.on(event, handler)
  }

  // Detach every crawling-event handler this instance registered (NOT removeAllListeners(), which
  // would also drop handlers belonging to other OceanIndexers sharing the module-level emitter).
  private teardownEventListeners(): void {
    for (const { event, handler } of this.crawlingEventHandlers) {
      INDEXER_CRAWLING_EVENT_EMITTER.removeListener(event, handler)
    }
    this.crawlingEventHandlers = []
  }

  private setupEventListeners() {
    // Detach any previously registered handlers first: setupEventListeners() runs on every
    // startAllChainIndexers() (including DB-reconnect restarts), so without this each restart would
    // stack another full set of handlers on the shared emitter (duplicate DDO emissions, leaks).
    this.teardownEventListeners()

    // Listen to metadata events from any chain indexer
    const metadataEvents = [
      EVENTS.METADATA_CREATED,
      EVENTS.METADATA_UPDATED,
      EVENTS.METADATA_STATE,
      EVENTS.ORDER_STARTED,
      EVENTS.ORDER_REUSED,
      EVENTS.DISPENSER_ACTIVATED,
      EVENTS.DISPENSER_DEACTIVATED,
      EVENTS.EXCHANGE_ACTIVATED,
      EVENTS.EXCHANGE_DEACTIVATED,
      EVENTS.EXCHANGE_RATE_CHANGED
    ]

    metadataEvents.forEach((eventType) => {
      this.onCrawling(eventType, async (event: any) => {
        try {
          if (!event.data) {
            INDEXER_LOGGER.debug(
              `Missing event data (ddo) for ${eventType} on chain ${event.chainId}`
            )
            return
          }

          INDEXER_LOGGER.debug(
            `Emitting "${eventType}" for DDO: ${event.data.id} from network: ${event.chainId}`
          )
          await Promise.resolve(INDEXER_DDO_EVENT_EMITTER.emit(eventType, event.data.id))
        } catch (err) {
          INDEXER_LOGGER.error(
            `Event handler failed for ${eventType}: ${err?.message ?? err}`
          )
        }
      })
    })

    // Listen to reindex queue pop events
    this.onCrawling(INDEXER_CRAWLING_EVENTS.REINDEX_QUEUE_POP, (event: any) => {
      try {
        INDEXING_QUEUE = INDEXING_QUEUE.filter(
          (task) => task.txId !== event.txId && task.chainId !== event.chainId
        )
        this.updateJobStatus(
          PROTOCOL_COMMANDS.REINDEX_TX,
          create256Hash([event.chainId, event.txId].join('')),
          CommandStatus.SUCCESS
        )
      } catch (err) {
        INDEXER_LOGGER.error(`Reindex queue pop handler failed: ${err?.message ?? err}`)
      }
    })

    // Listen to reindex chain events
    this.onCrawling(INDEXER_CRAWLING_EVENTS.REINDEX_CHAIN, (event: any) => {
      try {
        this.updateJobStatus(
          PROTOCOL_COMMANDS.REINDEX_CHAIN,
          create256Hash([event.chainId].join('')),
          event.result ? CommandStatus.SUCCESS : CommandStatus.FAILURE
        )
      } catch (err) {
        INDEXER_LOGGER.error(`Reindex chain handler failed: ${err?.message ?? err}`)
      }
    })

    // Listen to crawling started events
    this.onCrawling(INDEXER_CRAWLING_EVENTS.CRAWLING_STARTED, (event: any) => {
      INDEXER_LOGGER.info(
        `Chain ${event.chainId}: crawling from block ${event.startBlock}`
      )
    })
  }

  public addReindexTask(reindexTask: ReindexTask): JobStatus | null {
    const indexer = this.indexers.get(reindexTask.chainId)
    if (indexer) {
      const job = buildJobIdentifier(PROTOCOL_COMMANDS.REINDEX_TX, [
        reindexTask.chainId.toString(),
        reindexTask.txId
      ])
      indexer.addReindexTask(reindexTask)
      INDEXING_QUEUE.push(reindexTask)
      this.addJob(job)
      return job
    }
    INDEXER_LOGGER.warn(`No indexer found for chain ${reindexTask.chainId}`)
    return null
  }

  public async resetCrawling(
    chainId: number,
    blockNumber?: number
  ): Promise<JobStatus | null> {
    let indexer = this.indexers.get(chainId)

    // If not running or not found, start it first
    if (!indexer || !indexer.isIndexing()) {
      INDEXER_LOGGER.warn(
        'Indexer for chain: ' + chainId + ' is not running, starting first...'
      )
      indexer = await this.startChainIndexer(chainId)
      if (!indexer) {
        INDEXER_LOGGER.error(`Could not start indexer for chain ${chainId}, aborting...`)
        return null
      }
    }

    if (indexer) {
      const job = buildJobIdentifier(PROTOCOL_COMMANDS.REINDEX_CHAIN, [
        chainId.toString()
      ])
      indexer.triggerReindexChain(blockNumber)
      this.addJob(job)
      return job
    } else {
      INDEXER_LOGGER.error(`Could not find indexer for chain ${chainId}, aborting...`)
    }
    return null
  }

  public getIndexingQueue(): ReindexTask[] {
    return INDEXING_QUEUE.slice()
  }

  public getJobsPool(jobId?: string): JobStatus[] {
    if (jobId) {
      const result = this.filterJobs(jobId)
      // if it finished, then we can remove it from the list of jobs. Use the job's actual index
      // (result.position) returned by filterJobs — a hardcoded -1 spliced the LAST job instead,
      // removing the wrong entry whenever the finished job was not at the end of the queue.
      if (
        result.position >= 0 &&
        result.jobsResult.length === 1 &&
        [CommandStatus.FAILURE, CommandStatus.SUCCESS].includes(
          result.jobsResult[0].status
        )
      ) {
        JOBS_QUEUE.splice(result.position, 1)
      }
      return result.jobsResult
    }
    return JOBS_QUEUE.slice()
  }

  // when we add a new job, we change the status from DELIVERED to PENDING if still running after a couple secs
  public addJob(jobInfo: JobStatus) {
    JOBS_QUEUE.push(jobInfo)
    // Track the timer so stop() can clear it; otherwise a torn-down OceanIndexer leaves a pending
    // 2 s timer that fires after shutdown and mutates the shared JOBS_QUEUE.
    const timer = setTimeout(() => {
      this.jobTimers.delete(timer)
      const result = this.filterJobs(jobInfo.jobId)
      if (
        result.jobsResult.length === 1 &&
        result.jobsResult[0].status === CommandStatus.DELIVERED
      ) {
        this.updateJobStatus(jobInfo.command, jobInfo.hash, CommandStatus.PENDING)
      }
    }, 2000)
    this.jobTimers.add(timer)
  }

  // Cancel any pending addJob() status-promotion timers (called from stop()).
  private clearJobTimers(): void {
    for (const timer of this.jobTimers) {
      clearTimeout(timer)
    }
    this.jobTimers.clear()
  }

  // filter jobs by job id, return the position of the job on the queue as well
  private filterJobs(jobId: string): { position: number; jobsResult: JobStatus[] } {
    let pos = -1
    const result = JOBS_QUEUE.filter((job: JobStatus, index: number) => {
      if (job.jobId === jobId) {
        pos = index
        return true
      }
      return false
    })
    return { position: pos, jobsResult: result }
  }

  // update the job status, given the command and the hash
  private updateJobStatus(command: string, hash: string, newStatus: CommandStatus) {
    if (JOBS_QUEUE.length > 0) {
      for (let i = JOBS_QUEUE.length - 1; i >= 0; i--) {
        const job = JOBS_QUEUE[i]
        // make sure we always pick the correct one
        if (job.command === command && hash === job.hash) {
          job.status = newStatus
        }
      }
    }
  }

  /**
   * Checks if reindexing is needed and triggers it for all chains
   */
  public async checkAndTriggerReindexing(): Promise<void> {
    const currentVersion = getPackageVersion()
    const dbActive = this.getDatabase()
    if (!dbActive || !(await isReachableConnection(dbActive.getConfig().url))) {
      INDEXER_LOGGER.error(`Giving up reindexing. DB is not online!`)
      return
    }
    const dbVersion = await dbActive.sqliteConfig?.retrieveValue()
    INDEXER_LOGGER.debug(
      `Node version check: Current=${currentVersion}, DB=${
        dbVersion?.value ?? 'not set'
      }, Min Required=${this.MIN_REQUIRED_VERSION}`
    )

    if (isReindexingNeeded(currentVersion, dbVersion.value, this.MIN_REQUIRED_VERSION)) {
      INDEXER_LOGGER.info(
        `Reindexing needed: DB version ${
          dbVersion.value || 'not set'
        } is older than minimum required ${this.MIN_REQUIRED_VERSION}`
      )

      // Reindex all chains by directly setting last indexed block to deployment block
      for (const chainID of this.supportedChains) {
        const chainIdNum = Number(chainID)

        INDEXER_LOGGER.debug(
          `Triggering reindexing for chain ${chainIdNum} by resetting to the deployment block`
        )

        try {
          // First delete all assets from this chain
          const numDeleted = await dbActive.ddo.deleteAllAssetsFromChain(chainIdNum)
          INDEXER_LOGGER.info(`Deleted ${numDeleted} assets from chain ${chainIdNum}`)

          // Update database directly by resetting last indexed block
          const contractDeploymentBlock = getDeployedContractBlock(chainIdNum)
          const result = await dbActive.indexer.update(
            chainIdNum,
            contractDeploymentBlock
          )

          if (!result) {
            INDEXER_LOGGER.error(
              `Reindex chain job for ${chainIdNum} failed. Please retry reindexChain command manually for this chain.`
            )
          } else {
            INDEXER_LOGGER.info(
              `Chain ${chainIdNum}: index reset to deployment block ${contractDeploymentBlock}`
            )
          }
        } catch (error) {
          INDEXER_LOGGER.error(
            `Error resetting index for chain ${chainIdNum}: ${error.message}. Please retry reindexChain command manually.`
          )
        }
      }
      await dbActive.sqliteConfig?.createOrUpdateConfig('version', currentVersion)
      INDEXER_LOGGER.info(`Updated node version in database to ${currentVersion}`)
    } else {
      INDEXER_LOGGER.debug('No reindexing needed based on version check')
    }
  }

  public async stop(): Promise<void> {
    // Detach DB listeners and cancel any pending reconnect BEFORE stopping, so a
    // CONNECTION_RESTORED arriving mid-stop cannot schedule a restart. stopAllChainIndexers()
    // then marks in-flight starts (including an already-fired reconnect that is mid-startup) as
    // canceled, so none can resurrect an indexer after shutdown.
    this.teardownDbConnectionListeners()
    await this.stopAllChainIndexers()
    // Detach only THIS instance's crawling-event handlers and cancel its pending job timers. Do
    // NOT removeAllListeners() on the shared emitters: INDEXER_CRAWLING_EVENT_EMITTER is shared by
    // any future OceanIndexer, and INDEXER_DDO_EVENT_EMITTER has external subscribers (the P2P
    // node's METADATA_CREATED handler, test utils) that a blanket removeAllListeners() would
    // silently unsubscribe.
    this.teardownEventListeners()
    this.clearJobTimers()
  }
}
