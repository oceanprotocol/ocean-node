// Env-parsing helpers for the node-metrics history feature. Deliberately free of any cron or DB
// import so both the cron scheduler (`cronjobs/nodeMetricsJobs.ts`) and the history request
// handler (`core/handler/nodeMetrics.ts`) can depend on them without coupling a request handler to
// the scheduler module.
import { ENVIRONMENT_VARIABLES } from './constants.js'

const DEFAULT_RETENTION_DAYS = 180

export function getMetricsRetentionDays(): number {
  const raw = ENVIRONMENT_VARIABLES.NODE_METRICS_RETENTION_DAYS.value
  if (raw === undefined || raw === null || raw === '') return DEFAULT_RETENTION_DAYS
  const parsed = parseInt(String(raw), 10)
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_RETENTION_DAYS
  return parsed
}

// Enabled unless explicitly turned off. The caller is responsible for only scheduling when a DB
// is present, so "default on when DB present" is satisfied by this returning true by default.
export function isNodeMetricsHistoryEnabled(): boolean {
  const raw = ENVIRONMENT_VARIABLES.NODE_METRICS_HISTORY_ENABLED.value
  if (raw === undefined || raw === null || raw === '') return true
  const normalized = String(raw).trim().toLowerCase()
  return !(normalized === 'false' || normalized === '0' || normalized === 'no')
}
