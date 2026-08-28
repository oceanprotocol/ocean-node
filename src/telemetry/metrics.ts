/**
 * Every OTel instrument the node emits, defined once at module load.
 *
 * This module depends on `@opentelemetry/api` **only** — never on the SDK. Without a registered
 * provider the API returns no-op instruments, so `add()` calls at the P2P/compute call sites and
 * the observable-gauge callbacks cost approximately nothing when telemetry is unconfigured. That is
 * what lets the instrumentation be unconditional at the call sites and conditional only in the
 * `--import` bootstrap (`otel.ts`).
 *
 * The instrument **names** here are a contract: the P2P and compute call-site modules and the
 * shipped Grafana dashboards depend on them. Do not rename an instrument without updating both.
 */
import { metrics, type Attributes } from '@opentelemetry/api'

/**
 * Exported so the observable-gauge callback modules (`p2pGauges.ts`, `computeGauges.ts`) register
 * their batch callbacks against the **same** meter instance that created the instruments — meters
 * are keyed by name+version, so `getMeter('ocean-node')` would be a different instance.
 */
export const meter = metrics.getMeter(
  'ocean-node',
  process.env.npm_package_version || '0.0.0'
)

/* ── P2P counters ─────────────────────────────────────────────────────────────── */

export const p2pPeerConnect = meter.createCounter('ocean.p2p.peer.connect', {
  description: 'libp2p peer connections established',
  unit: '{event}'
})

export const p2pPeerDisconnect = meter.createCounter('ocean.p2p.peer.disconnect', {
  description: 'libp2p peer disconnections',
  unit: '{event}'
})

export const p2pPeerDiscovery = meter.createCounter('ocean.p2p.peer.discovery', {
  description: 'libp2p peers discovered',
  unit: '{event}'
})

export const p2pSendTo = meter.createCounter('ocean.p2p.sendto', {
  description: 'Cross-node sendTo calls, by outcome and failure reason',
  unit: '{call}'
})

export const p2pResolve = meter.createCounter('ocean.p2p.resolve', {
  description: 'Peer address resolutions, by result (peerstore hit / dht hit / miss)',
  unit: '{lookup}'
})

export const p2pDhtProvide = meter.createCounter('ocean.p2p.dht.provide', {
  description: 'DHT provide operations, by outcome',
  unit: '{op}'
})

export const p2pDhtFind = meter.createCounter('ocean.p2p.dht.find', {
  description: 'DHT find operations, by kind (providers/peer) and outcome',
  unit: '{op}'
})

export const p2pCommand = meter.createCounter('ocean.p2p.command', {
  description: 'Inbound protocol commands, by command and outcome',
  unit: '{command}'
})

export const p2pCertEvent = meter.createCounter('ocean.p2p.cert.event', {
  description: 'AutoTLS certificate events, by type (provision/renew)',
  unit: '{event}'
})

/* ── Compute counters ─────────────────────────────────────────────────────────── */

export const cJobsStarted = meter.createCounter('ocean.compute.jobs.started', {
  description: 'Compute jobs started, paid and free',
  unit: '{job}'
})

export const cJobsFinished = meter.createCounter('ocean.compute.jobs.finished', {
  description: 'Compute jobs reaching a terminal state, by status',
  unit: '{job}'
})

/* ── P2P observable gauges (callbacks attached in p2pGauges.ts) ───────────────── */

export const p2pConnections = meter.createObservableGauge('ocean.p2p.connections', {
  description: 'Live libp2p connections, by direction',
  unit: '{connection}'
})

// `limited` (relayed) connections are a subset that cuts across direction; the pre-aggregated
// connectionBreakdown does not carry the direction x limited crosstab, so reporting it as a
// facet of p2pConnections would create a phantom direction="" series and double-count in a
// bare sum(). Kept as its own gauge instead.
export const p2pConnectionsLimited = meter.createObservableGauge(
  'ocean.p2p.connections_limited',
  {
    description: 'Live libp2p connections that are limited (relayed)',
    unit: '{connection}'
  }
)

export const p2pRoutingTablePeers = meter.createObservableGauge(
  'ocean.p2p.dht.routing_table_peers',
  {
    description: 'Peers in the DHT routing table',
    unit: '{peer}'
  }
)

// No `unit` on the 0/1 and capacity gauges below: the OTLP->Prometheus translation
// appends a `_ratio` suffix to any instrument whose unit is '1', which would rename the
// series (e.g. ocean_p2p_ready_ratio) and break both the dashboards and the $node var.
export const p2pDhtMode = meter.createObservableGauge('ocean.p2p.dht.mode', {
  description: 'DHT mode: 1 = server, 0 = client'
})

export const p2pReady = meter.createObservableGauge('ocean.p2p.ready', {
  description: 'Whether the P2P interface is ready: 1 = ready, 0 = not'
})

export const p2pDialQueue = meter.createObservableGauge('ocean.p2p.dial_queue', {
  description: 'Depth of the libp2p dial queue, by status',
  unit: '{dial}'
})

export const p2pRelayReservations = meter.createObservableGauge(
  'ocean.p2p.relay_reservations',
  {
    description: 'Circuit-relay reservations held on and granted to relays',
    unit: '{reservation}'
  }
)

export const p2pAutotlsExpiry = meter.createObservableGauge(
  'ocean.p2p.autotls.cert_expiry',
  {
    description: 'Seconds until the autoTLS certificate expires',
    unit: 's'
  }
)

export const p2pResolutionCacheSize = meter.createObservableGauge(
  'ocean.p2p.resolution_cache.size',
  {
    description: 'Entries in the peer-resolution cache, by state',
    unit: '{entry}'
  }
)

export const p2pOutboundQueue = meter.createObservableGauge(
  'ocean.p2p.outbound_send.queue',
  {
    description: 'Outbound sendTo calls queued behind the concurrency limiter',
    unit: '{call}'
  }
)

/* ── Compute observable gauges (callbacks attached in computeGauges.ts) ───────── */

export const cCpuUsage = meter.createObservableGauge('ocean.compute.cpu.usage_percent', {
  description: 'Aggregate CPU usage across sampled compute containers',
  unit: '%'
})

export const cCoresAllocated = meter.createObservableGauge(
  'ocean.compute.cpu.cores_allocated',
  {
    description: 'CPU cores allocated across compute containers',
    unit: '{core}'
  }
)

export const cHostCores = meter.createObservableGauge('ocean.compute.cpu.host_cores', {
  description: 'Physical CPU cores available to the engine host',
  unit: '{core}'
})

export const cThrottled = meter.createObservableGauge(
  'ocean.compute.cpu.throttled_containers',
  {
    description: 'Compute containers that were CPU-throttled',
    unit: '{container}'
  }
)

export const cMemUsed = meter.createObservableGauge('ocean.compute.memory.used_bytes', {
  description: 'Aggregate memory used across compute containers',
  unit: 'By'
})

export const cMemLimit = meter.createObservableGauge('ocean.compute.memory.limit_bytes', {
  description: 'Aggregate memory limit across compute containers',
  unit: 'By'
})

export const cDiskUsed = meter.createObservableGauge('ocean.compute.disk.used_bytes', {
  description: 'Aggregate disk used across compute containers',
  unit: 'By'
})

export const cNetRx = meter.createObservableGauge('ocean.compute.network.rx_bytes', {
  description: 'Aggregate network bytes received (point-in-time snapshot)',
  unit: 'By'
})

export const cNetTx = meter.createObservableGauge('ocean.compute.network.tx_bytes', {
  description: 'Aggregate network bytes transmitted (point-in-time snapshot)',
  unit: 'By'
})

export const cSampled = meter.createObservableGauge('ocean.compute.sampled_containers', {
  description: 'Compute containers included in the latest metrics sample',
  unit: '{container}'
})

export const cSampleAge = meter.createObservableGauge(
  'ocean.compute.oldest_sample_age_seconds',
  {
    description: 'Age of the oldest container sample; a freshness guard',
    unit: 's'
  }
)

export const cJobsRunning = meter.createObservableGauge('ocean.compute.jobs.running', {
  description: 'Compute jobs currently running, by free flag',
  unit: '{job}'
})

export const cJobsQueued = meter.createObservableGauge('ocean.compute.jobs.queued', {
  description: 'Compute jobs currently queued, by free flag',
  unit: '{job}'
})

export const cGpuDevices = meter.createObservableGauge(
  'ocean.compute.gpu.devices_in_use',
  {
    description: 'Distinct GPU devices in use',
    unit: '{device}'
  }
)

export const cGpuUtil = meter.createObservableGauge(
  'ocean.compute.gpu.utilization_percent',
  {
    description: 'Per-GPU utilization',
    unit: '%'
  }
)

export const cGpuMemUsed = meter.createObservableGauge(
  'ocean.compute.gpu.memory_used_bytes',
  {
    description: 'Per-GPU memory used',
    unit: 'By'
  }
)

export const cGpuMemTotal = meter.createObservableGauge(
  'ocean.compute.gpu.memory_total_bytes',
  {
    description: 'Per-GPU total memory',
    unit: 'By'
  }
)

export const cGpuTemp = meter.createObservableGauge(
  'ocean.compute.gpu.temperature_celsius',
  {
    description: 'Per-GPU temperature',
    unit: 'Cel'
  }
)

export const cGpuPower = meter.createObservableGauge('ocean.compute.gpu.power_watts', {
  description: 'Per-GPU power draw',
  unit: 'W'
})

export const cEnvTotal = meter.createObservableGauge('ocean.compute.env.resource_total', {
  description: 'Declared resource capacity per compute environment'
})

export const cEnvInUse = meter.createObservableGauge('ocean.compute.env.resource_inuse', {
  description: 'Resource in use per compute environment'
})

/** Narrow alias so call sites cannot accidentally pass an unbounded value as an attribute. */
export type MetricAttributes = Attributes
