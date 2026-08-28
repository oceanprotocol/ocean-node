import { expect } from 'chai'
import {
  ConnectionClosedError,
  ConnectionFailedError,
  LimitedConnectionError,
  MuxerClosedError,
  NotFoundError,
  StreamResetError,
  TooManyInboundProtocolStreamsError,
  UnexpectedPeerError,
  UnsupportedProtocolError
} from '@libp2p/interface'
import {
  P2P_ERROR,
  P2PError,
  RETRY_BACKOFF_BASE_MS,
  RETRY_BACKOFF_CAP_MS,
  classifyP2PError,
  delayBeforeRetry,
  isRetryableP2PError,
  retryDelayMs
} from '../../../components/P2P/errors.js'

/**
 * The retry path used to decide whether a failure was worth another attempt by testing whether
 * the error's *message* contained "closed" or "reset". Every case here is one of the two ways
 * that goes wrong, driven through the real error classes libp2p throws rather than through
 * hand-written stand-ins - so a dependency that renames an error class fails this file, which
 * is the point.
 */

const substringPredicate = (err: Error): boolean =>
  err.message?.includes('closed') === true || err.message?.includes('reset') === true

describe('P2P failures are classified by error name, not message text', () => {
  it('recognises a dead connection whose message says neither closed nor reset', () => {
    // The case the substring predicate missed outright, and the reason it existed: this is a
    // connection that has to be dropped and re-dialled, and it was never retried.
    const err = new ConnectionFailedError('connection to peer could not be established')

    expect(
      substringPredicate(err),
      'the old predicate must be provably blind here'
    ).to.equal(false)
    expect(classifyP2PError(err).name).to.equal(P2P_ERROR.dialFailed)
    expect(isRetryableP2PError(classifyP2PError(err).name)).to.equal(true)
  })

  it('does not treat an unrelated failure as a dead connection because of its wording', () => {
    // The other direction: a protocol failure that happens to mention a closed something. Under
    // the substring predicate this was retried as if the connection were stale, which spent a
    // second dial and a second negotiation to be told the same thing.
    const err = new UnsupportedProtocolError(
      'the remote closed the stream: protocol /ocean/nodes/1.0.0 not supported'
    )

    expect(
      substringPredicate(err),
      'the old predicate must be provably fooled here'
    ).to.equal(true)
    expect(classifyP2PError(err).name).to.equal(P2P_ERROR.protocolFailed)
    expect(isRetryableP2PError(classifyP2PError(err).name)).to.equal(false)
  })

  it('maps every dead-transport error onto the category whose fix is a fresh dial', () => {
    for (const err of [
      new ConnectionClosedError(),
      new MuxerClosedError(),
      new StreamResetError()
    ]) {
      expect(classifyP2PError(err).name, err.name).to.equal(P2P_ERROR.dialFailed)
    }
  })

  it('maps a healthy connection with a failed protocol leg onto protocol_failed', () => {
    for (const err of [
      new UnsupportedProtocolError(),
      new LimitedConnectionError(),
      new TooManyInboundProtocolStreamsError()
    ]) {
      expect(classifyP2PError(err).name, err.name).to.equal(P2P_ERROR.protocolFailed)
    }
  })

  it('maps an expired budget onto timeout, whether it came from a timer or an abort', () => {
    const fromTimer = new Error('the operation timed out')
    fromTimer.name = 'TimeoutError'
    const fromAbort = new Error('This operation was aborted')
    fromAbort.name = 'AbortError'

    expect(classifyP2PError(fromTimer).name).to.equal(P2P_ERROR.timeout)
    expect(classifyP2PError(fromAbort).name).to.equal(P2P_ERROR.timeout)
  })

  it('maps the wrong peer on the wire onto peer_mismatch, and a missing peer onto resolve_failed', () => {
    expect(classifyP2PError(new UnexpectedPeerError()).name).to.equal(
      P2P_ERROR.peerMismatch
    )
    expect(classifyP2PError(new NotFoundError()).name).to.equal(P2P_ERROR.resolveFailed)
  })

  it('sees through one layer of wrapping to the reason a signal aborted', () => {
    // libp2p wraps an abort reason rather than replacing it, so the classification has to look
    // at the cause as well as at the error itself.
    const reason = new Error('deadline reached')
    reason.name = 'TimeoutError'
    const wrapper = new Error('dial aborted', { cause: reason })
    wrapper.name = 'DialError'

    expect(classifyP2PError(wrapper).name).to.equal(P2P_ERROR.timeout)
  })

  it('labels an unrecognised error with the category of the stage it came from', () => {
    // Nothing can be known about an unfamiliar error except where it happened, and guessing
    // from the message is the practice this module removes.
    const anonymous = new Error('something went wrong')
    expect(classifyP2PError(anonymous, P2P_ERROR.protocolFailed).name).to.equal(
      P2P_ERROR.protocolFailed
    )
    expect(classifyP2PError(anonymous, P2P_ERROR.dialFailed).name).to.equal(
      P2P_ERROR.dialFailed
    )
  })

  it('leaves an already-classified failure alone', () => {
    const already = new P2PError(P2P_ERROR.peerMismatch, 'wrong peer')
    expect(classifyP2PError(already, P2P_ERROR.dialFailed)).to.equal(already)
  })
})

describe('only the failures a second attempt can change are retried', () => {
  it('retries a timeout and a dead connection, and nothing else', () => {
    expect(isRetryableP2PError(P2P_ERROR.timeout)).to.equal(true)
    expect(isRetryableP2PError(P2P_ERROR.dialFailed)).to.equal(true)
    // A healthy connection that refused the protocol refuses it again; the same address reaches
    // the same wrong peer; and resolution has already walked every tier it has.
    expect(isRetryableP2PError(P2P_ERROR.protocolFailed)).to.equal(false)
    expect(isRetryableP2PError(P2P_ERROR.peerMismatch)).to.equal(false)
    expect(isRetryableP2PError(P2P_ERROR.resolveFailed)).to.equal(false)
  })
})

describe('retry back-off is jittered', () => {
  it('charges the first attempt nothing', () => {
    expect(retryDelayMs(1)).to.equal(0)
  })

  it('spreads waits across the window instead of firing them together', () => {
    // A fixed back-off re-synchronises every retrying fan-out into one burst against the peers
    // that just failed. Distinct values across a sample is what shows the jitter is real.
    const samples = new Set<number>()
    for (let i = 0; i < 200; i++) {
      samples.add(retryDelayMs(3))
    }
    expect(
      samples.size,
      'a fixed back-off would produce a single value'
    ).to.be.greaterThan(10)
    for (const sample of samples) {
      expect(sample).to.be.at.least(0)
      expect(sample).to.be.below(
        Math.min(RETRY_BACKOFF_CAP_MS, RETRY_BACKOFF_BASE_MS * 2)
      )
    }
  })

  it('grows the window with the attempt and stops at the cap', () => {
    const windowFor = (attempt: number): number => {
      let max = 0
      for (let i = 0; i < 500; i++) {
        max = Math.max(max, retryDelayMs(attempt))
      }
      return max
    }
    expect(windowFor(3)).to.be.greaterThan(windowFor(2))
    // Attempt 20 would be base * 2^18 without the cap.
    expect(retryDelayMs(20)).to.be.below(RETRY_BACKOFF_CAP_MS)
  })

  it('stops waiting when the deadline fires, and does not turn that into an error', () => {
    const controller = new AbortController()
    const started = Date.now()
    const waited = delayBeforeRetry(5_000, controller.signal)
    controller.abort(new Error('deadline'))
    return waited.then(() => {
      expect(Date.now() - started, 'the wait must be cut short').to.be.below(1_000)
    })
  })
})
