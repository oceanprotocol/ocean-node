/**
 * OpenTelemetry bootstrap.
 *
 * Loaded via `node --import ./dist/telemetry/otel.js` (see the `start` script and the Dockerfile
 * `CMD`) so the SDK is running **before** `express`/`http` are imported — HTTP/Express
 * auto-instrumentation cannot patch modules that are already loaded.
 *
 * Importing this module is always safe: `initTelemetry()` self-disables unless an OTLP endpoint is
 * configured, so an unconfigured process pays nothing and emits nothing. A telemetry failure is
 * caught and logged; it must never crash the node.
 *
 * No signal handlers are registered here on purpose — `index.ts` owns SIGINT/SIGTERM and awaits
 * `shutdownTelemetry()` before exit, so the final metric batch flushes deterministically.
 */
import { NodeSDK } from '@opentelemetry/sdk-node'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http'
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http'
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics'
import { resourceFromAttributes } from '@opentelemetry/resources'
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http'
import { ExpressInstrumentation } from '@opentelemetry/instrumentation-express'
import { RuntimeNodeInstrumentation } from '@opentelemetry/instrumentation-runtime-node'
import { HostMetrics } from '@opentelemetry/host-metrics'
import { randomUUID } from 'node:crypto'

import { telemetryConfig, type TelemetryConfig } from './config.js'
import { telemetryLog } from './log.js'
import { derivePeerIdFromEnv } from './peerId.js'

let sdk: NodeSDK | undefined
let started = false

export function initTelemetry(
  instanceId: string,
  env: NodeJS.ProcessEnv = process.env
): TelemetryConfig | undefined {
  if (started) return telemetryConfig()
  started = true

  const config = telemetryConfig(env)

  if (!config.enabled) {
    if (config.disabledReason) telemetryLog(`disabled — ${config.disabledReason}`)
    return config
  }

  try {
    const resource = resourceFromAttributes({
      'service.name': config.serviceName,
      'service.version': config.serviceVersion,
      'deployment.environment': config.environment,
      'service.instance.id': instanceId,
      'ocean.node.role': config.role,
      ...(config.networkLabel ? { 'ocean.network': config.networkLabel } : {})
    })

    sdk = new NodeSDK({
      resource,
      traceExporter: new OTLPTraceExporter(),
      metricReader: new PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter(),
        exportIntervalMillis: config.exportIntervalMs
      }),
      instrumentations: [
        new HttpInstrumentation({
          ignoreIncomingRequestHook: (req) => req.url === '/health'
        }),
        new ExpressInstrumentation(),
        // V8 heap used/limit, event-loop delay and GC — the heap-headroom panel needs the V8
        // limit, which reflects `--max-old-space-size` and is not covered by host-metrics.
        new RuntimeNodeInstrumentation()
      ]
    })

    sdk.start()

    new HostMetrics({ name: config.serviceName }).start()

    telemetryLog(
      `enabled — exporting to ${config.endpoint} as ${config.serviceName} (${config.role})`
    )
  } catch (error) {
    // A telemetry failure must never take the node down.
    telemetryLog('failed to initialize — continuing without telemetry', error)
  }

  return config
}

export async function shutdownTelemetry(): Promise<void> {
  if (!sdk) return
  try {
    await sdk.shutdown()
  } catch (error) {
    telemetryLog('shutdown failed', error)
  }
}

// Auto-start when loaded via `--import`. The peerId is the canonical per-node identity
// (`service.instance.id`); it is derived from `PRIVATE_KEY` before libp2p starts. Top-level await
// resolves it before the SDK is constructed, guarded so a derivation failure falls back to a random
// UUID and never blocks startup.
let resolvedInstanceId: string | undefined
try {
  resolvedInstanceId = await derivePeerIdFromEnv()
} catch (error) {
  telemetryLog('peerId derivation threw — falling back to random instance id', error)
}
initTelemetry(resolvedInstanceId || randomUUID())
