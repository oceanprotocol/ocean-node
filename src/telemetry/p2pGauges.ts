/**
 * Attaches the P2P observable-gauge callbacks.
 *
 * Called once after `OceanP2P.start()`. A single batch callback fires per export tick (default 60s)
 * and reshapes the read-only probes `getNetworkingStats()` / `getP2PStatus()` into the gauge
 * instruments declared in `metrics.ts`. Every read is guarded so the callback observes nothing
 * rather than throwing when a probe is unavailable — the same defensive posture as
 * `P2P/observability.ts`, whose actual return shapes this callback is written against.
 */
import type { OceanP2P } from '../components/P2P/index.js'
import * as M from './metrics.js'

export function registerP2PGauges(p2p: OceanP2P): void {
  if (!p2p) return

  const safe = <T>(fn: () => T): T | undefined => {
    try {
      return fn()
    } catch {
      return undefined
    }
  }

  M.meter.addBatchObservableCallback(
    (obs) => {
      const s: any = safe(() => p2p.getNetworkingStats()) || {}
      const st: any = safe(() => p2p.getP2PStatus()) || {}

      // connectionBreakdown => { total, byDirection, byTransport, limited }
      const cb = s.connectionBreakdown
      if (cb) {
        const byDirection = cb.byDirection || {}
        for (const [direction, count] of Object.entries(byDirection)) {
          if (typeof count === 'number') {
            obs.observe(M.p2pConnections, count, { direction })
          }
        }
        if (typeof cb.limited === 'number') {
          obs.observe(M.p2pConnectionsLimited, cb.limited)
        }
      }

      if (typeof st.routingTablePeers === 'number') {
        obs.observe(M.p2pRoutingTablePeers, st.routingTablePeers)
      }
      // Only emit when the mode is actually known: an unreachable DHT service reports
      // `undefined`, which is not the same as "client" and must not be recorded as 0.
      if (st.dhtMode === 'server' || st.dhtMode === 'client') {
        obs.observe(M.p2pDhtMode, st.dhtMode === 'server' ? 1 : 0)
      }
      obs.observe(M.p2pReady, st.ready ? 1 : 0)

      // dialQueue => { total, byStatus }
      const dq = s.dialQueue
      if (dq && dq.byStatus) {
        for (const [status, count] of Object.entries(dq.byStatus)) {
          if (typeof count === 'number') {
            obs.observe(M.p2pDialQueue, count, { status })
          }
        }
      }

      // relayReservations => { held?, granted? }
      const rr = s.relayReservations
      if (rr) {
        if (typeof rr.held === 'number') {
          obs.observe(M.p2pRelayReservations, rr.held, { kind: 'held' })
        }
        if (typeof rr.granted === 'number') {
          obs.observe(M.p2pRelayReservations, rr.granted, { kind: 'granted' })
        }
      }

      // autoTls => { present, notAfter?, daysRemaining? }; report seconds-until-expiry.
      const notAfter = s.autoTls?.notAfter
      if (typeof notAfter === 'string') {
        const seconds = (new Date(notAfter).getTime() - Date.now()) / 1000
        if (Number.isFinite(seconds)) {
          obs.observe(M.p2pAutotlsExpiry, seconds)
        }
      }

      // resolutionCache => { resolved, unresolved, resolvedTtlMs, unresolvedTtlMs }
      const rc = s.resolutionCache
      if (rc) {
        if (typeof rc.resolved === 'number') {
          obs.observe(M.p2pResolutionCacheSize, rc.resolved, { state: 'resolved' })
        }
        if (typeof rc.unresolved === 'number') {
          obs.observe(M.p2pResolutionCacheSize, rc.unresolved, { state: 'unresolved' })
        }
      }

      // outboundSends => { concurrency, active, queued }
      if (typeof s.outboundSends?.queued === 'number') {
        obs.observe(M.p2pOutboundQueue, s.outboundSends.queued)
      }
    },
    [
      M.p2pConnections,
      M.p2pConnectionsLimited,
      M.p2pRoutingTablePeers,
      M.p2pDhtMode,
      M.p2pReady,
      M.p2pDialQueue,
      M.p2pRelayReservations,
      M.p2pAutotlsExpiry,
      M.p2pResolutionCacheSize,
      M.p2pOutboundQueue
    ]
  )
}
