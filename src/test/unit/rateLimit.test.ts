import { expect } from 'chai'
import { OceanNodeConfig } from '../../@types/OceanNode.js'
import {
  checkRequestsRateLimit,
  checkGlobalConnectionsRateLimit,
  recordAcceptedRequest
} from '../../utils/validators.js'
import { CONNECTIONS_RATE_INTERVAL } from '../../utils/constants.js'

// These exercise the pure rate-limit helpers. The module-level connectionsData map is shared
// across calls, so every test uses its own IP namespace and its own base timestamp (far apart
// in time) to avoid cross-test interference; stale entries are pruned by the global check.
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

  it('prunes stale entries so they stop counting after the window passes', () => {
    // Base must be later than every earlier test's timestamps: the shared connectionsData map
    // persists across tests, and the global check treats any entry within the window (including
    // future-dated ones from a later-numbered-but-earlier-running test) as active.
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
})
