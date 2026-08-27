import EventEmitter from 'node:events'
import lodash from 'lodash'
import { handleProtocolCommands } from './handlers.js'
import {
  LP_RESUME_BELOW_BYTES,
  lpFramedStream,
  LpFrameReader,
  pauseReads,
  resumeReads
} from './lpFraming.js'

import { fromString as uint8ArrayFromString } from 'uint8arrays/from-string'
import { toString as uint8ArrayToString } from 'uint8arrays/to-string'
import { LengthPrefixedStream } from '@libp2p/utils'
import { KEEP_ALIVE } from '@libp2p/interface'
import type { Connection, Stream } from '@libp2p/interface'

import { bootstrap } from '@libp2p/bootstrap'
import { noise } from '@chainsafe/libp2p-noise'
import { mdns } from '@libp2p/mdns'
import { yamux } from '@chainsafe/libp2p-yamux'
import { peerIdFromString } from '@libp2p/peer-id'

import { tcp } from '@libp2p/tcp'
import { webSockets } from '@libp2p/websockets'
import { circuitRelayTransport, circuitRelayServer } from '@libp2p/circuit-relay-v2'
import { createLibp2p, Libp2p } from 'libp2p'
import type { AddressManager, TransportManager } from '@libp2p/interface-internal'
import { identify, identifyPush } from '@libp2p/identify'
import { autoNAT } from '@libp2p/autonat'
import { uPnPNAT } from '@libp2p/upnp-nat'
import { ping } from '@libp2p/ping'
import { dcutr } from '@libp2p/dcutr'
import {
  kadDHT,
  passthroughMapper,
  removePrivateAddressesMapper,
  removePublicAddressesMapper
} from '@libp2p/kad-dht'

import { EVENTS, cidFromRawString } from '../../utils/index.js'
import { Transform, Readable } from 'stream'
import { Database } from '../database'
import {
  OceanNodeConfig,
  FindDDOResponse,
  OceanNodeP2PStatus,
  dhtFilterMethod
} from '../../@types/OceanNode.js'
import { KeyManager } from '../KeyManager/index.js'
import ipaddr from 'ipaddr.js'
import { GENERIC_EMOJIS, LOG_LEVELS_STR } from '../../utils/logging/Logger.js'
import { INDEXER_DDO_EVENT_EMITTER } from '../Indexer/index.js'
import { P2P_LOGGER } from '../../utils/logging/common.js'
import { CoreHandlersRegistry } from '../core/handler/coreHandlersRegistry.js'
import { Multiaddr, multiaddr } from '@multiformats/multiaddr'
import { LevelDatastore } from 'datastore-level'
import { P2P_TIMEOUTS, peerStoreAgeLimits, stageSignal } from './timeouts.js'
import { provideLimit } from './provideLimiter.js'
import { sendToLimit, sendToLimiterStats } from './sendToLimiter.js'
import {
  addressConfirmation,
  autoTlsState,
  connectionBreakdown,
  dialQueueStats,
  effectivePeerStoreAges,
  relayReservations
} from './observability.js'
import {
  P2P_ERROR,
  P2PError,
  classifyP2PError,
  delayBeforeRetry,
  describeP2PError,
  isRetryableP2PError,
  retryDelayMs
} from './errors.js'
import {
  cachePeerResolution,
  cachePeerResolutionMiss,
  getCachedPeerResolution,
  invalidatePeerResolution,
  isPeerResolutionNegativelyCached,
  peerResolutionCacheStats
} from './peerResolutionCache.js'
import {
  RESOLVE_DHT_HIT,
  RESOLVE_MISS,
  RESOLVE_PEERSTORE_HIT,
  SENDTO_FAIL_REASONS,
  SENDTO_OK,
  countP2PEvent,
  countSendToFailure,
  getP2PCounters
} from './counters.js'

import { autoTLS } from '@ipshipyard/libp2p-auto-tls'
import { keychain } from '@libp2p/keychain'
import { http } from '@libp2p/http'
import { tls } from '@libp2p/tls'
const store = new LevelDatastore('./databases/p2p-store')

const DEFAULT_OPTIONS = {
  pollInterval: 1000
}

// we might want this configurable
export const CACHE_TTL = 1000 * 60 * 5 // 5 minutes
type DDOCache = {
  // when last updated cache
  updated: number
  dht: Map<string, FindDDOResponse>
}

let index = 0

/** Optional request payload sent as LP frames after the command JSON; ends with an empty LP frame. */
export type P2PRequestBodyStream = AsyncIterable<Uint8Array | Buffer | string> | Readable

/**
 * Which tier of `resolvePeer` produced a peer's addresses.
 *
 * `connection` and `peerstore` are both local answers; `cache` is the app-level resolution
 * cache, which sits in front of every tier and is the one provenance a caller must treat with
 * suspicion - it is the only source that can hand back an address nothing has checked recently,
 * and the reason `sendTo` invalidates on a failed dial. `negative-cache` means a recent lookup
 * found nothing and the answer was reused rather than re-walked; `none` means every enabled
 * tier ran and came up empty.
 */
export type PeerResolutionSource =
  'connection' | 'peerstore' | 'dht' | 'cache' | 'negative-cache' | 'none'

/** Addresses for a peer plus the tier that produced them. */
export type PeerResolution = {
  addresses: Multiaddr[]
  source: PeerResolutionSource
}

/**
 * Reply to a P2P command: the parsed status frame plus the raw body frames.
 * Stated explicitly because inferring it would leak a nested `uint8arraylist`
 * path that TypeScript cannot name (TS2742).
 */
export type P2PSendResponse = {
  status: any
  stream: AsyncIterable<Uint8Array>
}

function toUint8ArrayChunk(chunk: unknown): Uint8Array {
  if (chunk instanceof Uint8Array) return chunk
  if (Buffer.isBuffer(chunk)) return new Uint8Array(chunk)
  if (typeof chunk === 'string') return uint8ArrayFromString(chunk)
  if (
    chunk &&
    typeof chunk === 'object' &&
    ArrayBuffer.isView(chunk as ArrayBufferView)
  ) {
    const v = chunk as ArrayBufferView
    return new Uint8Array(v.buffer, v.byteOffset, v.byteLength)
  }
  throw new Error('Unsupported chunk type for P2P request body')
}

async function writeP2pRequestBodyLp(
  lp: LengthPrefixedStream<Stream>,
  body: P2PRequestBodyStream,
  signal: AbortSignal
): Promise<void> {
  for await (const chunk of body as AsyncIterable<unknown>) {
    await lp.write(toUint8ArrayChunk(chunk), { signal })
  }
  await lp.write(new Uint8Array(0), { signal })
}

export class OceanP2P extends EventEmitter {
  _libp2p: Libp2p
  _options: any
  _connections: {}
  _protocol: string
  _publicAddress: string
  _analyzeRemoteResponse: Transform
  _pendingAdvertise: string[] = []
  private _ddoDHT: DDOCache
  private _interval: NodeJS.Timeout
  private _upnp_interval: NodeJS.Timeout
  private _ip_discovery_interval: NodeJS.Timeout
  private _idx: number
  /**
   * Peer IDs parsed from `p2pConfig.bootstrapNodes` - the only "configured", as opposed to
   * discovered, peer set this node has, and in this network the same peers also serve as
   * circuit relays. Computed once in `start()`; used by `handlePeerConnect` to apply the
   * `KEEP_ALIVE` tag. See the comment there for why the plain `bootstrap` tag is not enough.
   */
  private _bootstrapPeerIds: Set<string> = new Set()
  private readonly db: Database
  private readonly _config: OceanNodeConfig
  private readonly keyManager: KeyManager
  private coreHandlers: CoreHandlersRegistry
  constructor(config: OceanNodeConfig, keyManager: KeyManager, db?: Database) {
    super()
    this._config = config
    this.keyManager = keyManager
    this.db = db
    this._ddoDHT = {
      updated: new Date().getTime(),
      dht: new Map<string, FindDDOResponse>()
    }
  }

  setCoreHandlers(coreHandlers: CoreHandlersRegistry) {
    if (!this.coreHandlers) {
      this.coreHandlers = coreHandlers
    }
  }

  getCoreHandlers() {
    return this.coreHandlers
  }

  getConfig() {
    return this._config
  }

  async start(options: any = null) {
    this._libp2p = await this.createNode(this._config)
    this._bootstrapPeerIds = new Set(
      (this._config.p2pConfig.bootstrapNodes ?? [])
        .map((addr) => {
          try {
            return multiaddr(addr)
              .getComponents()
              .find((entry) => entry.name === 'p2p')?.value
          } catch (e) {
            return undefined
          }
        })
        .filter((id): id is string => id !== undefined)
    )
    this._libp2p.addEventListener('peer:connect', (evt: any) => {
      this.handlePeerConnect(evt)
    })
    this._libp2p.addEventListener('peer:disconnect', (evt: any) => {
      this.handlePeerDisconnect(evt)
    })
    this._libp2p.addEventListener('peer:discovery', (details: any) => {
      this.handlePeerDiscovery(details)
    })
    this._libp2p.addEventListener('certificate:provision', () => {
      this.handleCertificateProvision()
    })
    this._libp2p.addEventListener('certificate:renew', () => {
      this.handleCertificateRenew()
    })
    this._options = Object.assign(
      {},
      lodash.cloneDeep(DEFAULT_OPTIONS),
      lodash.cloneDeep(options)
    )
    this._connections = {}
    this._protocol = '/ocean/nodes/1.0.0'

    this._interval = setInterval(this._flushAdvertiseQueue.bind(this), 60 * 1000) // every 60 seconds

    // only enable handling of commands if not bootstrap node
    if (!this._config.isBootstrap) {
      // runOnLimitedConnection is required, otherwise relayed (limited) connections
      // cannot open command streams to us at all
      this._libp2p.handle(this._protocol, handleProtocolCommands.bind(this), {
        runOnLimitedConnection: true,
        maxInboundStreams: P2P_TIMEOUTS.commandMaxInboundStreams
      })
    }

    this._idx = index++

    this._analyzeRemoteResponse = new Transform({
      transform(chunk, encoding, callback) {
        callback(null, chunk.toString().toUpperCase())
      }
    })
    // listen for indexer events and advertise did
    INDEXER_DDO_EVENT_EMITTER.addListener(EVENTS.METADATA_CREATED, (did) => {
      P2P_LOGGER.info(`Listened "${EVENTS.METADATA_CREATED}"`)
      // Fire-and-forget, so the rejection has to be handled right here: `advertiseString`
      // reports a failed provide to its caller, and an unhandled rejection is fatal to the
      // process - the node installs an `unhandledRejection` handler that exits.
      // Deliberately not routed through the shared provide limiter: this is one DID per
      // indexed asset, and queueing it behind a republish batch would delay a fresh
      // publication by the whole batch.
      this.advertiseString(did).catch((err) => {
        P2P_LOGGER.error(`Failed to advertise ${did}: ${describeP2PError(err)}`)
      })
    })
  }

  handlePeerConnect(details: any) {
    if (details) {
      const peerId = details.detail
      P2P_LOGGER.debug('Connection established to:' + peerId.toString()) // Emitted when a peer has been found
      // Tag bootstrap peers with KEEP_ALIVE on every connect, in addition to the plain tag
      // the bootstrap discovery service already applies (`bootstrapTagName`, default
      // "bootstrap"). The two are not interchangeable: libp2p's reconnect queue only re-dials
      // a peer whose tag name starts with "keep-alive" (`@libp2p/interface`'s `KEEP_ALIVE`
      // constant), so without this a dropped bootstrap peer was shielded from connection
      // trimming by its tag value but never reconnected. No ttl is set on purpose - a finite
      // one would let this tag expire too, which is worse: the peer becomes prunable again
      // and, exactly like the bootstrap tag alone, is never reconnected.
      if (this._bootstrapPeerIds.has(peerId.toString())) {
        this._libp2p.peerStore
          .merge(peerId, { tags: { [`${KEEP_ALIVE}-bootstrap`]: { value: 1 } } })
          .catch((err: unknown) => {
            P2P_LOGGER.error(
              `Failed to tag bootstrap peer for keep-alive reconnect: ${describeP2PError(
                err,
                { peerId: peerId.toString() }
              )}`
            )
          })
      }
    }
  }

  handlePeerDisconnect(details: any) {
    const peerId = details.detail
    P2P_LOGGER.debug('Connection closed to:' + peerId.toString()) // Emitted when a peer has been found
  }

  handlePeerDiscovery(details: any) {
    try {
      const peerInfo = details.detail
      P2P_LOGGER.debug('Discovered new peer:' + peerInfo.id.toString())

      // v2/v3: autodialer was removed - we implement custom dial logic
      const currentConnections = this._libp2p.getConnections().length
      const { maxConnections } = this._config.p2pConfig

      // Only dial if we still have room for more connections
      if (currentConnections < maxConnections) {
        const existingConnections = this._libp2p.getConnections(peerInfo.id)
        if (existingConnections.length === 0) {
          this._libp2p
            .dial(peerInfo.id, {
              signal: AbortSignal.timeout(P2P_TIMEOUTS.discoveryDialMs)
            })
            .catch((err: Error) => {
              // The address count matters here more than anywhere: a discovered peer with
              // no dialable address and one that refuses every address it advertised
              // produce the same message and are completely different problems.
              P2P_LOGGER.debug(
                `Failed to dial discovered peer: ${describeP2PError(err, {
                  peerId: peerInfo.id.toString(),
                  addresses: peerInfo.multiaddrs?.length
                })}`
              )
            })
        }
      }
    } catch (e) {
      // no panic if it failed
      // console.error(e)
    }
  }

  handleCertificateProvision() {
    P2P_LOGGER.info('----- A TLS certificate was provisioned -----')
    const interval = setInterval(() => {
      const mas = this._libp2p
        .getMultiaddrs()
        .filter((ma: any) => ma.toString().includes('/sni/'))
        .map((ma: any) => ma.toString())
      if (mas.length > 0) {
        P2P_LOGGER.info('----- TLS addresses: -----')
        P2P_LOGGER.info(mas.join('\n'))
        P2P_LOGGER.info('----- End of TLS addresses -----')
      }
      clearInterval(interval)
    }, 1_000)
  }

  handleCertificateRenew() {
    P2P_LOGGER.info('----- A TLS certificate was renewed -----')
  }

  handlePeerJoined(details: any) {
    P2P_LOGGER.debug('New peer joined us:' + details)
  }

  handlePeerLeft(details: any) {
    P2P_LOGGER.debug('Peer left us:' + details)
  }

  handlePeerMessage(details: any) {
    P2P_LOGGER.debug('peer joined us:' + details)
  }

  handleSubscriptionCHange(details: any) {
    P2P_LOGGER.debug('subscription-change:' + details.detail)
  }

  shouldAnnounce(addr: any) {
    try {
      const maddr = multiaddr(addr)

      const protos = maddr.getComponents()
      // multiaddr v13 dropped nodeAddress() - the host is the value of the
      // leading ip*/dns* component
      const hostComponent = protos.find(
        (entry) =>
          entry.name === 'ip4' ||
          entry.name === 'ip6' ||
          entry.name === 'dns' ||
          entry.name === 'dns4' ||
          entry.name === 'dns6' ||
          entry.name === 'dnsaddr'
      )
      if (hostComponent?.value === undefined) {
        // no host to inspect, e.g. a circuit relay address - same outcome as
        // before, when nodeAddress() threw and we fell through to the catch
        return true
      }
      const addressString = hostComponent.value
      if (
        protos.some(
          (entry) =>
            entry.name === 'dns' ||
            entry.name === 'dns4' ||
            entry.name === 'dns6' ||
            entry.name === 'dnsaddr'
        )
      ) {
        if (addressString === 'localhost' || addressString === '127.0.0.1') {
          return false
        }

        return true
      }

      if (!ipaddr.isValid(addressString)) {
        return false
      }

      const parsedAddr = ipaddr.parse(addressString)
      const range = parsedAddr.range()

      if (range === 'loopback') {
        return false
      }
      // check filters
      for (const filter of this._config.p2pConfig.filterAnnouncedAddresses) {
        try {
          const parsedCIDR = ipaddr.parseCIDR(filter)
          if ((parsedAddr as any).match(parsedCIDR as any)) {
            return false
          }
        } catch (e) {
          P2P_LOGGER.error(`Invalid CIDR filter in config: ${filter}`)
        }
      }
      if (
        this._config.p2pConfig.announcePrivateIp === false &&
        (range === 'private' || range === 'uniqueLocal')
      ) {
        // disabled logs because of flooding
        // P2P_LOGGER.debug(
        //  'Deny announcement of private address ' + addressString
        // )
        return false
      }
      return true
    } catch (e) {
      // we reach this part when having circuit relay. this is fine
      return true
    }
  }

  async createNode(config: OceanNodeConfig): Promise<Libp2p | null> {
    try {
      this._publicAddress = this.keyManager.getPeerIdString()
      P2P_LOGGER.info(`Starting P2P Node with peerID: ${this._publicAddress}`)

      /** @type {import('libp2p').Libp2pOptions} */
      // start with some default, overwrite based on config later
      const bindInterfaces = []
      if (config.p2pConfig.enableIPV4) {
        P2P_LOGGER.info('Binding P2P sockets to IPV4')
        bindInterfaces.push(
          `/ip4/${config.p2pConfig.ipV4BindAddress}/tcp/${config.p2pConfig.ipV4BindTcpPort}`
        )
        bindInterfaces.push(
          `/ip4/${config.p2pConfig.ipV4BindAddress}/tcp/${config.p2pConfig.ipV4BindWsPort}/ws`
        )
        if (config.p2pConfig.ipV4BindWssPort) {
          bindInterfaces.push(
            `/ip4/${config.p2pConfig.ipV4BindAddress}/tcp/${config.p2pConfig.ipV4BindWssPort}/wss`
          )
        }
      }
      if (config.p2pConfig.enableIPV6) {
        P2P_LOGGER.info('Binding P2P sockets to IPV6')
        bindInterfaces.push(
          `/ip6/${config.p2pConfig.ipV6BindAddress}/tcp/${config.p2pConfig.ipV6BindTcpPort}`
        )
        bindInterfaces.push(
          `/ip6/${config.p2pConfig.ipV6BindAddress}/tcp/${config.p2pConfig.ipV6BindWsPort}/ws`
        )
      }
      const listenAddrs = config.p2pConfig.enableCircuitRelayClient
        ? [...bindInterfaces, '/p2p-circuit']
        : bindInterfaces
      let addresses = {}
      if (
        config.p2pConfig.announceAddresses &&
        config.p2pConfig.announceAddresses.length > 0
      ) {
        addresses = {
          listen: listenAddrs,
          announceFilter: (multiaddrs: any[]) =>
            multiaddrs.filter((m) => this.shouldAnnounce(m)),
          appendAnnounce: config.p2pConfig.announceAddresses
        }
      } else {
        addresses = {
          listen: listenAddrs,
          announceFilter: (multiaddrs: any[]) =>
            multiaddrs.filter((m) => this.shouldAnnounce(m))
        }
      }
      const dhtOptions: {
        allowQueryWithZeroPeers: boolean
        maxInboundStreams: number
        maxOutboundStreams: number
        kBucketSize: number
        disjointPaths: number
        protocol: string
        peerInfoMapper: typeof passthroughMapper
        initialQuerySelfInterval: number
        clientMode?: boolean
      } = {
        allowQueryWithZeroPeers: false,
        maxInboundStreams: config.p2pConfig.dhtMaxInboundStreams,
        maxOutboundStreams: config.p2pConfig.dhtMaxOutboundStreams,
        kBucketSize: 20,
        // Caps how many disjoint lookup paths one query may run concurrently, independent of
        // `kBucketSize` (which doubles as the provider-record replication factor and the
        // per-provide write amplification, so it stays at 20). `alpha` is left at kad-dht's
        // default of 10 (query concurrency per path); undeclared, `disjointPaths` also
        // defaults to `alpha`, so a single query could otherwise put up to 10 x 10 = 100
        // concurrent lookups in flight against a dial queue an order of magnitude smaller -
        // capping the DHT's own fan-out here is cheaper than widening the dial queue to match
        // it. 4 x 10 = 40 is the resulting ceiling.
        disjointPaths: 4,
        protocol: '/ocean/nodes/1.0.0/kad/1.0.0',
        // filterPrivate (removePrivateAddressesMapper) is the dhtFilter default; passthroughMapper
        // is restored below when announcePrivateIp is set, for local/test networks.
        peerInfoMapper: passthroughMapper,
        // When kad-dht runs its *first* self-query - the query whose results are what initially
        // populate the routing table.
        //
        // kad-dht's default is 1 second, and raising it is the fix rather than lowering it,
        // which is counter-intuitive enough to be worth stating. The self-query runs once at
        // this interval and is then not run again until `querySelfInterval`, which is five
        // minutes. At one second this node has no DHT peers yet: bootstrap discovery emits its
        // peers after `bootstrapTimeout` and each still has to be dialled. So the first
        // self-query ran against an empty routing table, `allowQueryWithZeroPeers: false` failed
        // it immediately, and the table then stayed empty for five minutes but for whatever
        // arrived passively from inbound identify. Running it once, later, with bootstrap
        // connections in place is what populates the table quickly.
        //
        // `querySelfInterval` is deliberately left at kad-dht's default: shortening it would
        // multiply self-query traffic across every node in the network permanently, to cover a
        // case that is a bootstrap outage.
        initialQuerySelfInterval: P2P_TIMEOUTS.initialQuerySelfMs
      }
      // `clientMode` is left unset unless an operator explicitly asserts this node is
      // reachable. Passing the option at all - even `false` - stops kad-dht registering the
      // listener that auto-promotes this node from client to server the moment it has a
      // public, non-circuit address (and auto-demotes it again if that address later
      // disappears): in @libp2p/kad-dht's kad-dht.js, that listener is only added
      // `if (init.clientMode == null)`. See getNetworkingStats()/dhtMode for the running mode.
      if (config.p2pConfig.dhtForceServer) {
        dhtOptions.clientMode = false
      }
      if (config.p2pConfig.dhtFilter === dhtFilterMethod.filterPrivate)
        dhtOptions.peerInfoMapper = removePrivateAddressesMapper
      if (config.p2pConfig.dhtFilter === dhtFilterMethod.filterPublic)
        dhtOptions.peerInfoMapper = removePublicAddressesMapper
      if (config.p2pConfig.announcePrivateIp) {
        // Local/test networks announce private addresses on purpose (see shouldAnnounce
        // above), so the DHT must not strip them back out regardless of dhtFilter's default.
        dhtOptions.peerInfoMapper = passthroughMapper
      }
      let servicesConfig = {
        identify: identify(),
        dht: kadDHT(dhtOptions),
        identifyPush: identifyPush(),
        ping: ping(),
        dcutr: dcutr(),
        keychain: keychain(),
        http: http(),
        // Always announe the public address and tls in P2P_ANNOUNCE_ADDRESSES / p2pConfig.announceAddresses.
        // Ex. /ip4/<ip-address>/tcp/<port>/tls/ws
        // Ex. /ip4/<ip-address>/tcp/<port>/tls/wss
        autoTLS: autoTLS({
          autoConfirmAddress: true
        })
      }

      if (config.p2pConfig.enableCircuitRelayServer) {
        P2P_LOGGER.info('Enabling Circuit Relay Server')
        servicesConfig = {
          ...servicesConfig,
          ...{
            circuitRelay: circuitRelayServer({ reservations: { maxReservations: 2 } })
          }
        }
      }
      if (config.p2pConfig.upnp) {
        P2P_LOGGER.info('Enabling UPnp discovery')
        servicesConfig = {
          ...servicesConfig,
          ...{ upnpNAT: uPnPNAT() }
        }
      }
      if (config.p2pConfig.autoNat) {
        P2P_LOGGER.info('Enabling AutoNat service')
        servicesConfig = {
          ...servicesConfig,
          ...{
            autoNAT: autoNAT({ maxInboundStreams: 20, maxOutboundStreams: 20 })
          }
        }
      }

      let transports = []
      P2P_LOGGER.info('Enabling P2P Transports: websockets, tcp, circuitRelay')
      // relay discovery is now automatic through the network's RandomWalk component
      transports = [webSockets(), tcp(), circuitRelayTransport()]

      // How long addresses learned about a peer stay usable. libp2p's default is one hour,
      // while a DHT provider record is valid for 48, so the default left provider records
      // pointing at peers whose addresses had already been dropped - the lookup found the
      // provider and then had nothing to dial. Both limits are raised to the provider-record
      // lifetime so the two expire together. See `peerStoreAgeLimits`.
      const peerStoreAges = peerStoreAgeLimits()
      P2P_LOGGER.info(
        `Peer store address lifetime: ${peerStoreAges.maxAddressAge}ms, peer record lifetime: ${peerStoreAges.maxPeerAge}ms`
      )

      let options = {
        addresses,
        datastore: store,
        peerStore: peerStoreAges,
        privateKey: this.keyManager.getLibp2pPrivateKey(),
        transports,
        streamMuxers: [yamux()],
        connectionEncrypters: [
          noise(),
          tls()
          // plaintext()
        ],
        services: servicesConfig,
        connectionManager: {
          maxParallelDials: config.p2pConfig.connectionsMaxParallelDials,
          dialTimeout: config.p2pConfig.connectionsDialTimeout,
          maxConnections: config.p2pConfig.maxConnections,
          maxPeerAddrsToDial: config.p2pConfig.maxPeerAddrsToDial,
          maxDialQueueLength: config.p2pConfig.maxDialQueueLength
        },
        connectionMonitor: {
          // A tuned interval, and the ping-failure abort libp2p itself defaults to (both were
          // previously off/short-circuited to stop pings killing long-running download
          // connections). A large-transfer soak against this exact configuration - real
          // TCP+yamux+noise nodes, the production `pauseReads`/`resumeReads` backpressure loop,
          // an async slow consumer, transfers well past this file's >4 MiB corruption-check
          // floor - found no false aborts: yamux ping frames are multiplexed independently of a
          // paused data stream, so a slow *I/O-bound* consumer never starves them. What does
          // starve them is a consumer that blocks the event loop synchronously; nothing on this
          // response path does that (verified separately by adding a synchronous busy-loop to
          // a soak consumer, which does reproduce the abort - the failure mode is event-loop
          // starvation, not the monitor itself).
          pingInterval: 30000,
          abortConnectionOnPingFailure: true
        }
      }
      if (config.p2pConfig.bootstrapNodes && config.p2pConfig.bootstrapNodes.length > 0) {
        options = {
          ...options,
          ...{
            peerDiscovery: [
              bootstrap({
                list: config.p2pConfig.bootstrapNodes,
                timeout: config.p2pConfig.bootstrapTimeout, // in ms,
                tagName: config.p2pConfig.bootstrapTagName,
                tagValue: config.p2pConfig.bootstrapTagValue,
                tagTTL: config.p2pConfig.bootstrapTTL
              }),
              mdns({
                interval: config.p2pConfig.mDNSInterval
              })
            ]
          }
        }
      } else {
        // only mdns
        options = {
          ...options,
          ...{
            peerDiscovery: [
              mdns({
                interval: config.p2pConfig.mDNSInterval
              })
            ]
          }
        }
      }
      const node = await createLibp2p(options)
      await node.start()

      // Log every DHT client/server mode transition. The auto-switch this enables (see
      // dhtOptions above) is bidirectional: a reachability blip can demote an already-promoted
      // node back to client, and promote it again once the address reappears. kad-dht does not
      // emit an event for this itself, so the transition is observed by wrapping `setMode` -
      // the same method both directions of the auto-switch call. If flapping ever shows up in
      // these logs, `addressVerificationTTL` is the knob to damp it with: it is libp2p's own
      // `AddressManager` init option (default 10 minutes, see
      // node_modules/libp2p/dist/src/address-manager/index.js) for how long a confirmed
      // address is trusted before it needs reconfirming, and this repo does not currently pass
      // it through `createLibp2p`'s options above. That damping is not implemented here. The
      // current mode is also exposed live through getNetworkingStats().
      const dhtService = (node.services as Record<string, any> | undefined)?.dht as
        | {
            getMode?: () => string
            setMode?: (mode: string, options?: unknown) => Promise<void>
          }
        | undefined
      if (dhtService?.getMode && dhtService.setMode) {
        let lastKnownDhtMode = dhtService.getMode()
        const originalSetMode = dhtService.setMode.bind(dhtService)
        dhtService.setMode = async (mode: string, setModeOptions?: unknown) => {
          await originalSetMode(mode, setModeOptions)
          const currentMode = dhtService.getMode!()
          if (currentMode !== lastKnownDhtMode) {
            P2P_LOGGER.info(`DHT mode changed: ${lastKnownDhtMode} -> ${currentMode}`)
            lastKnownDhtMode = currentMode
          }
        }
      }

      const upnpService = (node.services as any).upnpNAT
      if (config.p2pConfig.upnp && upnpService) {
        this._upnp_interval = setInterval(this.UPnpCron.bind(this), 3000)
      }

      return node
    } catch (e) {
      P2P_LOGGER.logMessageWithEmoji(
        'Unable to create node: ' + describeP2PError(e),
        true,
        GENERIC_EMOJIS.EMOJI_CROSS_MARK,
        LOG_LEVELS_STR.LEVEL_ERROR
      )
    }
    return null
  }

  async getAllPeerStore() {
    const s = await this._libp2p.peerStore.all()
    return s
    // for await (const peer of this._libp2p.peerRouting.getClosestPeers(s[0].id.toString())) {
    //  console.log(peer.id, peer.multiaddrs)
    // }
  }

  getNetworkingStats() {
    const ret: any = {}
    ret.announce = this._libp2p.getMultiaddrs().map((ma) => ma.toString())
    ret.connections = this._libp2p
      .getConnections()
      .map((conn) => conn.remoteAddr.toString())

    const libp2pInternal = this._libp2p as Libp2p & {
      components: {
        addressManager: AddressManager
        transportManager: TransportManager
      }
    }
    if (libp2pInternal.components) {
      ret.binds = libp2pInternal.components.addressManager
        .getListenAddrs()
        .map((ma) => ma.toString())
      ret.listen = libp2pInternal.components.transportManager
        .getAddrs()
        .map((ma) => ma.toString())
      ret.observing = libp2pInternal.components.addressManager
        .getObservedAddrs()
        .map((ma) => ma.toString())
    }

    // Address-resolution and sendTo outcome counts, process-lifetime totals. They are what
    // makes the peer store's address lifetime measurable: resolutions shifting between the
    // peerstore and DHT lanes, and the reasons sendTo failed.
    ret.counters = getP2PCounters()

    // "client" or "server" - see the mode-transition comment in createNode() for what can
    // change it after startup.
    const dhtService = (this._libp2p.services as Record<string, any> | undefined)?.dht as
      { getMode?: () => string } | undefined
    ret.dhtMode = dhtService?.getMode ? dhtService.getMode() : undefined

    // Current occupancy, read on demand, of the two structures that sit in front of the
    // network: the app-level resolution cache and the outbound send queue. Not counters -
    // there is no history here, only what is in them right now - which is why they are
    // reported separately from `counters` rather than folded into it.
    ret.resolutionCache = peerResolutionCacheStats()
    ret.outboundSends = sendToLimiterStats()
    ret.readiness = this.getP2PStatus()

    // Everything below reads libp2p internals and reports `undefined` rather than throwing
    // when the shape it expects has moved - see `observability.ts`. `ret.connections` above
    // is the raw address list and stays as it was; this is the same set counted.
    ret.connectionBreakdown = connectionBreakdown(this._libp2p)
    ret.dialQueue = dialQueueStats(this._libp2p)
    ret.addressConfirmation = addressConfirmation(this._libp2p)
    ret.relayReservations = relayReservations(this._libp2p)
    ret.autoTls = autoTlsState(this._libp2p)
    // The lifetimes the running node applies, which is not necessarily what the environment
    // currently says - they are read once at construction.
    ret.peerStoreAges = effectivePeerStoreAges(this._libp2p)

    return ret
  }

  /**
   * Peers in the DHT routing table, or `undefined` when the DHT service cannot be reached.
   *
   * This is the number that decides whether a DHT query can do anything: `allowQueryWithZeroPeers`
   * is `false`, so a query against an empty table is refused outright instead of walking. The
   * connection count is not a substitute - a connection to a peer that does not speak the DHT
   * protocol, or one that has not completed identify yet, is not a peer a query can start from.
   */
  getDhtRoutingTableSize(): number | undefined {
    try {
      const dht = (this._libp2p.services as Record<string, any> | undefined)?.dht as
        { routingTable?: { size?: number } } | undefined
      const size = dht?.routingTable?.size
      return typeof size === 'number' ? size : undefined
    } catch (e) {
      return undefined
    }
  }

  /**
   * Whether this node's P2P interface is usable, not merely enabled.
   *
   * Gated on routing-table size rather than on connection count, and reported alongside the
   * threshold and the raw numbers so a caller can tell a node that is still starting up from
   * one that is isolated. An unreachable DHT service reports `ready: false` with no size, which
   * is the honest answer: not knowing is not the same as knowing the table is empty.
   */
  getP2PStatus(): OceanNodeP2PStatus {
    const requiredRoutingTablePeers = P2P_TIMEOUTS.dhtReadyMinPeers
    const routingTablePeers = this.getDhtRoutingTableSize()
    const dhtService = (this._libp2p?.services as Record<string, any> | undefined)
      ?.dht as { getMode?: () => string } | undefined
    return {
      ready:
        routingTablePeers !== undefined && routingTablePeers >= requiredRoutingTablePeers,
      routingTablePeers,
      requiredRoutingTablePeers,
      connections: this._libp2p ? this._libp2p.getConnections().length : 0,
      dhtMode: dhtService?.getMode ? dhtService.getMode() : undefined
    }
  }

  async getRunningOceanPeers() {
    return await this.getOceanPeers(true, false)
  }

  async getKnownOceanPeers() {
    return await this.getOceanPeers(false, true)
  }

  async getAllOceanPeers() {
    return await this.getOceanPeers(true, true)
  }

  async getOceanPeers(running: boolean = true, known: boolean = true) {
    const peers: string[] = []
    if (known) {
      // get p2p peers and filter them by protocol
      for (const peer of await this._libp2p.peerStore.all()) {
        if (peer && peer.protocols && peer.protocols.includes(this._protocol)) {
          if (!peers.includes(peer.id.toString())) peers.push(peer.id.toString())
        }
      }
    }

    return peers
  }

  async hasPeer(peer: any) {
    const s = await this._libp2p.peerStore.all()
    return Boolean(s.find((p: any) => p.id.toString() === peer.toString()))
  }

  async getPeerDetails(peerName: string) {
    try {
      const peerId = peerIdFromString(peerName)
      // Example: for ID 16Uiu2HAkuYfgjXoGcSSLSpRPD6XtUgV71t5RqmTmcqdbmrWY9MJo
      // Buffer.from(this._config.keys.publicKey).toString('hex') =>         0201cabbabef1cc85218fa2d5bbadfb3425dfc091b311a33e6d9be26f6dcb94668
      // Buffer.from(peerId.publicKey).toString('hex')            => 080212210201cabbabef1cc85218fa2d5bbadfb3425dfc091b311a33e6d9be26f6dcb94668
      // 08021221 = > extra 4 bytes at the beginning, but they are important for later
      // UPDATE: no need to slice 4 bytes here, actually we need those on client side to verify the node id and perform the encryption of the keys + iv
      // See config.ts => getPeerIdFromPrivateKey()

      const pubKey = Buffer.from(peerId.publicKey.raw).toString('hex') // no need to do .subarray(4).toString('hex')
      const peer = await this._libp2p.peerStore.get(peerId)

      // Note: this is a 'compressed' version of the publicKey, we need to decompress it on client side (not working with bellow attempts)
      // otherwise the encryption will fail due to public key size mismatch

      // taken from '@libp2p/crypto/keys/secp256k1' decompressPublicKey (cannot import module/function)
      // const decompressedKey = secp.ProjectivePoint.fromHex(key.public.bytes).toRawBytes(false)
      // Buffer.from(decompressedKey).toString('hex')
      // in any case is not working (it crashes here)

      return {
        ...peer,
        publicKey: pubKey
      }
    } catch (e) {
      return null
    }
  }

  /**
   * Puts a peer's addresses into one consistent, dialable set.
   *
   * The problem this solves is a libp2p constraint: when a list of multiaddrs is dialled, either
   * all of them carry a `/p2p/<peer-id>` component or none of them do - a mixed list is
   * rejected outright with `InvalidParametersError`. A NAT'd peer's address list is mixed by
   * construction, because a relay address is written as
   * `/ip4/.../p2p/<relay-id>/p2p-circuit/p2p/<target-id>` and therefore always carries a
   * `/p2p/`, while a plain direct address usually does not.
   *
   * The previous resolution of that mismatch was to split the list into a with-peer-id set and
   * a without-peer-id set, **keep whichever set was larger and discard the other**, ties going
   * to the without-peer-id set. That is a count comparison standing in for a reachability
   * decision, and for the peers relay exists to serve it decides wrongly. A NAT'd peer holding
   * one relay address and two stale direct addresses keeps the two addresses that cannot work
   * and throws away the only path that can. A peer holding one relay address and one direct
   * address loses its relay to the tie-break. In both cases the peer is simply unreachable, and
   * nothing reports why - the dial just fails against addresses nobody can connect to.
   *
   * Relay-capable and direct addresses are not substitutes and must never be traded off by
   * count: one is how a reachable peer is reached quickly, the other is how an unreachable peer
   * is reached at all. So **both are kept**. The mixed-list constraint is satisfied the other
   * way round - by attaching the target peer id to every address that lacks it, which is
   * exactly what this function already did for `/p2p-circuit` addresses - and the result is one
   * uniform set that libp2p accepts whole.
   *
   * Order carries the preference the count comparison was groping for: direct addresses first,
   * relayed ones last, input order preserved inside each group. A direct dial that succeeds
   * yields a full connection, while a relayed one is limited and metered by a third party, so
   * relay is the fallback rather than the equal. This is also the order libp2p's own
   * `defaultAddressSorter` produces (`circuitRelayAddressesLast`), so a caller that hands the
   * peer id to the dial queue instead of this list gets the same sequence rather than a
   * different one.
   *
   * An address whose terminal `/p2p/` component names some *other* peer, and which is not a
   * circuit address, is dropped: it does not describe a path to this peer, and appending the
   * target id to it would fabricate a meaningless two-hop address rather than fix anything.
   */
  normalizeMultiaddrs(peerName: string, multiaddrs: Multiaddr[]): Multiaddr[] {
    const direct: Multiaddr[] = []
    const relayed: Multiaddr[] = []
    // The same address routinely arrives from more than one tier - the peer store and the DHT
    // usually agree - so dedup on the final, peer-id-bearing string form rather than the input.
    const seen = new Set<string>()

    for (const address of multiaddrs) {
      let components
      try {
        components = address.getComponents()
      } catch (e) {
        continue
      }
      const isRelayed = components.some((component) => component.name === 'p2p-circuit')
      const terminal = components[components.length - 1]
      const terminalPeerId =
        terminal !== undefined && terminal.name === 'p2p' ? terminal.value : undefined

      let dialable: Multiaddr
      if (terminalPeerId === peerName) {
        dialable = address
      } else if (terminalPeerId !== undefined && !isRelayed) {
        // Not a path to this peer at all.
        P2P_LOGGER.debug(
          `Ignoring address ${address.toString()} while resolving ${peerName}: it terminates at a different peer`
        )
        continue
      } else {
        try {
          dialable = multiaddr(`${address.toString()}/p2p/${peerName}`)
        } catch (e) {
          continue
        }
      }

      const key = dialable.toString()
      if (seen.has(key)) {
        continue
      }
      seen.add(key)
      if (isRelayed) {
        relayed.push(dialable)
      } else {
        direct.push(dialable)
      }
    }

    return [...direct, ...relayed]
  }

  /**
   * Read-only address resolution for a peer, cheapest source first, reporting which source
   * answered.
   *
   * The tiers, in order, and why that order:
   *
   *   1. **An open connection.** Free - it is an in-memory lookup of connections this process
   *      already holds - and it is the most current information available, because the address
   *      is one a dial actually succeeded against rather than one somebody advertised.
   *   2. **The peer store.** A local read, and now a durable one: addresses live there for the
   *      lifetime of a DHT provider record rather than for an hour.
   *   3. **The DHT.** A multi-hop network walk, tens of seconds in the bad case. Only reached
   *      when both local tiers came up empty.
   *
   * There is deliberately no peer-exchange tier. This node runs no peer-exchange protocol, so a
   * tier for it would be a branch that never fires.
   *
   * Provenance is returned, not just addresses, because every caller wants it for a different
   * reason: `sendTo` needs to know whether the addresses it is about to dial came from a cache
   * it must invalidate on failure, and the logs need to distinguish "answered locally" from
   * "cost a DHT walk". The resolution *lanes* are counted through the existing counters, which
   * split answers into local and DHT precisely so the peer store's address lifetime can be
   * measured; the two local tiers therefore share the local lane, since what that lane measures
   * is answers that did not cost a network walk. A cache hit is counted in no lane at all - no
   * lookup ran, so it is neither a hit nor a miss of any tier, the same treatment an unparsable
   * peer id already gets.
   *
   * @param options.usePeerStore also governs whether *local* answers are acceptable at all.
   *   `false` means the caller is refreshing after a failure and wants network truth, so the
   *   cache, the connection tier and the peer store are all skipped, and the DHT walk is told
   *   not to answer from its own local view either.
   * @param options.signal optional caller deadline; combined with each tier's own budget.
   */
  async resolvePeer(
    peerName: string,
    options: {
      usePeerStore?: boolean
      useDht?: boolean
      useCache?: boolean
      signal?: AbortSignal
    } = {}
  ): Promise<PeerResolution> {
    const usePeerStore = options.usePeerStore ?? true
    const useDht = options.useDht ?? true
    const useCache = (options.useCache ?? true) && usePeerStore
    const { signal } = options

    let peerId
    try {
      peerId = peerIdFromString(peerName)
    } catch (e) {
      // Deliberately uncounted: no lookup ran, so this is neither a hit nor a miss of either
      // lane. `sendTo` records the same condition as a failure with its own reason.
      return { addresses: [], source: 'none' }
    }

    if (useCache) {
      const cached = getCachedPeerResolution(peerName)
      if (cached !== undefined && cached.length > 0) {
        return { addresses: cached, source: 'cache' }
      }
      if (isPeerResolutionNegativelyCached(peerName)) {
        return { addresses: [], source: 'negative-cache' }
      }
    }

    // peerStore and DHT routinely return the same address - dedup happens in
    // normalizeMultiaddrs, on the final dialable form.
    const collected: Multiaddr[] = []

    if (usePeerStore) {
      // An address a connection is currently using needs no lookup and cannot be stale.
      try {
        for (const connection of this._libp2p.getConnections(peerId)) {
          if (connection.status === 'open') {
            collected.push(multiaddr(connection.remoteAddr.toString()))
          }
        }
      } catch (e) {
        // an unavailable connection list is not a resolution failure; fall through
      }
      const fromConnections = this.normalizeMultiaddrs(peerName, collected)
      if (fromConnections.length > 0) {
        countP2PEvent(RESOLVE_PEERSTORE_HIT)
        cachePeerResolution(peerName, fromConnections)
        return { addresses: fromConnections, source: 'connection' }
      }

      try {
        const peerData = await this._libp2p.peerStore.get(peerId, {
          signal: stageSignal(P2P_TIMEOUTS.peerStoreGetMs, signal)
        })
        if (peerData) {
          for (const x of peerData.addresses) {
            // v3: Convert to local Multiaddr type to avoid type mismatch
            collected.push(multiaddr(x.multiaddr.toString()))
          }
        }

        // No verification dial here: resolution is read-only. Dialing inherited the
        // 30s connectionsDialTimeout with no signal, and it was fed the un-normalized
        // address list, which throws InvalidParametersError for any peer holding both
        // a relay address (carrying the relay's /p2p/) and a direct one - exactly the
        // NAT'd peers relay exists to serve. Address validity is the dialer's job.
        const fromPeerStore = this.normalizeMultiaddrs(peerName, collected)
        if (fromPeerStore.length > 0) {
          countP2PEvent(RESOLVE_PEERSTORE_HIT)
          cachePeerResolution(peerName, fromPeerStore)
          return { addresses: fromPeerStore, source: 'peerstore' }
        }
      } catch (e) {
        // console.log(e)
      }
    }

    if (useDht) {
      try {
        // a multi-hop Kademlia walk needs 10-30s; the old 3s aborted almost every
        // lookup before it could complete.
        //
        // `useCache` lets kad-dht answer from its routing table and peer store before it walks
        // anywhere. That is worth taking now that the peer store holds addresses for 48 hours -
        // the routing table is a source the tiers above do not consult, and the local read
        // costs a map lookup against a walk costing tens of seconds. It is turned *off* for a
        // refresh (`usePeerStore: false`), where the caller has just been let down by local
        // data and asking for it again would return the same stale answer.
        const peerData = await this._libp2p.peerRouting.findPeer(peerId, {
          signal: stageSignal(P2P_TIMEOUTS.findPeerMs, signal),
          useCache: usePeerStore
        })
        if (peerData) {
          for (const index in peerData.multiaddrs) {
            // v3: Convert to local Multiaddr type to avoid type mismatch
            collected.push(multiaddr(peerData.multiaddrs[index].toString()))
          }
        }
      } catch (e) {
        // console.log(e)
      }
    }

    const resolved = this.normalizeMultiaddrs(peerName, collected)
    // Reached only when every local tier produced nothing - they return above on a hit - so
    // whatever is here came from the DHT, or from nowhere. A `sendTo` that dials a cached
    // address, fails and re-resolves DHT-only counts a second outcome here; that is the point,
    // each lookup that ran is one observation.
    if (resolved.length > 0) {
      countP2PEvent(RESOLVE_DHT_HIT)
      cachePeerResolution(peerName, resolved)
      return { addresses: resolved, source: 'dht' }
    }
    countP2PEvent(RESOLVE_MISS)
    cachePeerResolutionMiss(peerName)
    return { addresses: [], source: 'none' }
  }

  /**
   * Addresses only, for callers that do not care which tier answered.
   *
   * Kept with its original positional signature because it is the shape the rest of the repo
   * and its tests already call. `searchPeerStore: false` is how the one caller that needs
   * network truth after a failed dial asks for it - see `resolvePeer`, which treats it as
   * "skip every local source", not merely "skip the peer store".
   *
   * @param signal optional caller deadline; combined with each step's own budget.
   */
  async getPeerMultiaddrs(
    peerName: string,
    searchPeerStore: boolean = true,
    searchDHT: boolean = true,
    signal?: AbortSignal
  ): Promise<Multiaddr[]> {
    const { addresses } = await this.resolvePeer(peerName, {
      usePeerStore: searchPeerStore,
      useDht: searchDHT,
      signal
    })
    return addresses
  }

  async findPeerInDht(peerName: string, timeout?: number) {
    try {
      const peer = peerIdFromString(peerName)
      const data = await this._libp2p.peerRouting.findPeer(peer, {
        // default raised from 5s to FINDPEER_TIMEOUT_MS - a caller-supplied timeout
        // still wins, but the default has to fit a real multi-hop walk.
        signal:
          isNaN(timeout) || timeout === 0
            ? AbortSignal.timeout(P2P_TIMEOUTS.findPeerMs)
            : AbortSignal.timeout(timeout),
        // Answer from the routing table or the peer store when either has this peer, rather
        // than always walking the network. Worth taking now that peer-store addresses live as
        // long as the provider records that point at them; with the previous one-hour lifetime
        // the local check was usually a wasted lookup before the walk it could not avoid.
        useCache: true,
        useNetwork: true
      })
      return data
    } catch (e) {}
    return null
  }

  /**
   * Writes one command to an already-open stream and returns the peer's status frame plus its
   * response body as an async iterable of raw frames.
   *
   * @param stream the freshly opened command stream. `send` takes ownership: it wraps it in an
   *   `lpStream` *and* an `LpFrameReader` in the same tick - the reader counts `message`
   *   events, so it has to be attached before any byte can be dispatched - and it is the one
   *   that closes or aborts the stream when the response body ends. Callers must not
   *   wrap the stream themselves; that is why this takes a `Stream` and not a
   *   `LengthPrefixedStream`.
   * @param options the per-attempt stream-stage budget (`SENDTO_STREAM_MS`, already combined
   *   with `sendTo`'s overall deadline). Covers the command write, the optional request body
   *   and the status frame.
   * @param overallSignal the *caller's* overall deadline, if any. Kept separate from `options`
   *   because it must bound the response-body reads too, which have their own per-frame budget
   *   and must not inherit the much shorter stream-stage one, or a long download would be
   *   capped at SENDTO_STREAM_MS. Without this, an aborted caller leaves the response
   *   stream running with nobody consuming it. Note this is deliberately *not* `sendTo`'s
   *   `SENDTO_TOTAL_MS` deadline - see the comment there. It is optional and most call sites
   *   pass nothing, which is why the body also carries an unconditional ceiling of its own
   *   (`STREAM_BODY_TIMEOUT_MS`).
   */
  async send(
    stream: Stream,
    message: string,
    options: { signal: AbortSignal },
    requestBody?: P2PRequestBodyStream,
    overallSignal?: AbortSignal
  ): Promise<P2PSendResponse> {
    const lp = lpFramedStream(stream)
    // Same tick as `lpStream`, so the reader's byte accounting cannot miss a message: nothing
    // can be dispatched between the two `message` listeners attaching.
    const frames = new LpFrameReader(lp, stream)
    let outbound = message
    if (requestBody) {
      const cmd = JSON.parse(message) as Record<string, unknown>
      cmd.p2pStreamBody = true
      outbound = JSON.stringify(cmd)
    }
    await lp.write(uint8ArrayFromString(outbound), { signal: options.signal })
    if (requestBody) {
      await writeP2pRequestBodyLp(lp, requestBody, options.signal)
    }
    const statusBytes = await frames.read({ signal: options.signal })
    // The caller gets the status back before anything iterates the body, and it may not start
    // iterating in this tick, so hold the transport until the iterator asks for a frame -
    // otherwise the peer fills the read buffer in the gap and the overflow drops it.
    pauseReads(stream)
    const idleMs = P2P_TIMEOUTS.streamIdleMs
    const bodyMs = P2P_TIMEOUTS.streamBodyMs
    return {
      status: JSON.parse(uint8ArrayToString(statusBytes)),
      stream: {
        [Symbol.asyncIterator]: async function* () {
          // one AbortController and one *cancellable* timer for the whole iterator,
          // rearmed per frame. The previous `AbortSignal.timeout(60_000)` per frame retained a
          // signal plus an uncancellable timer for every frame ever read - ~500B each, so a
          // stream at ~1600 frames/s held ~96 000 live signals (~50MB) on a rolling 60s
          // window, per concurrent download. Rearming also makes this a genuine *idle* timeout,
          // which is what the idle budget means: it applies to waiting
          // for the next frame, not to the frame's absolute arrival deadline, and it is not
          // ticking while a slow consumer processes what it was already given.
          const idle = new AbortController()
          let timer: ReturnType<typeof setTimeout> | undefined
          // The per-frame budget above rearms on every frame, so on its own it bounds a
          // *stall* and not a transfer: a peer that keeps sending frames, however slowly and
          // however long for, is never cut off. Measured with a 400ms idle budget, a peer
          // emitting one frame every 250ms was still streaming at 6036ms with no end in sight.
          // Three of the five call sites pass no signal of their own, two of them on the
          // indexer path, so for those there was no upper bound at all. This is that bound:
          // one budget for the whole body, armed when the consumer starts iterating rather
          // than when the status frame arrived, so a caller that pulls late is not charged for
          // the delay. It shares `idle`'s controller, so the abort path and the teardown are
          // the ones already tested; only the error text distinguishes the two.
          const bodyError = new Error(
            `P2P response body exceeded its overall budget of ${bodyMs}ms`
          )
          bodyError.name = 'TimeoutError'
          const bodyTimer = setTimeout(() => {
            clearTimeout(timer)
            idle.abort(bodyError)
          }, bodyMs)
          const forwardOverallAbort = () => {
            clearTimeout(timer)
            idle.abort(overallSignal?.reason)
          }
          if (overallSignal?.aborted === true) {
            idle.abort(overallSignal.reason)
          } else {
            overallSignal?.addEventListener('abort', forwardOverallAbort, { once: true })
          }
          let endedCleanly = false
          let failure: Error | undefined
          try {
            while (true) {
              let chunk: Uint8Array
              const idleError = new Error(`No response frame received for ${idleMs}ms`)
              idleError.name = 'TimeoutError'
              timer = setTimeout(() => idle.abort(idleError), idleMs)
              // Flow control. Reads are held while the consumer works on a frame, and are only
              // let go again once the backlog we are already holding has drained below the
              // mark - see `LP_RESUME_BELOW_BYTES`. Without this the peer fills the read buffer
              // at its own pace and `byteStream` silently drops the entire backlog past
              // `maxBufferSize`, which desynchronises the frame parser: the consumer is handed
              // corrupt, out-of-sequence frames for a while before the end-of-stream
              // accounting throws.
              if (frames.pendingBytes <= LP_RESUME_BELOW_BYTES) {
                resumeReads(stream)
              }
              try {
                chunk = await frames.read({ signal: idle.signal })
              } catch (err) {
                // only a clean end-of-stream terminates the iterator, and "clean" is
                // decided by transport byte accounting, not by the error message - see
                // LpFrameReader. A truncated body must reach the consumer as an error rather
                // than as a short body with httpStatus 200.
                if (frames.isCleanEnd(err)) {
                  endedCleanly = true
                  return
                }
                failure = err as Error
                throw err
              } finally {
                clearTimeout(timer)
              }
              pauseReads(stream)
              yield chunk
            }
          } finally {
            clearTimeout(timer)
            clearTimeout(bodyTimer)
            // Never leave the read side paused: the teardown below closes or aborts the
            // stream, and a paused stream would keep buffering until the muxer reset it.
            resumeReads(stream)
            overallSignal?.removeEventListener('abort', forwardOverallAbort)
            // aborting the *reads* does not close the stream object - our write side
            // stayed open on every path, including the clean one, which used a bare `return`.
            // On a clean end the remote has already closed its write side, so closing ours
            // completes the teardown; on a failure, and when the consumer abandons the iterator
            // early (a `break` runs this `finally` via the generator's `return()`), `abort` is
            // the right call: `close()` only closes the write side and would leave the peer
            // sending into a read buffer nobody drains until the muxer resets the stream.
            if (endedCleanly) {
              void stream.close().catch(() => {})
            } else {
              try {
                stream.abort(
                  failure ?? new Error('P2P response stream abandoned by the consumer')
                )
              } catch {}
            }
          }
        }
      }
    }
  }

  /**
   * Sends a command to a peer and returns its status frame plus the raw response body.
   *
   * each stage gets its own budget (`SENDTO_RESOLVE_MS` / `_DIAL_MS` / `_STREAM_MS`)
   * and a *fresh* signal on every attempt. Before this, a single already-ticking 10s signal
   * covered resolution, dial, stream open, protocol negotiation, the command write and the
   * status read - and was then reused for the retry, so a first attempt that burned 9s left
   * the retry 1s.
   *
   * per-stage budgets with no overall one are worse than the bug they fixed. Three of
   * the four in-repo call sites pass no `signal`, and `stageSignal` only ANDs a caller signal in
   * when it gets one, so the worst case became 10s -> ~105s (resolve 20 + dial 15 + DHT
   * re-resolve 20 + dial 15 + stream 10 + attempt-2 dial 15 + stream 10) - and ~210s for
   * `BaseProcessor.decryptDDO`, which makes two sequential calls per DDO in the indexer path.
   * So this method now always creates its own deadline (`SENDTO_TOTAL_MS`, 45s = one complete
   * legitimate slow path) and composes it into *every* stage, caller signal or not.
   *
   * Two details of that wiring are deliberate:
   *
   *   - the deadline is a local `AbortController`, not `AbortSignal.any([signal, timeout])`
   *     built on the caller's signal. every `AbortSignal.any` composite
   *     registers in its sources' dependant-signal sets and is only released when the *source*
   *     is collected, so composing per-stage signals off a long-lived caller signal grows that
   *     set without bound. The caller's signal gets exactly one listener, removed in `finally`;
   *   - the deadline bounds the *setup* phase - resolve, dial, stream open, command write,
   *     request body, status frame - and stops when this method returns. Capping the body at
   *     `SENDTO_TOTAL_MS` would break exactly the transfers this protocol exists for: a
   *     multi-gigabyte download or a compute result legitimately streams for far longer than
   *     any setup may take. The body gets its own, much larger ceiling instead
   *     (`STREAM_BODY_TIMEOUT_MS`) on top of the per-frame idle budget and the caller's own
   *     signal, all three applied inside the iterator `send` returns.
   *
   * **Dialling is by peer id, not by address list.** libp2p's dial queue already does what this
   * method used to do by hand, and does more of it: given a peer id it loads that peer's
   * addresses from the peer store, falls back to `peerRouting.findPeer` when it has none,
   * expands `dnsaddr` entries, applies the connection gater, and sorts what is left with
   * `defaultAddressSorter` - public before private, circuit-relay last, reliable transports
   * first - before dialling in that order. Handing it an explicit list *replaces* all of that:
   * the peer store and peer routing are not consulted at all, so an address the caller happens
   * not to have is an address that will not be tried.
   *
   * So the resolution done here exists for the things the dial queue cannot do - counting which
   * tier answered, caching the answer, and failing fast with a 404 when a peer has no address
   * anywhere rather than spending a dial budget discovering that - and its result is handed to
   * the dial queue *through the peer store* rather than as a list. Addresses the dial queue
   * could not have found on its own (a DHT walk's result, or a cached one) are merged into the
   * peer store first; addresses that came from the peer store or from an open connection are
   * already there and are not re-written.
   *
   * The one case that still dials an explicit list is `multiAddrs`, supplied by the
   * `/directCommand` caller. Those are used verbatim for this dial and are deliberately *not*
   * merged into the peer store: they arrive from outside this node, and merging them would let
   * a caller install addresses for an arbitrary peer id that outlive the request by the peer
   * store's 48-hour address lifetime, for every other code path to dial. A caller that pins
   * addresses gets exactly what it asked for and nothing persists.
   *
   * Concurrency across calls is capped - see `sendToLimiter.ts`. The cap is applied *outside*
   * the deadline below, so a send that waits for a slot is not charged for the wait.
   *
   * @param signal optional overall caller deadline, e.g. FindDDO's own budget. It bounds
   *   every stage *in addition to* that stage's own
   *   budget and this method's own deadline, so an abort actually stops the dial / stream open /
   *   write instead of leaving an orphaned libp2p stream running behind a `Promise.race`, and
   *   it keeps bounding the response body after this method has returned.
   */
  async sendTo(
    peerName: string,
    message: string,
    multiAddrs?: string[],
    requestBody?: P2PRequestBodyStream,
    signal?: AbortSignal
  ): Promise<{ status: any; stream?: AsyncIterable<any> }> {
    // The concurrency guard wraps the whole exchange, and the setup deadline is created inside
    // it. That ordering is the point: a send that queues here has not started its clock, so a
    // deep queue costs latency and never converts into a timeout.
    return await sendToLimit(async () => {
      // the overall setup deadline. Local controller, one listener on the caller's
      // signal, both torn down in the `finally` at the bottom of this method.
      const totalMs = P2P_TIMEOUTS.sendToTotalMs
      const setup = new AbortController()
      const forwardCallerAbort = () => setup.abort(signal?.reason)
      if (signal?.aborted === true) {
        setup.abort(signal.reason)
      } else {
        signal?.addEventListener('abort', forwardCallerAbort, { once: true })
      }
      const totalError = new Error(
        `sendTo ${peerName} exceeded its overall budget of ${totalMs}ms`
      )
      totalError.name = 'TimeoutError'
      const totalTimer = setTimeout(() => setup.abort(totalError), totalMs)
      const deadline = setup.signal

      try {
        const dialOptions = () => ({
          signal: stageSignal(P2P_TIMEOUTS.sendToDialMs, deadline),
          priority: 100,
          runOnLimitedConnection: true
        })
        const streamOptions = () => ({
          signal: stageSignal(P2P_TIMEOUTS.sendToStreamMs, deadline),
          priority: 100,
          runOnLimitedConnection: true
        })

        let peerId

        P2P_LOGGER.logMessage('SendTo() node ' + peerName + ' task: ' + message, true)

        try {
          peerId = peerIdFromString(peerName)
        } catch (e) {
          P2P_LOGGER.logMessageWithEmoji(
            'Invalid peer (for id): ' + peerName,
            true,
            GENERIC_EMOJIS.EMOJI_CROSS_MARK,
            LOG_LEVELS_STR.LEVEL_ERROR
          )
          countSendToFailure(SENDTO_FAIL_REASONS.invalidPeer)
          return { status: { httpStatus: 404, error: 'Invalid peer' } }
        }

        // addresses pinned by the caller are used verbatim and never re-resolved
        const callerPinnedAddrs = Boolean(multiAddrs?.length)

        /**
         * Publishes addresses to the peer store so the dial queue can find them, sort them and
         * dial them in its own order. Failure is not fatal: the dial that follows still has
         * whatever the peer store already held.
         */
        const publishAddresses = async (addresses: Multiaddr[]): Promise<void> => {
          try {
            await this._libp2p.peerStore.merge(peerId, {
              multiaddrs: addresses as any[]
            })
          } catch (e) {
            P2P_LOGGER.debug(
              `Could not store resolved addresses: ${describeP2PError(e, {
                peerId: peerId.toString(),
                addresses: addresses.length
              })}`
            )
          }
        }

        let pinnedAddrs: Multiaddr[] = []
        let known: Multiaddr[] = []
        if (callerPinnedAddrs) {
          pinnedAddrs = this.normalizeMultiaddrs(
            peerName,
            multiAddrs.map((addr) => multiaddr(addr))
          )
          known = pinnedAddrs
          if (pinnedAddrs.length < 1) {
            const error = `Cannot find any address to dial for peer: ${peerId}`
            P2P_LOGGER.error(error)
            countSendToFailure(SENDTO_FAIL_REASONS.noAddress)
            return { status: { httpStatus: 404, error } }
          }
        } else {
          const resolution = await this.resolvePeer(peerName, {
            signal: stageSignal(P2P_TIMEOUTS.sendToResolveMs, deadline)
          })
          if (resolution.addresses.length < 1) {
            const error = `Cannot find any address to dial for peer: ${peerId}`
            P2P_LOGGER.error(error)
            countSendToFailure(SENDTO_FAIL_REASONS.noAddress)
            return { status: { httpStatus: 404, error } }
          }
          known = resolution.addresses
          // Only the sources the dial queue cannot reach on its own are written back. A
          // peer-store or open-connection answer is already visible to it.
          if (resolution.source === 'dht' || resolution.source === 'cache') {
            await publishAddresses(resolution.addresses)
          }
        }

        /**
         * One network-truth refresh per `sendTo`, armed by a failed dial.
         *
         * A dial by peer id already consults `peerRouting` - but only when the peer store had
         * *no* addresses for the peer. The case this covers is the opposite and the more
         * common one at a 48-hour address lifetime: the peer store has addresses, they are
         * stale, so the dial queue never looks further and the dial simply fails. Asking the
         * DHT directly, with local sources switched off so the answer cannot be the stale data
         * again, is the only way to learn the peer's current address.
         *
         * @returns whether a *different* set of addresses was found and published. The
         *   same-addresses case returns `false` so a caller does not spend a second dial
         *   re-trying what just failed.
         */
        let refreshUsed = callerPinnedAddrs
        const refreshFromNetwork = async (): Promise<boolean> => {
          if (refreshUsed) return false
          refreshUsed = true
          const fresh = await this.resolvePeer(peerName, {
            usePeerStore: false,
            useDht: true,
            signal: stageSignal(P2P_TIMEOUTS.sendToResolveMs, deadline)
          })
          if (fresh.addresses.length < 1) {
            P2P_LOGGER.debug(`DHT-only re-resolution found no address for ${peerId}`)
            return false
          }
          const asKey = (list: Multiaddr[]) =>
            list
              .map((ma) => ma.toString())
              .sort()
              .join(',')
          if (asKey(fresh.addresses) === asKey(known)) {
            P2P_LOGGER.debug(
              `DHT-only re-resolution returned the same addresses for ${peerId}, not redialling`
            )
            return false
          }
          known = fresh.addresses
          await publishAddresses(fresh.addresses)
          return true
        }

        /**
         * Dials the peer. By peer id on every path except a caller-pinned address list, so the
         * dial queue supplies address discovery, `dnsaddr` expansion and its own ordering.
         *
         * The peer-id check is kept even though libp2p raises `UnexpectedPeerError` itself:
         * it is the only check that covers the pinned-address path, where the caller chose the
         * address and the peer at the other end of it is not this node's decision.
         */
        const dial = async (): Promise<Connection> => {
          const connection = callerPinnedAddrs
            ? await this._libp2p.dial(pinnedAddrs, dialOptions())
            : await this._libp2p.dial(peerId, dialOptions())
          if (connection.remotePeer.toString() !== peerId.toString()) {
            throw new P2PError(
              P2P_ERROR.peerMismatch,
              `Invalid peer on the other side: ${connection.remotePeer.toString()}`
            )
          }
          return connection
        }
        const openStream = async (
          conn: Connection
        ): Promise<{ stream: Stream; options: { signal: AbortSignal } }> => {
          const options = streamOptions()
          const stream = await conn.newStream(this._protocol, options)
          return { stream, options }
        }

        /**
         * The set of connections to this peer that already existed. Taken immediately before a
         * dial, so that a dial which *creates* a connection can be told apart from one that
         * hands back an existing one - `libp2p.dial()` does the latter whenever it can.
         */
        const existingConnectionIds = (): Set<string> =>
          new Set(this._libp2p.getConnections(peerId).map((conn) => conn.id))

        /**
         * A dial that succeeded and then failed to produce a stream left the connection open
         * with nothing using it. Unlike ocean.js, `abort` is the wrong call here: `libp2p.dial()`
         * returns an *existing* connection when there is one, so this connection may be carrying
         * identify / ping / DHT / another `sendTo` stream, and aborting resets all of them.
         *
         * Ownership is what decides, and it has to be established *before* the dial. Asking
         * afterwards whether anyone else is using the connection cannot work: `Connection.streams`
         * is the muxer's stream list, and the muxer splices a stream out as soon as it closes, so
         * an empty list is the normal state of a healthy idle connection that identify, ping and
         * the DHT all use - not evidence that nobody wants it. Closing on `streams.length === 0`
         * therefore tore down shared connections on exactly the paths where `newStream` fails
         * without the dial failing: a peer that does not register the command protocol (every
         * bootstrap does not - see the advertise guard), a limited/relayed connection, and
         * `maxInboundStreams` exhaustion.
         *
         * So: close only a connection that was not there before we dialled. A reused one is left
         * alone; the connection manager owns its lifetime, as it did before this method ran.
         */
        const releaseUnusedConnection = async (
          conn: Connection,
          preDialConnectionIds: Set<string>
        ): Promise<void> => {
          try {
            if (!preDialConnectionIds.has(conn.id)) {
              await conn.close()
            }
          } catch {}
        }

        const maxAttempts = P2P_TIMEOUTS.sendToMaxAttempts

        /**
         * Whether a failure in the **dial** stage is worth another attempt.
         *
         * Every dial-stage failure invalidates the cached resolution first, whatever its
         * category: the cache is the one source that can hand back an address nothing has
         * checked recently, and a failed dial is the only signal it will ever get that an entry
         * is wrong. Leaving a bad entry in place would make the cache the reason the peer stays
         * unreachable for the rest of the entry's lifetime, which is strictly worse than not
         * caching at all.
         *
         * Then, at most once per send, the DHT is asked for the peer's current address. If that
         * produces something different, the next attempt is dialling *different* addresses and
         * is worth making regardless of category - including for `peer_mismatch`, where a stale
         * address pointing at whoever now owns that host is the likely cause and a fresh
         * address is the only thing that can fix it.
         *
         * With no fresher address, the category decides, and only `dial_failed` and `timeout`
         * retry - a transient refusal or a congested dial queue plausibly differs a second time.
         * `peer_mismatch` cannot: the same address reaches the same wrong peer. `protocol_failed`
         * cannot either, and `resolve_failed` has already exhausted every tier.
         */
        const retryAfterDialFailure = async (
          err: P2PError,
          attempt: number
        ): Promise<boolean> => {
          if (!callerPinnedAddrs) {
            invalidatePeerResolution(peerName)
          }
          if (attempt >= maxAttempts || deadline.aborted) {
            return false
          }
          if (await refreshFromNetwork()) {
            return true
          }
          return isRetryableP2PError(err.name)
        }

        let lastFailure: P2PError

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
          // Jittered, and applied before the attempt rather than after the failure, so attempt
          // 1 waits for nothing. Every fan-out in this node retries on the same schedule, so a
          // fixed back-off would re-synchronise all of them into one burst against the peers
          // that just failed.
          await delayBeforeRetry(retryDelayMs(attempt), deadline)

          let connection: Connection
          // Snapshotted per attempt because a failed attempt may have closed a connection this
          // peer had.
          const preDialConnectionIds = existingConnectionIds()
          try {
            connection = await dial()
          } catch (e) {
            const failure = classifyP2PError(e, P2P_ERROR.dialFailed)
            lastFailure = failure
            if (await retryAfterDialFailure(failure, attempt)) {
              P2P_LOGGER.warn(
                `Dial of ${peerId} failed (${failure.name}: ${failure.message}), retrying`
              )
              continue
            }
            const error = `Cannot connect to peer ${peerId} (${failure.name}): ${failure.message}`
            P2P_LOGGER.error(error)
            countSendToFailure(SENDTO_FAIL_REASONS.dial)
            return { status: { httpStatus: 404, error } }
          }

          let stream: Stream
          let sendOptions: { signal: AbortSignal }
          try {
            ;({ stream, options: sendOptions } = await openStream(connection))
          } catch (e) {
            // The dial succeeded, so the addresses are good and nothing about them is
            // re-resolved. `protocol_failed` - the usual category here, covering a peer that
            // does not register the command protocol, an exhausted `maxInboundStreams` and a
            // limited connection refusing the stream - is not retryable for the same reason: a
            // second dial plus a second negotiation would return the same answer. A `timeout`
            // is retryable, because a negotiation that ran out of budget on a healthy
            // connection can differ.
            await releaseUnusedConnection(connection, preDialConnectionIds)
            const failure = classifyP2PError(e, P2P_ERROR.protocolFailed)
            lastFailure = failure
            if (
              attempt < maxAttempts &&
              !deadline.aborted &&
              isRetryableP2PError(failure.name)
            ) {
              P2P_LOGGER.warn(
                `Opening a command stream to ${peerId} failed (${failure.name}: ${failure.message}), retrying`
              )
              continue
            }
            const error = `Cannot open a command stream to peer ${peerId} (${failure.name}): ${failure.message}`
            P2P_LOGGER.error(error)
            countSendToFailure(SENDTO_FAIL_REASONS.streamOpen)
            return { status: { httpStatus: 404, error } }
          }

          try {
            const response = await this.send(
              stream,
              message,
              sendOptions,
              requestBody,
              signal
            )
            // All teardown of the response stream lives in the body iterator, so a caller that
            // never iterates leaks the stream: measured `streamStatus=open` long after the peer
            // had closed its side, holding a `message` listener, the frame reader's closure and
            // an outbound muxer slot each time, until `maxOutboundStreams` is exhausted. Every
            // in-repo caller does exactly that on a non-200 - it throws or returns without
            // touching `stream` - because a failed command has no body worth reading. So the
            // non-200 case is finished here instead of being handed over half-open, and the
            // stream is left out of the result so that nothing can iterate an aborted one.
            //
            // `abort`, not `close`: the read side is paused at this point (see `send`), so
            // closing our write side alone would leave the peer's bytes sitting in a buffer
            // nobody drains until the muxer resets the stream anyway. This just does it now,
            // deliberately, with an error the logs can attribute.
            if (response.status?.httpStatus !== 200) {
              try {
                stream.abort(
                  new Error(
                    `P2P command to ${peerId} answered ${response.status?.httpStatus}, response body not read`
                  )
                )
              } catch {}
              countSendToFailure(SENDTO_FAIL_REASONS.remoteStatus)
              return { status: response.status }
            }
            countP2PEvent(SENDTO_OK)
            return response
          } catch (err) {
            try {
              stream.abort(err as Error)
            } catch {}
            const failure = classifyP2PError(err, P2P_ERROR.protocolFailed)
            lastFailure = failure
            // A connection that died under us is reported by libp2p with a dedicated error
            // *name* - `ConnectionClosedError`, `StreamResetError`, `MuxerClosedError` and the
            // rest - all of which classify as `dial_failed`, because the fix for every one of
            // them is to drop the connection and dial again. This used to be decided by testing
            // whether the message contained "closed" or "reset", which both missed names whose
            // wording differs (`ConnectionFailedError` contains neither word) and matched any
            // unrelated failure whose text happened to mention one.
            //
            // never retry once a `requestBody` is in play. It is an AsyncIterable/Readable,
            // so a partially consumed one resumes where it stopped: the server would receive
            // valid framing with the leading chunks missing and store a silently corrupt upload.
            // An error the caller can see and retry from the start is the only safe outcome.
            const bodyConsumed = requestBody != null
            const retryable =
              isRetryableP2PError(failure.name) && !bodyConsumed && !deadline.aborted
            if (!retryable || attempt >= maxAttempts) {
              if (
                isRetryableP2PError(failure.name) &&
                bodyConsumed &&
                attempt < maxAttempts
              ) {
                P2P_LOGGER.error(
                  `Not retrying ${peerId} after a ${failure.name} error: the request body is a stream and has already been partially consumed`
                )
              }
              P2P_LOGGER.error(
                `P2P communication error${attempt > 1 ? ' on retry' : ''} (${failure.name}): ${failure.message}`
              )
              countSendToFailure(SENDTO_FAIL_REASONS.stream)
              return {
                status: { httpStatus: 500, error: `P2P error: ${failure.message}` }
              }
            }
            P2P_LOGGER.warn(
              `Retrying ${peerId} after a ${failure.name} error: ${failure.message}`
            )
            // Close only a connection this attempt dialled. `dial()` returns an existing
            // connection when there is one, which may be carrying identify / ping / DHT / another
            // sendTo stream - closing that on a retry would reset all of them.
            await releaseUnusedConnection(connection, preDialConnectionIds)
          }
        }

        // Reachable when every attempt failed with a retryable category and the last one was
        // the last allowed - the loop retries rather than returning in that case.
        const exhausted = `P2P error: exhausted ${maxAttempts} attempt(s) to ${peerName}${
          lastFailure ? ` (${lastFailure.name}: ${lastFailure.message})` : ''
        }`
        P2P_LOGGER.error(exhausted)
        countSendToFailure(SENDTO_FAIL_REASONS.attemptsExhausted)
        return { status: { httpStatus: 500, error: exhausted } }
      } finally {
        // The deadline covers the setup phase only, which ends here. Clearing the timer also
        // means the response-body iterator - which outlives this method - can never be aborted
        // by it; the caller's own signal, passed through to `send`, still bounds the body.
        clearTimeout(totalTimer)
        signal?.removeEventListener('abort', forwardCallerAbort)
      }
    })
  }

  // when the target is this node
  // async sendToSelf(message: string, sink: any): Promise<P2PCommandResponse> {
  //   const response: P2PCommandResponse = {
  //     status: { httpStatus: 200, error: '' },
  //     stream: null
  //   }
  //   // direct message to self
  //   // create a writable stream
  //   // const outputStream = new Stream.Writable()
  //   response.stream = new Stream.Writable()
  //   // read from input stream to output one and move on
  //   await handleDirectProtocolCommand.call(this, message, sink)

  //   return response
  // }

  async _flushAdvertiseQueue() {
    if (this._pendingAdvertise.length > 0) {
      P2P_LOGGER.debug(
        `Flushing advertise queue with ${this._pendingAdvertise.length} items`
      )
      const list = JSON.parse(JSON.stringify(this._pendingAdvertise))
      let advertised = 0
      for (const did of list) {
        this._pendingAdvertise = this._pendingAdvertise.filter((item) => item !== did)

        // One provide at a time, and through the shared limiter, so this flush competes for
        // the same ceiling as every other bulk provide instead of adding to it. The loop stays
        // sequential - it always was - so the limiter only ever holds one slot for it.
        // The rejection has to be caught here: this method is driven by a `setInterval`, where
        // an unhandled rejection would be fatal to the process.
        try {
          if (await provideLimit(() => this.advertiseString(did))) {
            advertised++
          }
        } catch (err) {
          P2P_LOGGER.error(`Failed to advertise queued ${did}: ${describeP2PError(err)}`)
        }
      }
      P2P_LOGGER.debug(`Flushed advertise queue: ${advertised}/${list.length} advertised`)
      // this._pendingAdvertise = []
    }
  }

  /**
   * Can this node usefully write a provider record right now?
   *
   * The previous guard was `(await this.getAllOceanPeers()).length > 0`, which can never
   * count a bootstrap - the command protocol is registered only `if (!isBootstrap)`, so a bootstrap never advertises `OCEAN_CMD_PROTOCOL`
   * and never appears in `getOceanPeers()`. A node whose only peers are the four bootstraps -
   * which is every node at startup - therefore advertised nothing and queued everything on
   * `_pendingAdvertise`.
   *
   * What `provide()` actually needs is DHT peers to write the record to, which has nothing to
   * do with the ocean command protocol. So: routing-table size first (the real precondition),
   * falling back to the connection count if the DHT service is not reachable for any reason.
   */
  private hasPeersToAdvertiseTo(): boolean {
    try {
      const dht = (this._libp2p.services as Record<string, any> | undefined)?.dht as
        { routingTable?: { size?: number } } | undefined
      const routingTableSize = dht?.routingTable?.size
      if (typeof routingTableSize === 'number' && routingTableSize > 0) {
        return true
      }
    } catch (e) {
      // fall through to the connection count
    }
    return this._libp2p.getConnections().length > 0
  }

  /**
   * Writes a DHT provider record for `did`.
   *
   * Reports the outcome to its caller, which it did not use to do: every error was caught and
   * logged here, so the per-item `try`/`catch` every caller wraps this in was dead code and
   * their completion logs reported `N/N` however many provides had actually failed. There is
   * no counter here that could report it instead, because the counting happens per batch, in
   * the caller.
   *
   * @returns `true` when a provider record was written; `false` when there was nowhere to write
   *   it yet, in which case the DID is queued for the next flush rather than lost. A caller
   *   counting successes should treat `false` as "not advertised yet", not as a failure.
   * @throws whatever `provide()` or the CID derivation threw. Callers must handle it: this is
   *   reached from a `setInterval` and from an indexer event listener, and an unhandled
   *   rejection is fatal to the process.
   */
  async advertiseString(did: string, signal?: AbortSignal): Promise<boolean> {
    const cid = await cidFromRawString(did)
    P2P_LOGGER.debug('Advertising  "' + did + `" as CID:` + cid)
    if (!this.hasPeersToAdvertiseTo()) {
      P2P_LOGGER.debug(
        'Could not find any Ocean peers. Nobody is listening at the moment, skipping...'
      )
      // save it for retry later
      // https://github.com/libp2p/js-libp2p-kad-dht/issues/98
      if (!this._pendingAdvertise.includes(did)) {
        this._pendingAdvertise.push(did)
      }
      return false
    }
    // the 2nd argument is RoutingOptions, never a list of addresses - kad-dht
    // already sends addressManager.getAddresses() with the provider record.
    // awaited on purpose. Fire-and-forget meant storeAndAdvertiseDDOS' per-item limit
    // only gated db.create + cacheDDO, so a 250-DDO batch still launched 250 concurrent
    // provides ~ 5000 PUTs at k=20.
    await this._libp2p.contentRouting.provide(cid, {
      signal: stageSignal(P2P_TIMEOUTS.advertiseMs, signal)
    })
    return true
  }

  getCommonPeers(
    rets: Array<Array<{ id: string; multiaddrs: any[] }>>
  ): Array<{ id: string; multiaddrs: any[] }> {
    return rets.reduce(
      (acc, curr) =>
        acc.filter((item) => curr.some((el) => el.id.toString() === item.id.toString())),
      rets[0] // Initialize with first subarray
    )
  }

  async getProvidersForStrings(
    input: string[],
    timeout?: number,
    signal?: AbortSignal
  ): Promise<Array<{ id: string; multiaddrs: any[] }>> {
    const rets = await Promise.all(
      input.map(async (x) => {
        const providers = await this.getProvidersForString(x, timeout, signal)
        return providers && providers.length > 0 ? providers : [] // Keep only valid results
      })
    )
    return this.getCommonPeers(rets)
  }

  async getProvidersForString(
    input: string,
    timeout?: number,
    signal?: AbortSignal
  ): Promise<Array<{ id: string; multiaddrs: any[] }>> {
    P2P_LOGGER.logMessage('Fetching providers for ' + input, true)
    const cid = await cidFromRawString(input)
    const peersFound = []
    // queryFuncTimeout no longer exists in kad-dht 16.x - without a signal the query
    // falls through to kad-dht's DEFAULT_QUERY_TIMEOUT of 180s. No `as any` here on
    // purpose, so the compiler catches the next removed option.
    const timeoutSignal = AbortSignal.timeout(timeout || P2P_TIMEOUTS.findProvidersMs)
    const querySignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal
    try {
      const f = this._libp2p.contentRouting.findProviders(cid, {
        signal: querySignal
      })

      for await (const value of f) {
        peersFound.push(value)
      }
    } catch (e) {
      P2P_LOGGER.error(`getProvidersForString(): ${describeP2PError(e)}`)
    }
    return peersFound.map((peer) => ({
      id: peer.id.toString(),
      multiaddrs: peer.multiaddrs
    }))
  }

  // cache a ddos object
  cacheDDO(ddo: any) {
    this._ddoDHT.dht.set(ddo.id, {
      id: ddo.id,
      lastUpdateTx: ddo.event ? ddo.event.tx : '', // some missing event? probably just bad test data
      lastUpdateTime: ddo.metadata.updated,
      provider: this.getPeerId()
    })
    this._ddoDHT.updated = new Date().getTime()
  }

  /**
   * Is the message intended for this peer or we need to connect to another one?
   * @param targetPeerID  the target node id
   * @returns true if the message is intended for this peer, false otherwise
   */
  isTargetPeerSelf(targetPeerID: string): boolean {
    return targetPeerID === this.getPeerId()
  }

  getPeerId(): string {
    return this.keyManager.getPeerIdString()
  }

  getDDOCache(): DDOCache {
    return this._ddoDHT
  }

  /**
   * Goes through some dddo list list and tries to store and avertise
   * @param list the initial list
   * @param node the node
   * @returns  boolean from counter
   */
  async storeAndAdvertiseDDOS(list: any[]): Promise<boolean> {
    if (!this.db) {
      P2P_LOGGER.logMessage(
        `storeAndAdvertiseDDOS() attempt aborted because there is no database!`,
        true
      )
      return false
    }
    try {
      let count = 0
      P2P_LOGGER.logMessage(
        `Trying to store and advertise ${list.length} initial DDOS`,
        true
      )
      const db = this.db.ddo
      // forEach(async ...) returned before any body completed, so `count` - and
      // therefore the return value - was meaningless. Bounded concurrency + a real
      // await instead.
      //
      // The bound is the shared provide limiter, not a `pLimit(5)` built here. This method's
      // own limiter was constructed *per invocation*, so it bounded one call and nothing
      // across calls: two overlapping publishes ran 10 provides at once, N ran 5N, and each
      // provide is a `getClosestPeers` walk plus a PUT to each of k=20 peers, so the DHT write
      // fan-out was ~100N outbound streams. The crons had the same problem in the other
      // direction - their own separate ceilings - so all four bulk-provide paths now queue on
      // one limiter and the ceiling is the ceiling.
      await Promise.all(
        list.map((ddo: any) =>
          provideLimit(async () => {
            // if already added before, create() will return null, but still advertise it
            try {
              await db.create(ddo)
              await this.advertiseString(ddo.id)
              // populate hash table
              this.cacheDDO(ddo)
              count++
            } catch (e) {
              P2P_LOGGER.log(
                LOG_LEVELS_STR.LEVEL_ERROR,
                `Caught "${describeP2PError(e)}" on storeAndAdvertiseDDOS()`,
                true
              )
            }
          })
        )
      )
      if (count > 0) {
        this._ddoDHT.updated = new Date().getTime()
      }
      return count === list.length
    } catch (err) {
      P2P_LOGGER.log(
        LOG_LEVELS_STR.LEVEL_ERROR,
        `Caught "${describeP2PError(err)}" on storeAndAdvertiseDDOS()`,
        true
      )
      return false
    }
  }

  async UPnpCron() {
    // we need to wait until we have some peers connected
    clearInterval(this._upnp_interval)
    const node = <any>this._libp2p
    if (node) {
      const connManager = node.components.connectionManager
      if (connManager) {
        const conns = await connManager.getConnections()
        if (conns.length > 1) {
          const upnpService = (node.services as any).upnpNAT
          if (this._config.p2pConfig.upnp && upnpService) {
            P2P_LOGGER.info('Trying to punch a hole using UPNP')
            try {
              await upnpService.mapIpAddresses()
            } catch (err) {
              P2P_LOGGER.info('Failed to configure UPNP Gateway(if you have one)')
              P2P_LOGGER.debug(err)
            }
            return
          }
        }
      }
    }
    this._upnp_interval = setInterval(this.UPnpCron.bind(this), 3000)
  }
}
