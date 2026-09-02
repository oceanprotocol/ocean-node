import * as cron from 'node-cron'

// node-cron v4 SKIPS (does not run, just logs "missed execution") any execution whose heartbeat
// lands more than `missedExecutionTolerance` after the scheduled boundary. The default is a mere
// 1000ms, and the ocean-node process keeps its event loop steadily busy (the indexer polls every
// ~1s, plus p2p), so under load effectively every boundary lands late and the job is dropped every
// time — with no error from the job body, because its callback never runs.
//
// Every cron job in this repo is idempotent and catch-up-safe, so we never want to skip a run just
// because the process was momentarily busy. Default the tolerance high (24h). node-cron's own
// `lateBy < gap` guard still bounds each job to its own interval — so there is no backlog or double
// run — which for every job here (all run at most daily) simply means "run whenever it becomes due
// this interval". A caller can still override via `options`.
//
// Route ALL cron scheduling through this wrapper so the v4 skip cannot silently disable a job.
const DEFAULT_MISSED_EXECUTION_TOLERANCE_MS = 24 * 60 * 60 * 1000

export function scheduleCron(
  expression: string,
  func: Parameters<typeof cron.schedule>[1],
  options: Parameters<typeof cron.schedule>[2] = {}
): ReturnType<typeof cron.schedule> {
  return cron.schedule(expression, func, {
    missedExecutionTolerance: DEFAULT_MISSED_EXECUTION_TOLERANCE_MS,
    ...options
  })
}
