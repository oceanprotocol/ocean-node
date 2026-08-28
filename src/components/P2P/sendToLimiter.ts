import pLimit from 'p-limit'
import { P2P_TIMEOUTS } from './timeouts.js'

/**
 * The concurrency ceiling on outbound `sendTo` calls.
 *
 * Why it has to exist. A `sendTo` occupies a slot in libp2p's dial queue for its whole setup
 * phase, and two paths in this node fan out without any bound of their own: FindDDO queries
 * every provider it found for a DDO, and the indexer's decrypt loop issues a send per DDO it
 * processes. Neither knows about the other, and neither knows how many other requests are in
 * flight, so under load they can put more dials in flight than the dial queue is configured to
 * run - at which point the dials queue behind each other, every one of them still spending its
 * own stage budget, and unrelated traffic (bootstrap reconnects, discovery dials, the DHT's own
 * walks) queues behind them. The symptom is not a failure but latency that grows with
 * unrelated load, which is the hardest kind to attribute.
 *
 * Why 25 by default:
 *
 *   - it is half of `connectionsMaxParallelDials` (50), so a fully saturated command fan-out
 *     still leaves half the dial queue for everything that is not a command - discovery dials,
 *     bootstrap reconnects, DHT queries - rather than starving them;
 *   - it is five whole FindDDO fan-outs at the provider maximum of 5, so the concurrent-provider
 *     query this bound exists alongside is never throttled by it in the single-request case,
 *     which is the case whose latency a user sees;
 *   - it is well under `maxDialQueueLength` (500), so reaching the ceiling means sends wait
 *     here, in a FIFO queue with no timers running, instead of waiting in the dial queue with
 *     their stage budgets ticking.
 *
 * Waiting here rather than in the dial queue is the substantive difference: a send that queues
 * on this limiter has not yet created its deadline, so time spent queued is not charged against
 * its budget. That is a deliberate property of the call site - the deadline is created inside
 * the limited function, not around it - and it is what makes a queue that is occasionally deep
 * safe rather than a way to convert load into timeouts.
 *
 * Cost, stated so nobody rediscovers it as a bug: `p-limit` is a plain FIFO with no fairness or
 * priority, so a burst of N sends queued first delays a send that arrives afterwards. The queue
 * drains predictably only because every `sendTo` bounds its own setup phase; it would not if a
 * send could occupy a slot indefinitely.
 *
 * Wiring rule, the same one the provide limiter carries: apply this at **one** level only.
 * `p-limit` deadlocks when a task running inside the limiter queues another task on the same
 * limiter, so nothing reached from inside a `sendTo` may call `sendToLimit` again.
 */
const limiter = pLimit(P2P_TIMEOUTS.sendToMaxConcurrency)

/**
 * Runs `fn` once a slot is free.
 *
 * The ceiling is re-read from the budget getters on every call rather than captured at import
 * time, for the same reason every other budget in this subsystem is: a module-level `const` is
 * fixed when the module graph loads, which makes it unoverridable by anything that sets the
 * environment afterwards - including a test. `p-limit` accepts a new `concurrency` at any time
 * and applies it as slots free up, so lowering it never cancels work already running.
 */
export async function sendToLimit<T>(fn: () => Promise<T>): Promise<T> {
  const configured = P2P_TIMEOUTS.sendToMaxConcurrency
  if (limiter.concurrency !== configured) {
    limiter.concurrency = configured
  }
  return await limiter(fn)
}

/** Live queue occupancy, for the network-stats output. */
export function sendToLimiterStats(): {
  concurrency: number
  active: number
  queued: number
} {
  return {
    concurrency: P2P_TIMEOUTS.sendToMaxConcurrency,
    active: limiter.activeCount,
    queued: limiter.pendingCount
  }
}
