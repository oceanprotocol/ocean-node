/**
 * How a P2P send failure is classified, and what is done about it.
 *
 * The rule this file exists to enforce: **a failure is identified by an error `name`, never by
 * a substring of its `message`.** The retry path used to test
 * `err.message.includes('closed') || err.message.includes('reset')`, which is wrong in both
 * directions. It misses a dead connection whose wording differs - libp2p's own
 * `MuxerClosedError` says "muxer already closed", but `ConnectionFailedError` does not contain
 * either word - and it matches any unrelated failure that happens to mention a closed
 * something, including a remote error string echoed back into a message. It also silently
 * couples this file to the exact wording of every error any dependency throws, which is not a
 * contract anybody maintains: an error message is prose, and prose gets rewritten.
 *
 * libp2p makes the `name` route viable: every error in `@libp2p/interface` sets an explicit,
 * stable `name` (`ConnectionClosedError`, `StreamResetError`, `UnsupportedProtocolError`, ...),
 * as do `AbortSignal.timeout` (`TimeoutError`) and `AbortController.abort()` (`AbortError`).
 * So classification reads names, maps them onto the five categories below, and every decision
 * downstream - retry or not, which counter, what the caller is told - is made from the
 * category.
 */

/**
 * The five failure categories. Deliberately few: each one exists because something downstream
 * treats it differently, and a category nothing branches on would just be a second spelling of
 * the message text this file replaces.
 */
export const P2P_ERROR = Object.freeze({
  /** No address for the peer could be produced by any tier, so nothing was dialled. */
  resolveFailed: 'resolve_failed',
  /**
   * A connection to the peer could not be established - or an established one died under us
   * mid-exchange (closed, reset, muxer gone).
   *
   * The two are one category because the remedy is identical: discard whatever connection we
   * thought we had and dial again. Splitting them would produce two categories with the same
   * handling, and the "died mid-exchange" half is exactly what the old `includes('closed')`
   * predicate was reaching for.
   */
  dialFailed: 'dial_failed',
  /**
   * The connection is up and healthy, and the *protocol* leg failed: the peer does not speak
   * the command protocol, its inbound stream limit is exhausted, a relayed connection refused
   * the stream, or a frame was malformed.
   */
  protocolFailed: 'protocol_failed',
  /** A budget ran out - a stage deadline, the overall setup deadline, or a caller's signal. */
  timeout: 'timeout',
  /** A connection was established, and the peer on the other end is not the one asked for. */
  peerMismatch: 'peer_mismatch'
} as const)

export type P2PErrorName = (typeof P2P_ERROR)[keyof typeof P2P_ERROR]

/**
 * A failure carrying its category as its `name`, and the error it was classified from as its
 * `cause`.
 *
 * `name` rather than a separate `code` field so that the one thing every consumer already
 * looks at is the classification, and so a `P2PError` that escapes into a generic handler
 * still identifies itself.
 */
export class P2PError extends Error {
  readonly name: P2PErrorName

  constructor(name: P2PErrorName, message: string, cause?: unknown) {
    super(message)
    this.name = name
    if (cause !== undefined) {
      this.cause = cause
    }
  }
}

/**
 * Error names that mean "the transport under us is gone". A retry has to establish a new
 * connection, which is why these land in `dialFailed` rather than in a category of their own.
 *
 * `ConnectionFailedError` is the one that makes the point: it contains neither "closed" nor
 * "reset", so the predicate this table replaces never retried it.
 */
const DEAD_TRANSPORT_NAMES = Object.freeze(
  new Set([
    'ConnectionClosedError',
    'ConnectionClosingError',
    'ConnectionFailedError',
    'MuxerClosedError',
    'StreamResetError',
    'StreamAbortedError',
    'StreamStateError',
    'StreamBufferError',
    'DialError',
    'NotStartedError'
  ])
)

/**
 * Error names that mean "the connection is fine, the protocol leg is not". Re-resolving an
 * address or dialling again cannot change any of these against the same peer.
 */
const PROTOCOL_NAMES = Object.freeze(
  new Set([
    'UnsupportedProtocolError',
    'ProtocolError',
    'InvalidMessageError',
    'LimitedConnectionError',
    'TooManyInboundProtocolStreamsError',
    'TooManyOutboundProtocolStreamsError'
  ])
)

/**
 * Error names that mean a budget expired, from libp2p, from Node's timers, or from a caller.
 * `QueryAbortedError` is a DHT walk that hit its deadline (kad-dht's `getClosestPeers` /
 * `provide` giving up), which is a timeout by another name - and treating it as one makes it
 * both retryable and quiet, which a walk cut short by our own budget should be.
 */
const TIMEOUT_NAMES = Object.freeze(
  new Set(['TimeoutError', 'AbortError', 'QueryAbortedError'])
)

/** Error names that mean the peer on the wire is not the peer that was asked for. */
const PEER_MISMATCH_NAMES = Object.freeze(
  new Set(['UnexpectedPeerError', 'InvalidCryptoExchangeError'])
)

/** Error names that mean no usable address existed, so there was nothing to dial. */
const RESOLVE_NAMES = Object.freeze(
  new Set(['NotFoundError', 'NoValidAddressesError', 'InvalidMultiaddrError'])
)

/**
 * Maps any thrown value onto one of the five categories.
 *
 * An already-classified `P2PError` is returned unchanged, so classifying twice - which happens
 * whenever an inner stage has already labelled a failure and an outer one catches it - is a
 * no-op rather than a reclassification.
 *
 * @param fallback the category for an error whose name is not in any table. Each call site
 *   passes the category of the *stage it is in*, which is the only thing that can be known
 *   about an unrecognised error: a rejection out of `dial()` is a dial failure whatever it
 *   says, and a rejection out of `newStream()` is a protocol failure. Guessing from the
 *   message is the practice this module exists to remove.
 */
export function classifyP2PError(
  err: unknown,
  fallback: P2PErrorName = P2P_ERROR.dialFailed
): P2PError {
  if (err instanceof P2PError) {
    return err
  }
  const source = err instanceof Error ? err : new Error(String(err))
  // An aborted signal reports the *reason* it was aborted, and libp2p wraps that reason
  // rather than replacing it, so the classification has to be able to see through one layer.
  // Only one: a cause chain is not walked, because past the first link the error being
  // described is no longer the failure that happened here.
  const names = [source.name, (source.cause as Error | undefined)?.name].filter(
    (name): name is string => typeof name === 'string' && name.length > 0
  )
  // Timeout takes precedence over every other category, across the whole pair of names. When a
  // budget expired that is the proximate cause however the failure was reported: libp2p wraps an
  // abort in a `DialError` or a `ProtocolError` describing the operation that was cut short, and
  // classifying it by the wrapper would point an operator at the peer when the thing to look at
  // is the budget.
  if (names.some((name) => TIMEOUT_NAMES.has(name))) {
    return new P2PError(P2P_ERROR.timeout, source.message, source)
  }
  for (const name of names) {
    if (PEER_MISMATCH_NAMES.has(name)) {
      return new P2PError(P2P_ERROR.peerMismatch, source.message, source)
    }
    if (PROTOCOL_NAMES.has(name)) {
      return new P2PError(P2P_ERROR.protocolFailed, source.message, source)
    }
    if (DEAD_TRANSPORT_NAMES.has(name)) {
      return new P2PError(P2P_ERROR.dialFailed, source.message, source)
    }
    if (RESOLVE_NAMES.has(name)) {
      return new P2PError(P2P_ERROR.resolveFailed, source.message, source)
    }
  }
  return new P2PError(fallback, source.message, source)
}

/**
 * Which categories are worth another attempt against the same peer.
 *
 *   - `timeout` **retries**. A stage budget is a guess about how slow a legitimate peer may
 *     be, and every attempt gets a *fresh* signal, so the second attempt has the whole budget
 *     rather than the remainder of the first one. A congested link, a dial queue that was
 *     saturated, or a DHT walk that was one hop from finishing all plausibly succeed the
 *     second time.
 *   - `dial_failed` **retries**. This is the category the old substring predicate was aiming
 *     at: a connection that died mid-exchange is fixed precisely by dropping it and dialling
 *     again, and a transient dial failure is the single most common reason a send fails at all.
 *   - `protocol_failed` does **not** retry. The connection was healthy, so nothing about it
 *     will differ next time: a peer that does not register the command protocol still will
 *     not, a relayed connection that refused the stream still refuses it, and an exhausted
 *     `maxInboundStreams` frees up on the remote's schedule, not within this send's deadline.
 *     Retrying spends a second dial plus a second stream negotiation to receive the same
 *     answer.
 *   - `peer_mismatch` does **not** retry. Dialling the same address reaches the same wrong
 *     peer; the address itself is what is stale, so the fix is invalidating the cached
 *     address - which `sendTo` does - and not an immediate second attempt.
 *   - `resolve_failed` does **not** retry. Resolution has already walked every tier it has,
 *     and a second walk inside the same setup deadline queries the same DHT for the same key.
 *     The peer becoming reachable again is a *later* event, which the negative cache's short
 *     lifetime is what handles.
 */
export function isRetryableP2PError(name: P2PErrorName): boolean {
  return name === P2P_ERROR.timeout || name === P2P_ERROR.dialFailed
}

/** Base back-off, doubled per attempt. */
export const RETRY_BACKOFF_BASE_MS = 250
/** Ceiling on one back-off wait, before jitter. */
export const RETRY_BACKOFF_CAP_MS = 2_000

/**
 * The wait before attempt `attempt`, exponential with **full jitter**: a uniform draw from
 * `[0, min(cap, base * 2^(attempt-2)))`.
 *
 * Jitter is the point. Every provider fan-out and every indexer decrypt loop retries on the
 * same schedule, so a fixed back-off re-synchronises all of them into a second burst against
 * the same peers at the same instant - the failure that caused the first burst, repeated. Full
 * jitter spreads the retries across the whole window instead, at the cost of some retries
 * firing almost immediately, which is acceptable here because the window is small next to
 * every stage budget it sits inside.
 *
 * @param attempt the attempt about to be made, 1-based. Attempt 1 has nothing to wait for and
 *   returns 0, so a caller can call this unconditionally.
 */
export function retryDelayMs(
  attempt: number,
  base: number = RETRY_BACKOFF_BASE_MS,
  cap: number = RETRY_BACKOFF_CAP_MS
): number {
  if (attempt <= 1) {
    return 0
  }
  const window = Math.min(cap, base * Math.pow(2, attempt - 2))
  return Math.floor(Math.random() * window)
}

/**
 * Waits `ms`, returning early if `signal` aborts. Never rejects: the caller is between retry
 * attempts and an abort there means "stop waiting", which the next `throwIfAborted` on the
 * stage signal reports properly. Rejecting here would surface the deadline as a back-off
 * failure instead.
 */
export async function delayBeforeRetry(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0 || signal?.aborted === true) {
    return
  }
  await new Promise<void>((resolve) => {
    const done = (): void => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal?.addEventListener('abort', done, { once: true })
  })
}

/**
 * One-line description of a failure, for a log line.
 *
 * Every P2P failure used to be logged as `err.message` alone, and a libp2p message is the
 * least useful part of a libp2p error. The names are specific and stable —
 * `NoValidAddressesError` (nothing dialable was known), `DialDeniedError` (the gater
 * refused), `QueryAbortedError` (a DHT walk hit its deadline), `InvalidParametersError` (we
 * handed the dialer something malformed), `TimeoutError` — and the message frequently is
 * not: several of them say nothing beyond the name, and two different causes can produce
 * identical prose. Reading a log and being unable to tell "this peer has no addresses" from
 * "we refused to dial it" is a real cost when the whole subject of this work is why a peer
 * cannot be reached.
 *
 * `code` is included because a few errors carry one and it is what a Node-level failure
 * (`ECONNREFUSED`, `EHOSTUNREACH`, `ENOTFOUND`) identifies itself by, where the name is the
 * generic `Error`.
 *
 * @param context.peerId the peer the operation concerned, when one is known.
 * @param context.addresses how many addresses were on the table. Zero versus several is the
 *   difference between a resolution failure and a reachability failure, and neither the name
 *   nor the message distinguishes them.
 */
export function describeP2PError(
  err: unknown,
  context: { peerId?: string; addresses?: number } = {}
): string {
  const parts: string[] = []
  const name = (err as { name?: unknown } | null)?.name
  const code = (err as { code?: unknown } | null)?.code
  if (typeof name === 'string' && name.length > 0) {
    parts.push(name)
  }
  if (typeof code === 'string' || typeof code === 'number') {
    parts.push(`code=${String(code)}`)
  }
  if (context.peerId !== undefined) {
    parts.push(`peer=${context.peerId}`)
  }
  if (context.addresses !== undefined) {
    parts.push(`addrs=${context.addresses}`)
  }
  const message = err instanceof Error ? err.message : String(err)
  // The message goes last and is always present: it is the part that occasionally carries
  // the only specific detail, and the part most likely to be missing anything useful.
  return parts.length > 0 ? `${parts.join(' ')}: ${message}` : message
}

/**
 * Logs a failed `advertiseString` / `contentRouting.provide()` at the level its cause warrants.
 *
 * A provide walks the DHT and writes a provider record to the peers it finds. In a sparse or
 * degraded network - which is the normal state - most of these **time out** ("The operation was
 * aborted", `TimeoutError`/`AbortError`/`QueryAbortedError`) simply because there are too few
 * live peers to reach within the `advertiseMs` budget. That is not a fault of this node and is
 * not actionable, so a timeout is logged at **debug** rather than flooding the logs at `error`.
 * The failure is still counted - `advertiseString` increments `p2pDhtProvide{outcome:fail}` -
 * so the downgrade loses no observability, only the noise.
 *
 * **Anything that is not a timeout stays loud** (`error`): a malformed CID, an
 * `InvalidParametersError`, a local `db.create`/`cacheDDO` failure caught alongside the
 * provide, or any unexpected throw is a real problem an operator should see. The split is made
 * by `classifyP2PError`, never by matching the message - see this module's header.
 *
 * `msg` is the call-site-specific prefix (which DID, from which loop); the classified error
 * description is appended. Every per-item provide catch across the P2P layer routes through
 * here so the level policy lives in one place.
 */
export function logProvideFailure(
  logger: { debug(message: string): void; error(message: string): void },
  err: unknown,
  msg: string
): void {
  const line = `${msg}: ${describeP2PError(err)}`
  if (classifyP2PError(err).name === P2P_ERROR.timeout) {
    logger.debug(line)
  } else {
    logger.error(line)
  }
}
