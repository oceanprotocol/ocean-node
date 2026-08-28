import pLimit from 'p-limit'

/**
 * The single concurrency ceiling for bulk `advertiseString` / `contentRouting.provide()` work.
 *
 * Why one shared limiter at all: four independent code paths provide in bulk - the DDO
 * republish cron, the C2D capability cron, `storeAndAdvertiseDDOS` and the pending-advertise
 * queue flush - and each used to carry its own bound (or none). Two module-level `pLimit(3)`s,
 * one `pLimit(5)` constructed *per invocation* (so unbounded across concurrent calls) and one
 * sequential loop add up to `3 + 3 + 5xN + 1`, which is not a ceiling. Sharing one limiter
 * makes the ceiling the ceiling.
 *
 * Why the cost matters: one `advertiseString` is one `contentRouting.provide()`, which is a
 * full `getClosestPeers` walk (alpha = 3 concurrent queries) followed by a PUT to each of the
 * k = 20 peers it returns. Concurrency therefore multiplies by ~20 in outbound DHT streams,
 * and those streams compete with command traffic and the dial queue on the same connection
 * manager.
 *
 * Why 5:
 *   - it puts the worst case at ~100 concurrent provider-record PUTs plus ~15 walk queries,
 *     against a default `maxConnections` of 300 - enough headroom that a republish cannot
 *     starve inbound commands or the indexer;
 *   - it is below the 6 the two crons alone could already reach when their ceilings were
 *     separate, so consolidating does not raise the observed peak;
 *   - it is not lower than 5 because `storeAndAdvertiseDDOS` - the user-facing publish path,
 *     and the one whose latency is visible - was already bounded at 5, and that path usually
 *     runs alone: the crons fire every 4 hours. Dropping to 3 would have slowed the common
 *     case in order to bound a rare overlap.
 *
 * Cost of sharing, stated so nobody rediscovers it as a bug: `p-limit` is a plain FIFO queue
 * with no fairness or priority. A cron batch of N items queued first delays a publish that
 * arrives second by up to `ceil(N / 5) x P2P_TIMEOUTS.advertiseMs` in the pathological case
 * where every provide burns its full budget. The queue still drains predictably precisely
 * because `advertiseString` passes that budget to `provide()`; it would not if provides were
 * unbounded in time.
 *
 * Wiring rule - apply this limiter at *one* level only. `p-limit` deadlocks if a task running
 * inside the limiter queues another task on the same limiter, so a call site wrapped here must
 * not also be wrapped by a caller that is itself wrapped here, and the limiter must not be
 * pushed down inside `advertiseString` while call sites still wrap it.
 */
export const PROVIDE_CONCURRENCY = 5

/**
 * The shared limiter. Module-level on purpose: it is created once at import time and shared by
 * every importer and every invocation, so an overlapping cron tick queues behind the previous
 * one instead of doubling the ceiling. There is deliberately no initialiser and no
 * configuration to thread through - importing it is the whole wiring step.
 */
export const provideLimit = pLimit(PROVIDE_CONCURRENCY)
