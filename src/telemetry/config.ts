/**
 * Telemetry configuration, parsed once from the environment.
 *
 * Telemetry is a **hard no-op unless configured**: the SDK only starts when
 * `OTEL_EXPORTER_OTLP_ENDPOINT` is set and `TELEMETRY_ENABLED` is not `off`. This module reads
 * `process.env` directly and depends on neither the OTel SDK nor the node's config builder, so
 * importing it can never pull the SDK into the import graph ahead of the `--import` bootstrap, and
 * an unconfigured process pays nothing.
 */

export interface TelemetryConfig {
  /** Master switch: an OTLP endpoint is set and telemetry is not explicitly disabled. */
  enabled: boolean
  endpoint?: string
  serviceName: string
  serviceVersion: string
  environment: string
  exportIntervalMs: number
  role: string
  networkLabel?: string
  /** Why telemetry is off, for a one-line startup log. `undefined` when enabled. */
  disabledReason?: string
}

/**
 * Positive **integer** milliseconds, or the fallback.
 *
 * An unset var is fine, but `X=""` yields `0` and `X=abc` yields `NaN`; both then reach an OTel
 * interval as a busy-loop or a throw. Integrality is part of the contract: `0.1` is finite and
 * positive but a 0.1 ms export interval is a busy loop, which this helper exists to prevent.
 */
export function readPositiveInt(v: string | undefined, dflt: number): number {
  if (v === undefined || v.trim() === '') return dflt
  const n = Number(v)
  if (!Number.isInteger(n) || n <= 0) return dflt
  return n
}

let cached: TelemetryConfig | undefined

export function telemetryConfig(env: NodeJS.ProcessEnv = process.env): TelemetryConfig {
  if (cached) return cached
  const endpoint = env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim() || undefined
  const enabled = env.TELEMETRY_ENABLED !== 'off' && !!endpoint
  cached = {
    enabled,
    endpoint,
    serviceName: env.OTEL_SERVICE_NAME?.trim() || 'ocean-node',
    serviceVersion: process.env.npm_package_version || '0.0.0',
    environment: env.DEPLOYMENT_ENVIRONMENT || env.NODE_ENV || 'development',
    exportIntervalMs: readPositiveInt(env.OTEL_METRIC_EXPORT_INTERVAL, 60_000),
    role: process.env.ROLE?.trim() || 'node',
    networkLabel: env.OCEAN_NETWORK_LABEL?.trim() || undefined,
    disabledReason: enabled
      ? undefined
      : 'OTEL_EXPORTER_OTLP_ENDPOINT unset or TELEMETRY_ENABLED=off'
  }
  return cached
}

/** Test-only: drop the memoized config so a test can re-parse a mutated environment. */
export function resetTelemetryConfigForTest(): void {
  cached = undefined
}
