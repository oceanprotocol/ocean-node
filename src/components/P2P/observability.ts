import { X509Certificate } from 'node:crypto'
import type { Libp2p } from '@libp2p/interface'

/**
 * Read-only views of libp2p state that answer the questions asked when a peer cannot be
 * reached, and that nothing else surfaces.
 *
 * The existing stats reported what this node *advertises* and how many connections it has.
 * Neither tells you whether a dial is queued behind forty others, whether the connections
 * are inbound freeloaders or outbound work, whether the addresses being announced have been
 * confirmed by anybody, or whether the TLS certificate a browser needs is about to expire.
 *
 * **Everything here reaches into library internals and is guarded accordingly.** The public
 * surface of libp2p does not expose most of it — there is no accessor for the peer store's
 * configured lifetimes, none for a relay client's reservation count, none for the autoTLS
 * certificate. Each probe returns `undefined` rather than throwing when the shape it expects
 * is not there, so a library upgrade degrades this to "not reported" instead of breaking the
 * stats endpoint. A library upgrade should re-check these, and the tests pin the shapes so
 * that re-check is a test failure rather than an act of remembering.
 */

/** Transport a multiaddr would be dialled over, by the protocol names it carries. */
function transportOf(addr: string): string {
  if (addr.includes('/p2p-circuit')) return 'circuit-relay'
  if (addr.includes('/wss') || addr.includes('/tls/ws')) return 'wss'
  if (addr.includes('/ws')) return 'ws'
  if (addr.includes('/tcp')) return 'tcp'
  if (addr.includes('/udp')) return 'udp'
  return 'other'
}

export interface ConnectionBreakdown {
  total: number
  byDirection: Record<string, number>
  byTransport: Record<string, number>
  /**
   * Connections under a circuit-relay limit — a byte or duration budget after which the
   * relay drops them. Counted separately because a node whose connections are all limited
   * looks healthy by connection count and can carry almost nothing.
   */
  limited: number
}

export function connectionBreakdown(libp2p: Libp2p): ConnectionBreakdown | undefined {
  try {
    const connections = libp2p.getConnections()
    const byDirection: Record<string, number> = {}
    const byTransport: Record<string, number> = {}
    let limited = 0
    for (const connection of connections) {
      const direction = connection.direction ?? 'unknown'
      byDirection[direction] = (byDirection[direction] ?? 0) + 1
      const transport = transportOf(connection.remoteAddr.toString())
      byTransport[transport] = (byTransport[transport] ?? 0) + 1
      if (connection.limits != null) {
        limited++
      }
    }
    return { total: connections.length, byDirection, byTransport, limited }
  } catch (e) {
    return undefined
  }
}

export interface DialQueueStats {
  total: number
  byStatus: Record<string, number>
}

/**
 * Depth of libp2p's dial queue, split by status.
 *
 * The queue is bounded by `maxDialQueueLength` and drains at `maxParallelDials`, so a
 * standing backlog is the thing that turns "the network is slow" into "every send times out
 * before it dials". `queued` versus `active` is the whole signal: a deep queue with the
 * parallel slots full is saturation, a deep queue with idle slots is a stuck dial.
 */
export function dialQueueStats(libp2p: Libp2p): DialQueueStats | undefined {
  try {
    const manager = (
      libp2p as Libp2p & {
        components?: {
          connectionManager?: { getDialQueue?: () => Array<{ status?: string }> }
        }
      }
    ).components?.connectionManager
    if (typeof manager?.getDialQueue !== 'function') {
      return undefined
    }
    const queue = manager.getDialQueue()
    const byStatus: Record<string, number> = {}
    for (const pending of queue) {
      const status = pending.status ?? 'unknown'
      byStatus[status] = (byStatus[status] ?? 0) + 1
    }
    return { total: queue.length, byStatus }
  } catch (e) {
    return undefined
  }
}

export interface AddressConfirmation {
  total: number
  /**
   * Addresses another peer has confirmed it can reach us on. This is AutoNAT's verdict, and
   * the closest thing libp2p has to "am I reachable": an address this node believes in but
   * nobody has verified is exactly what a NAT'd node announces before it learns otherwise.
   */
  verified: number
  unverified: number
}

export function addressConfirmation(libp2p: Libp2p): AddressConfirmation | undefined {
  try {
    const manager = (
      libp2p as Libp2p & {
        components?: {
          addressManager?: {
            getAddressesWithMetadata?: () => Array<{ verified?: boolean }>
          }
        }
      }
    ).components?.addressManager
    if (typeof manager?.getAddressesWithMetadata !== 'function') {
      return undefined
    }
    const addresses = manager.getAddressesWithMetadata()
    const verified = addresses.filter((address) => address.verified === true).length
    return { total: addresses.length, verified, unverified: addresses.length - verified }
  } catch (e) {
    return undefined
  }
}

export interface RelayReservations {
  /** Reservations this node holds *on* relays, i.e. how many ways an unreachable peer can be dialled. */
  held?: number
  /** Reservations this node grants *to* other peers, when it runs a relay server. */
  granted?: number
}

export function relayReservations(libp2p: Libp2p): RelayReservations | undefined {
  const result: RelayReservations = {}
  try {
    const transports = (
      libp2p as Libp2p & {
        components?: { transportManager?: { getTransports?: () => unknown[] } }
      }
    ).components?.transportManager?.getTransports?.()
    for (const transport of transports ?? []) {
      const store = (
        transport as { reservationStore?: { reservationCount?: () => number } }
      ).reservationStore
      if (typeof store?.reservationCount === 'function') {
        result.held = store.reservationCount()
      }
    }
  } catch (e) {
    // leave `held` unset
  }
  try {
    const server = (libp2p.services as Record<string, any> | undefined)?.circuitRelay as
      { reservations?: { size?: number } } | undefined
    const size = server?.reservations?.size
    if (typeof size === 'number') {
      result.granted = size
    }
  } catch (e) {
    // leave `granted` unset
  }
  return result.held === undefined && result.granted === undefined ? undefined : result
}

export interface AutoTlsState {
  /** Whether a certificate is currently loaded. `false` before the first provisioning. */
  present: boolean
  /** ISO expiry, when a certificate is loaded and its PEM could be parsed. */
  notAfter?: string
  /** Whole days until expiry; negative once expired. */
  daysRemaining?: number
}

/**
 * State of the autoTLS certificate, which is what makes this node dialable from a browser.
 *
 * Expiry is parsed out of the PEM with Node's built-in `X509Certificate` rather than by
 * adding a certificate library: the service holds `{ key, cert }` and no expiry field, and
 * `notAfter` is the only part of the certificate anybody operating a node needs to see.
 */
export function autoTlsState(libp2p: Libp2p): AutoTlsState | undefined {
  try {
    const service = (libp2p.services as Record<string, any> | undefined)?.autoTLS as
      { certificate?: { cert?: string } } | undefined
    if (service === undefined) {
      return undefined
    }
    const pem = service.certificate?.cert
    if (typeof pem !== 'string' || pem.length === 0) {
      return { present: false }
    }
    const notAfter = new X509Certificate(pem).validTo
    const expiresAt = new Date(notAfter)
    if (Number.isNaN(expiresAt.getTime())) {
      return { present: true }
    }
    return {
      present: true,
      notAfter: expiresAt.toISOString(),
      daysRemaining: Math.floor((expiresAt.getTime() - Date.now()) / 86_400_000)
    }
  } catch (e) {
    return undefined
  }
}

export interface PeerStoreAges {
  maxAddressAge?: number
  maxPeerAge?: number
}

/**
 * The peer store lifetimes **as the running node applies them**, not as configured.
 *
 * Worth reporting precisely because the configured value and the effective one have come
 * apart before: these are read once at node construction, so changing the environment on a
 * running process does nothing until restart, and an operator reading their own env var has
 * no way to tell. This reads the node.
 */
export function effectivePeerStoreAges(libp2p: Libp2p): PeerStoreAges | undefined {
  try {
    const { store } = libp2p.peerStore as unknown as {
      store?: { maxAddressAge?: number; maxPeerAge?: number }
    }
    if (store === undefined) {
      return undefined
    }
    const ages: PeerStoreAges = {}
    if (typeof store.maxAddressAge === 'number') ages.maxAddressAge = store.maxAddressAge
    if (typeof store.maxPeerAge === 'number') ages.maxPeerAge = store.maxPeerAge
    return ages.maxAddressAge === undefined && ages.maxPeerAge === undefined
      ? undefined
      : ages
  } catch (e) {
    return undefined
  }
}
