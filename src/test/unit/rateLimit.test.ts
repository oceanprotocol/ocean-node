import { expect } from 'chai'
import { OceanNodeConfig } from '../../@types/OceanNode.js'
import {
  checkRequestsRateLimit,
  checkGlobalConnectionsRateLimit,
  recordAcceptedRequest,
  resetRateLimiterState,
  connectionsDataSize
} from '../../utils/validators.js'
import {
  CONNECTIONS_RATE_INTERVAL,
  CONNECTION_HISTORY_DELETE_THRESHOLD
} from '../../utils/constants.js'

// These exercise the pure rate-limit helpers. The per-IP map AND the global window counter are
// module-level shared state, so each test must start from a clean slate — unique IPs do not
// isolate the single global counter, and a real Date.now() recorded by an earlier suite would
// leak into these fixed-timestamp, low-cap assertions. resetRateLimiterState() in beforeEach
// provides that isolation.
function cfg(partial: Partial<OceanNodeConfig>): OceanNodeConfig {
  return { rateLimit: 1000, maxConnections: 1000, ...partial } as OceanNodeConfig
}

// Mirrors the admission sequence in requestValidator / handleProtocolCommands: peek both
// limits, and only record the request when it is admitted. Returns the HTTP-ish outcome.
function tryAdmit(ip: string, configuration: OceanNodeConfig, now: number): number {
  if (!checkRequestsRateLimit(ip, configuration, now).valid) return 429
  if (!checkGlobalConnectionsRateLimit(configuration, now).valid) return 403
  recordAcceptedRequest(ip, now)
  return 200
}

describe('HTTP rate limiting', () => {
  beforeEach(() => {
    resetRateLimiterState()
  })

  it('per-IP limit blocks the same IP once it exceeds rateLimit', () => {
    const configuration = cfg({ rateLimit: 3 })
    const now = 1_000_000
    const ip = '10.0.0.1'
    expect(tryAdmit(ip, configuration, now)).to.equal(200)
    expect(tryAdmit(ip, configuration, now)).to.equal(200)
    expect(tryAdmit(ip, configuration, now)).to.equal(200)
    // 4th within the same window exceeds the per-IP limit
    expect(tryAdmit(ip, configuration, now)).to.equal(429)
  })

  it('global cap counts TOTAL requests, not distinct clients (regression)', () => {
    // A single client's requests must each count toward the node-wide cap. The old
    // implementation counted distinct keys (so many requests from one IP counted as 1), which
    // is exactly what let a spoofed X-Forwarded-For inflate the cap while hiding real volume.
    const configuration = cfg({ maxConnections: 3 })
    const now = 2_000_000
    const ip = '10.1.0.1'
    expect(tryAdmit(ip, configuration, now)).to.equal(200)
    expect(tryAdmit(ip, configuration, now)).to.equal(200)
    expect(tryAdmit(ip, configuration, now)).to.equal(200)
    // 4th request: 3 already accepted => global cap reached
    expect(tryAdmit(ip, configuration, now)).to.equal(403)
  })

  it('global cap sums across distinct clients within the window', () => {
    const configuration = cfg({ maxConnections: 3 })
    const now = 3_000_000
    expect(tryAdmit('10.2.0.1', configuration, now)).to.equal(200)
    expect(tryAdmit('10.2.0.2', configuration, now)).to.equal(200)
    expect(tryAdmit('10.2.0.3', configuration, now)).to.equal(200)
    // 4th distinct client => over the node-wide cap
    expect(tryAdmit('10.2.0.4', configuration, now)).to.equal(403)
  })

  it('rejected requests do NOT consume global capacity (self-lockout regression)', () => {
    // Reviewer scenario: once the cap is reached, further rejected requests must not keep the
    // count pinned. Otherwise a client that keeps getting 403'd perpetuates the outage.
    const configuration = cfg({ maxConnections: 2, rateLimit: 1000 })
    const base = 7_000_000
    const a = '10.4.0.1'
    const b = '10.4.0.2'
    // A fills the cap with 2 accepted requests.
    expect(tryAdmit(a, configuration, base)).to.equal(200)
    expect(tryAdmit(a, configuration, base)).to.equal(200)
    // B hammers while the cap is full: every attempt is rejected and NONE is recorded.
    const mid = base + 1000
    for (let i = 0; i < 5; i++) {
      expect(tryAdmit(b, configuration, mid)).to.equal(403)
    }
    // Once A's window elapses its entries are pruned. Because B's rejected attempts were never
    // recorded, the node is immediately available again for C.
    const later = base + CONNECTIONS_RATE_INTERVAL + 1
    expect(tryAdmit('10.4.0.3', configuration, later)).to.equal(200)
  })

  it('different clients share one global fixed window that resets after expiry', () => {
    const configuration = cfg({ maxConnections: 2, rateLimit: 1000 })
    const base = 11_000_000
    // Two different clients fill the single shared global window within the same window.
    expect(tryAdmit('10.6.0.1', configuration, base)).to.equal(200)
    expect(tryAdmit('10.6.0.2', configuration, base)).to.equal(200)
    // Cap reached for this window — a third distinct client is rejected.
    expect(tryAdmit('10.6.0.3', configuration, base)).to.equal(403)
    // After the window expires the global counter resets: admissions flow again...
    const next = base + CONNECTIONS_RATE_INTERVAL + 1
    expect(tryAdmit('10.6.0.4', configuration, next)).to.equal(200)
    expect(tryAdmit('10.6.0.5', configuration, next)).to.equal(200)
    // ...until the new window reaches its cap.
    expect(tryAdmit('10.6.0.6', configuration, next)).to.equal(403)
  })

  it('prunes stale entries so they stop counting after the window passes', () => {
    const configuration = cfg({ maxConnections: 3 })
    const base = 9_000_000
    const ip = '10.3.0.1'
    expect(tryAdmit(ip, configuration, base)).to.equal(200)
    expect(tryAdmit(ip, configuration, base)).to.equal(200)
    expect(tryAdmit(ip, configuration, base)).to.equal(200)
    // cap reached
    expect(tryAdmit(ip, configuration, base)).to.equal(403)

    // One full window later the old entry is stale: it must be pruned and no longer counted,
    // so the node is available again instead of staying tripped.
    const later = base + CONNECTIONS_RATE_INTERVAL + 1
    expect(tryAdmit(ip, configuration, later)).to.equal(200)
  })

  it('hard-caps the per-IP map, evicting oldest-first under a flood of distinct IPs', () => {
    // Defense-in-depth (ON-05 residual): even within a single window, the per-IP map must not
    // grow without bound. Admit more than the hard cap of distinct IPs with strictly increasing
    // timestamps (so the oldest are well-defined) and assert the map stays bounded.
    const configuration = cfg({ rateLimit: 1000, maxConnections: 10_000_000 })
    const base = 13_000_000
    const total = CONNECTION_HISTORY_DELETE_THRESHOLD + 50
    for (let i = 0; i < total; i++) {
      const ip = `172.16.${Math.floor(i / 256)}.${i % 256}`
      expect(tryAdmit(ip, configuration, base + i)).to.equal(200)
    }
    // Bounded by the hard cap, not grown to `total`.
    expect(connectionsDataSize()).to.be.lessThanOrEqual(
      CONNECTION_HISTORY_DELETE_THRESHOLD
    )
  })
})
