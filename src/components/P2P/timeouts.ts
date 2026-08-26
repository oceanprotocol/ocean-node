/**
 * Centralised P2P timeout / attempt budgets.
 *
 * Every value here is the single source of truth for one literal that used to be hard-coded in
 * `src/components/P2P/index.ts` (and, for the two FindDDO budgets, in
 * `src/components/core/handler/ddoHandler.ts`). The values marked "shared" are kept identical
 * in ocean-node, ocean.js and ocean-node-bootstrap - change them in all three or in none.
 *
 * Every value is env-overridable. The getters re-read `process.env` on each access on purpose:
 * a module-level `const` is captured at import time, which is exactly why the constants this
 * file absorbs could not be overridden by a test that sets the variable after the module graph
 * is loaded. The cost is one `Number()` per call, on paths about to do network I/O.
 *
 * Known seam: every key here has to be declared in three places - here,
 * `OceanNodeP2PConfigSchema` and `ENV_TO_CONFIG_MAPPING` - or the validated config and the
 * running code disagree about a budget that only one of them can see. Consumption is via
 * `process.env` rather than `config.p2pConfig.*`, so setting a value through an environment
 * variable works on both paths, while setting it *only* in `config.json` reaches the schema but
 * not this module.
 */

/**
 * The defaults. A plain frozen record so a reader can diff the values against the other repos
 * without chasing getters.
 */
export const P2P_TIMEOUT_DEFAULTS = Object.freeze({
  /** `FINDPEER_TIMEOUT_MS` - a multi-hop Kademlia walk needs 10-30s, not 3-5s. */
  findPeerMs: 20_000,
  /** `FINDPROVIDERS_TIMEOUT_MS` - without it, kad-dht falls through to its 180s default. */
  findProvidersMs: 20_000,
  /** `STREAM_IDLE_TIMEOUT_MS` - response-frame read budget; must not reuse the dial timeout. */
  streamIdleMs: 60_000,
  /** `SENDTO_RESOLVE_MS` - address resolution stage of `sendTo`. */
  sendToResolveMs: 20_000,
  /** `SENDTO_DIAL_MS` - dial stage of `sendTo`. */
  sendToDialMs: 15_000,
  /** `SENDTO_STREAM_MS` - stream open + command write + status read stage of `sendTo`. */
  sendToStreamMs: 10_000,
  /** `SENDTO_MAX_ATTEMPTS` - number of send attempts, each with fresh per-stage signals. */
  sendToMaxAttempts: 2,
  /**
   * Overall deadline for one `sendTo` *setup* phase.
   *
   * Why 45s: it is exactly `sendToResolveMs + sendToDialMs + sendToStreamMs`
   * (20 + 15 + 10), i.e. one complete legitimate slow path - a cold DHT resolution, a slow
   * dial and a slow protocol negotiation - so nothing that would have succeeded is cut off.
   * What it *does* cut is the accumulation: resolve 20 + dial 15 + DHT re-resolve 20 + dial 15
   * + stream 10 + attempt-2 dial 15 + stream 10 = 105s worst case before this existed, and
   * ~210s for `BaseProcessor.decryptDDO`'s two sequential calls.
   *
   * It bounds the setup phase only - address resolution, dial, stream open, the command write,
   * the optional request body and the status frame. It deliberately does *not* bound the
   * response body: a large download or a compute result legitimately runs for much longer than
   * any setup. The body has its own ceiling, `streamBodyMs`, on top of the per-frame
   * `streamIdleMs`. See the comment on `sendTo` for how the three are wired.
   */
  sendToTotalMs: 45_000,
  /**
   * `STREAM_BODY_TIMEOUT_MS` - ceiling on the *whole* response body of one command, measured
   * from the moment the caller starts iterating it.
   *
   * Why it has to exist separately from `streamIdleMs`: that budget rearms on every frame, so
   * it bounds a *stall*, not a transfer. A peer that keeps sending is never cut off, however
   * slowly it sends and however long it goes on. Measured with a 400ms idle budget: a peer
   * emitting one frame every 250ms was still streaming at 6036ms, and would have kept going
   * indefinitely. Three of the five in-repo `sendTo` call sites pass no signal of their own -
   * two of them on the indexer path - so for those there was no upper bound at all, and a
   * single broken or hostile peer could hold a chain indexer open forever.
   *
   * Why one hour: it has to clear any transfer this protocol legitimately carries, and the
   * largest are whole-file downloads forwarded from `/directCommand`. At the frame sizes seen
   * on the wire (16-64 KiB) an hour carries ~3.5 GiB at 1 MiB/s and ~35 GiB at 10 MiB/s, so
   * every real transfer finishes with room to spare, while the trickle above is cut at a known
   * point instead of never. It is also the same order as the *responder's* own per-frame write
   * budget (30 minutes in the protocol handler): a body still going after twice that is
   * already outside what the far end is built to sustain.
   *
   * What it does not fix: an operator whose peers legitimately stream for longer - a
   * multi-hour download on a slow link, or a long compute-log tail - has to raise it. That is
   * why it is a documented budget with an env override rather than a hard-coded literal.
   */
  streamBodyMs: 60 * 60_000,
  /**
   * Needed once `advertiseString` began passing a `signal` through to
   * `contentRouting.provide()`, which otherwise has no default budget. Aligned with the other DHT-walk budgets rather than kad-dht's 180s `DEFAULT_QUERY_TIMEOUT`.
   */
  advertiseMs: 20_000,
  /** Pre-existing local value, named rather than changed: peerStore lookup is a local read. */
  peerStoreGetMs: 3_000,
  /** Pre-existing local value, named rather than changed: opportunistic dial of a new peer. */
  discoveryDialMs: 10_000,
  /**
   * libp2p's own default for `maxInboundStreams`, stated explicitly so it is tunable. Not a
   * timeout, but absorbed here because it was parked as a module-level literal in `index.ts`
   * with no config surface.
   */
  commandMaxInboundStreams: 32,
  /**
   * FindDDO overall deadline, consumed in `ddoHandler.ts`. Exported here so that file has one
   * place to import from instead of re-declaring 60s.
   */
  findDdoMs: 60_000,
  /** Inter-provider back-off inside FindDDO - also consumed in `ddoHandler.ts`. */
  providerRetrySleepMs: 5_000,
  /**
   * `maxAddressAge` - how long the peer store keeps a peer's multiaddrs before treating them
   * as expired and dropping them from every read.
   *
   * libp2p's own default is **one hour**, and that is the mismatch this value exists to
   * remove: a DHT provider record stays valid for **48 hours**, so for up to 47 of those the
   * network hands us a provider whose addresses we discarded, and the lookup resolves to
   * nothing. The expiry is also not refreshed by re-learning the same address: when an
   * address that is already stored is stored again, the peer store carries the *previous*
   * observation timestamp forward rather than stamping it anew, so a peer we keep hearing
   * about, from identify or from the DHT, still expires exactly one hour after it was first
   * seen. Matching the provider-record lifetime is what makes a provider record and the
   * addresses it points at expire together.
   *
   * The cost of the longer lifetime is a stale address for a peer that changed IP, which the
   * dialler already absorbs: a peer-store hit that fails to dial re-resolves DHT-only and
   * dials again, once per send. That path is counted, so the trade is measurable rather than
   * assumed - see `counters.ts`.
   */
  peerStoreMaxAddressAgeMs: 172_800_000,
  /**
   * `maxPeerAge` - how long a peer *record* with no addresses survives before eviction.
   * libp2p's default is six hours.
   *
   * It has to be at or above `peerStoreMaxAddressAgeMs`, or the record is evicted while the
   * addresses it carries are still inside their own lifetime, which puts the eviction back
   * where it was. They are the same value here for that reason; `peerStoreAgeLimits()`
   * enforces the ordering for overrides.
   */
  peerStoreMaxPeerAgeMs: 172_800_000
})

/**
 * Hard ceiling on `SENDTO_MAX_ATTEMPTS`. It was floored at 1 but not capped, so
 * `P2P_SENDTO_MAX_ATTEMPTS=1000` multiplied the whole `sendTo` budget by 1000. Five is
 * generous - the default is 2 - and it keeps the worst case at `5 x sendToTotalMs`.
 */
export const SENDTO_MAX_ATTEMPTS_CAP = 5

/**
 * Default ceiling on every budget, because past it the timer primitives stop behaving.
 *
 * Measured on Node 24:
 *
 *   - above `2_147_483_647` (`INT32_MAX`), `setTimeout` prints `TimeoutOverflowWarning: ...
 *     does not fit into a 32-bit signed integer` and fires after **1ms**;
 *   - above `4_294_967_295`, `AbortSignal.timeout` throws
 *     `RangeError [ERR_OUT_OF_RANGE]` out of `stageSignal` itself.
 *
 * So `P2P_SENDTO_TOTAL_MS=10000000000` did not give `sendTo` a ten-billion-millisecond
 * budget - it aborted every call instantly, or crashed it, while reporting the huge number in
 * the error message. That is the same class of failure as the blank and non-numeric values the
 * coercion below already absorbs, and the same mirror image: the low end was clamped, the high
 * end was not.
 */
export const P2P_BUDGET_CAP = 2_147_483_647

/**
 * Default floor on every millisecond budget, because below it a budget cannot outlive the
 * operation it is supposed to bound.
 *
 * The low end was only ever floored at 1, so `P2P_STREAM_IDLE_TIMEOUT_MS=1` was accepted and
 * broke every transfer - the mirror image of the unclamped high end above, and the same class
 * of operator typo.
 *
 * Why 50ms: every budgeted stage costs at least one round trip to the peer, and most cost
 * several. Measured on this machine, a *bare* loopback TCP connect plus a one-byte round trip
 * - no encryption, no muxer, no protocol negotiation - runs at 0.25ms median with a 2.9ms
 * tail; a real dial adds multistream-select, a Noise XX handshake and yamux negotiation, so
 * roughly six round trips even to a peer on the same host. 50ms therefore sits above what the
 * cheapest possible stage needs and far below one intercontinental round trip, so it can only
 * reject values that could not have completed against any peer at all. It is also 1/60th of
 * the smallest default (`peerStoreGetMs`, 3000), so no budget an operator might legitimately
 * tune down is caught by it.
 *
 * A below-floor value is *dropped*, not clamped up - unlike the ceiling. The low end has
 * always dropped (`0`, `-1` and blank all fall back), and raising a number the operator did
 * not ask for would look like the value was honoured. The ceiling clamps instead because there
 * the alternative is a budget that breaks the timer primitives outright.
 *
 * Counts are exempt: `SENDTO_MAX_ATTEMPTS` and `COMMAND_MAX_INBOUND_STREAMS` are not
 * milliseconds, and 1 is a valid value for both, so they keep the implicit floor of 1.
 */
export const P2P_BUDGET_MIN_MS = 50

/**
 * The single coercion rule for every P2P budget, shared with `OceanNodeP2PConfigSchema`. The
 * zod half and this module used to disagree in two measurable ways:
 *
 *   - `P2P_SENDTO_DIAL_MS=` - the empty-value idiom `.env.example` uses on every line - made
 *     `z.coerce.number()` produce `0`, so `config.p2pConfig.sendToDialTimeout` was `0` while
 *     this module used 15000;
 *   - `P2P_SENDTO_DIAL_MS=15s` made `z.coerce.number()` produce `NaN`, which the schema
 *     *rejected*, so the node refused to boot - contradicting this file's own documented
 *     promise that a malformed value is ignored.
 *
 * Decision: **ignore and fall back**, on both halves. A malformed budget is an operator typo,
 * and refusing to start a node over one is a worse outcome than running with the mandated
 * documented default; this module was already lenient, and adding these keys to the schema
 * should not have turned that into a startup-fatal. The value is
 * dropped, not clamped to something arbitrary, so `.default()` in the schema and `fallback`
 * here produce the same number.
 *
 * Accepted: a `number`, or a `string` `Number()` parses to a finite value, floored to an
 * integer (these are milliseconds and counts - a fractional budget has no meaning, and the
 * schema declares `.int()`) and at or above the floor. Rejected -> `undefined`: `undefined`,
 * `null`, blank/whitespace, non-numeric text, `NaN`, `Infinity`, zero, negatives and anything
 * below the floor - which is 1 unless the caller passes a higher `min`.
 *
 * Types other than `number` and `string` are rejected too. `Number()` is happy to turn `true`
 * into `1` and `[5]` into `5`, and while an environment variable can only ever be a string,
 * these keys are also read out of `config.json`, where the JSON types are real: `"streamIdleTimeout": true`
 * would have become a 1ms budget. A budget of the wrong *type* is an operator mistake in the
 * same way a budget of the wrong *format* is, and it gets the same treatment - ignored, so the
 * documented default applies.
 *
 * @param max optional ceiling, defaulting to `P2P_BUDGET_CAP`; a value above it is clamped
 *   rather than dropped, so the schema and the getters agree on `SENDTO_MAX_ATTEMPTS` too, and
 *   no budget can reach a value that breaks `setTimeout` / `AbortSignal.timeout`.
 * @param min optional floor, defaulting to 1. A value below it is dropped, exactly like a
 *   blank or malformed one, so the documented default applies. Millisecond budgets pass
 *   `P2P_BUDGET_MIN_MS`; counts leave it at 1. Both halves - this module's getters and
 *   `OceanNodeP2PConfigSchema` - pass the same floor for the same key, which is why the floor
 *   lives in the shared rule rather than in either caller.
 */
export function normalizeP2pBudget(
  raw: unknown,
  max?: number,
  min?: number
): number | undefined {
  if (typeof raw !== 'number' && typeof raw !== 'string') {
    return undefined
  }
  const candidate = typeof raw === 'string' ? raw.trim() : raw
  if (candidate === '') {
    return undefined
  }
  const parsed = Number(candidate)
  if (!Number.isFinite(parsed)) {
    return undefined
  }
  const floored = Math.floor(parsed)
  if (floored < Math.max(1, min ?? 1)) {
    return undefined
  }
  return Math.min(floored, max ?? P2P_BUDGET_CAP)
}

/**
 * Reads a budget from the environment, falling back to the mandated default. A blank,
 * malformed, zero, negative or below-floor value is ignored rather than silently disabling or
 * crippling a budget - an unbounded DHT query, and a 1ms one, are both failure modes these
 * constants exist to stop.
 */
function envPositiveNumber(
  name: string,
  fallback: number,
  max?: number,
  min?: number
): number {
  return normalizeP2pBudget(process.env[name], max, min) ?? fallback
}

/**
 * Live view of the budgets. Import this object, never destructure it at module scope, or the
 * env-override and test-override behaviour is lost again.
 */
export const P2P_TIMEOUTS = {
  get findPeerMs(): number {
    return envPositiveNumber(
      'P2P_FINDPEER_TIMEOUT_MS',
      P2P_TIMEOUT_DEFAULTS.findPeerMs,
      undefined,
      P2P_BUDGET_MIN_MS
    )
  },
  get findProvidersMs(): number {
    return envPositiveNumber(
      'P2P_FINDPROVIDERS_TIMEOUT_MS',
      P2P_TIMEOUT_DEFAULTS.findProvidersMs,
      undefined,
      P2P_BUDGET_MIN_MS
    )
  },
  get streamIdleMs(): number {
    return envPositiveNumber(
      'P2P_STREAM_IDLE_TIMEOUT_MS',
      P2P_TIMEOUT_DEFAULTS.streamIdleMs,
      undefined,
      P2P_BUDGET_MIN_MS
    )
  },
  get sendToResolveMs(): number {
    return envPositiveNumber(
      'P2P_SENDTO_RESOLVE_MS',
      P2P_TIMEOUT_DEFAULTS.sendToResolveMs,
      undefined,
      P2P_BUDGET_MIN_MS
    )
  },
  get sendToDialMs(): number {
    return envPositiveNumber(
      'P2P_SENDTO_DIAL_MS',
      P2P_TIMEOUT_DEFAULTS.sendToDialMs,
      undefined,
      P2P_BUDGET_MIN_MS
    )
  },
  get sendToStreamMs(): number {
    return envPositiveNumber(
      'P2P_SENDTO_STREAM_MS',
      P2P_TIMEOUT_DEFAULTS.sendToStreamMs,
      undefined,
      P2P_BUDGET_MIN_MS
    )
  },
  get sendToMaxAttempts(): number {
    return envPositiveNumber(
      'P2P_SENDTO_MAX_ATTEMPTS',
      P2P_TIMEOUT_DEFAULTS.sendToMaxAttempts,
      SENDTO_MAX_ATTEMPTS_CAP
    )
  },
  get sendToTotalMs(): number {
    return envPositiveNumber(
      'P2P_SENDTO_TOTAL_MS',
      P2P_TIMEOUT_DEFAULTS.sendToTotalMs,
      undefined,
      P2P_BUDGET_MIN_MS
    )
  },
  get streamBodyMs(): number {
    return envPositiveNumber(
      'P2P_STREAM_BODY_TIMEOUT_MS',
      P2P_TIMEOUT_DEFAULTS.streamBodyMs,
      undefined,
      P2P_BUDGET_MIN_MS
    )
  },
  get advertiseMs(): number {
    return envPositiveNumber(
      'P2P_ADVERTISE_TIMEOUT_MS',
      P2P_TIMEOUT_DEFAULTS.advertiseMs,
      undefined,
      P2P_BUDGET_MIN_MS
    )
  },
  get peerStoreGetMs(): number {
    return envPositiveNumber(
      'P2P_PEERSTORE_GET_MS',
      P2P_TIMEOUT_DEFAULTS.peerStoreGetMs,
      undefined,
      P2P_BUDGET_MIN_MS
    )
  },
  get discoveryDialMs(): number {
    return envPositiveNumber(
      'P2P_DISCOVERY_DIAL_MS',
      P2P_TIMEOUT_DEFAULTS.discoveryDialMs,
      undefined,
      P2P_BUDGET_MIN_MS
    )
  },
  get commandMaxInboundStreams(): number {
    return envPositiveNumber(
      'P2P_COMMAND_MAX_INBOUND_STREAMS',
      P2P_TIMEOUT_DEFAULTS.commandMaxInboundStreams
    )
  },
  get findDdoMs(): number {
    return envPositiveNumber(
      'P2P_FINDDDO_TIMEOUT_MS',
      P2P_TIMEOUT_DEFAULTS.findDdoMs,
      undefined,
      P2P_BUDGET_MIN_MS
    )
  },
  get providerRetrySleepMs(): number {
    return envPositiveNumber(
      'P2P_PROVIDER_RETRY_SLEEP_MS',
      P2P_TIMEOUT_DEFAULTS.providerRetrySleepMs,
      undefined,
      P2P_BUDGET_MIN_MS
    )
  },
  get peerStoreMaxAddressAgeMs(): number {
    return envPositiveNumber(
      'P2P_PEERSTORE_MAX_ADDRESS_AGE_MS',
      P2P_TIMEOUT_DEFAULTS.peerStoreMaxAddressAgeMs,
      undefined,
      P2P_BUDGET_MIN_MS
    )
  },
  get peerStoreMaxPeerAgeMs(): number {
    return envPositiveNumber(
      'P2P_PEERSTORE_MAX_PEER_AGE_MS',
      P2P_TIMEOUT_DEFAULTS.peerStoreMaxPeerAgeMs,
      undefined,
      P2P_BUDGET_MIN_MS
    )
  }
}

/**
 * The peer store's two age limits, resolved together because they are not independent: a peer
 * record evicted at `maxPeerAge` takes its still-valid addresses with it, so a `maxPeerAge`
 * below `maxAddressAge` silently shortens the address lifetime to the smaller of the two. An
 * operator who raises only one of them would get that, and would have no way to see it, so the
 * ordering is enforced here rather than documented and hoped for.
 *
 * Returned as a plain object because it is passed straight to libp2p's `peerStore` option.
 */
export function peerStoreAgeLimits(): { maxAddressAge: number; maxPeerAge: number } {
  const maxAddressAge = P2P_TIMEOUTS.peerStoreMaxAddressAgeMs
  return {
    maxAddressAge,
    maxPeerAge: Math.max(P2P_TIMEOUTS.peerStoreMaxPeerAgeMs, maxAddressAge)
  }
}

/**
 * Builds a fresh per-stage `AbortSignal`, optionally bounded by a caller-supplied overall
 * deadline. Each stage and each attempt needs a *new* signal - reusing an already-ticking
 * signal is what left a retry with 1s of budget after a 9s first attempt.
 *
 * Caller contract: `overall` must be a *short-lived*
 * signal, ideally one `AbortController` owned by the operation. Every `AbortSignal.any`
 * composite registers itself in `overall`'s internal dependant-signal set and is only removed
 * when `overall` itself becomes garbage, so passing a long-lived signal here in a loop grows
 * that set without bound. `sendTo` therefore creates one local controller per call and passes
 * *that* to every stage, forwarding the caller's signal into it with a single listener that it
 * removes in a `finally`. Never call this once per response frame: one controller per
 * iterator, rearmed per frame, is what keeps the timer cancellable.
 */
export function stageSignal(ms: number, overall?: AbortSignal): AbortSignal {
  const fresh = AbortSignal.timeout(ms)
  return overall ? AbortSignal.any([overall, fresh]) : fresh
}
