// Node-metrics history cron jobs: a minute sampler, an hourly roll-up, and a daily retention
// sweep. Each job is guarded so a failure can never stop the node, mirroring the other cron
// jobs in `scheduleCronJobs.ts`.

import { scheduleCron } from './scheduleCron.js'
import { Database } from '../../components/database/index.js'
import { OceanNode } from '../../OceanNode.js'
import { ENVIRONMENT_VARIABLES } from '../constants.js'
import { OCEAN_NODE_LOGGER } from '../logging/common.js'
import {
  collectNodeMetricsSnapshot,
  hasFreshAggregate
} from '../../components/core/utils/nodeMetricsHandler.js'
import { floorToHour } from '../../components/database/sqliteNodeMetrics.js'
import {
  getMetricsRetentionDays,
  isNodeMetricsHistoryEnabled
} from '../nodeMetricsConfig.js'

// Re-exported so existing importers keep working; the canonical home is `nodeMetricsConfig.ts`,
// which the request handler imports directly to avoid depending on this scheduler module.
export { getMetricsRetentionDays, isNodeMetricsHistoryEnabled }

const HOUR_MS = 60 * 60 * 1000
const DEFAULT_SAMPLE_CRON = '* * * * *'
// Raw minute samples are consumed by the hourly roll-up; this is only the safety window after
// which any leftover samples are purged unconditionally.
const SAMPLE_BUFFER_MS = 3 * HOUR_MS
// Don't emit a "skipped, no fresh aggregate" warning more than once per hour.
const SKIP_WARN_INTERVAL_MS = HOUR_MS

let lastSkipWarnAt = 0

function getSampleCronExpression(): string {
  return (
    ENVIRONMENT_VARIABLES.NODE_METRICS_SAMPLE_CRON.value?.toString() ||
    DEFAULT_SAMPLE_CRON
  )
}

export function scheduleNodeMetricsJobs(node: OceanNode, dbconn: Database | null): void {
  if (!isNodeMetricsHistoryEnabled()) {
    OCEAN_NODE_LOGGER.info(
      'Node metrics history CronJob: disabled via NODE_METRICS_HISTORY_ENABLED (skipped).'
    )
    return
  }
  if (!dbconn || !dbconn.nodeMetrics) {
    OCEAN_NODE_LOGGER.warn(
      'Node metrics history CronJob: node metrics database not available (skipped).'
    )
    return
  }
  const db = dbconn.nodeMetrics

  // 1. Minute sampler
  scheduleCron(getSampleCronExpression(), () => {
    try {
      // Warn-and-skip when there is no fresh compute aggregate (metrics collection disabled or
      // no engine has sampled yet). Persisting all-zero rows would skew hourly averages.
      if (!hasFreshAggregate(node)) {
        const now = Date.now()
        if (now - lastSkipWarnAt >= SKIP_WARN_INTERVAL_MS) {
          lastSkipWarnAt = now
          OCEAN_NODE_LOGGER.warn(
            'Node metrics sampler: no fresh compute aggregate (C2D metrics collection disabled ' +
              'or no engine sampled yet) — skipping sample. This warning is rate-limited.'
          )
        }
        return
      }
      const snapshot = collectNodeMetricsSnapshot(node)
      db.insertSample(snapshot)
    } catch (err) {
      OCEAN_NODE_LOGGER.error(
        `Node metrics sampler error: ${err instanceof Error ? err.message : String(err)}`
      )
    }
  })

  // 2. Hourly roll-up at :05 — average each complete hour's samples, then drop consumed rows.
  scheduleCron('5 * * * *', () => {
    try {
      const currentHour = floorToHour(Date.now())
      const pending = db.getPendingSampleHours(currentHour)
      let rolled = 0
      for (const hour of pending) {
        if (db.rollupHour(hour)) rolled++
      }
      // Safety net for any orphaned samples the roll-up did not consume.
      const purged = db.purgeOldSamples(Date.now() - SAMPLE_BUFFER_MS)
      if (rolled > 0 || purged > 0) {
        OCEAN_NODE_LOGGER.info(
          `Node metrics roll-up: ${rolled} hour(s) aggregated, ${purged} stale sample(s) purged.`
        )
      }
    } catch (err) {
      OCEAN_NODE_LOGGER.error(
        `Node metrics roll-up error: ${err instanceof Error ? err.message : String(err)}`
      )
    }
  })

  // 3. Daily retention sweep at 03:07.
  scheduleCron('7 3 * * *', () => {
    try {
      const cutoff = Date.now() - getMetricsRetentionDays() * 24 * HOUR_MS
      const deleted = db.deleteHourlyOlderThan(cutoff)
      if (deleted > 0) {
        OCEAN_NODE_LOGGER.info(
          `Node metrics retention: deleted ${deleted} hourly row(s) older than ${getMetricsRetentionDays()} days.`
        )
      }
    } catch (err) {
      OCEAN_NODE_LOGGER.error(
        `Node metrics retention error: ${err instanceof Error ? err.message : String(err)}`
      )
    }
  })

  OCEAN_NODE_LOGGER.info(
    `Node metrics history CronJob scheduled (sampler "${getSampleCronExpression()}", ` +
      `retention ${getMetricsRetentionDays()} days).`
  )
}
