# Telemetry: metrics & traces for `ocean-node`

How to get P2P and compute-resource metrics out of a running `ocean-node` and into Grafana.

Telemetry is **push-based OpenTelemetry** (OTLP), matching Ocean's `on-mcp` server: the node
pushes to an OpenTelemetry Collector, which fans out to Prometheus (metrics) and Tempo (traces),
which Grafana reads. There is no `/metrics` scrape endpoint on the node — a bootstrap's admin
server is loopback-only, and the node's HTTP API is optional, so neither is reliably scrapeable
from outside its network namespace.

**Telemetry is a hard no-op until configured.** The `telemetry/` module depends only on
`@opentelemetry/api`; unless `OTEL_EXPORTER_OTLP_ENDPOINT` is set and `TELEMETRY_ENABLED` isn't
`off`, every instrument is a no-op and nothing is sent over the network. Only
`OTEL_EXPORTER_OTLP_ENDPOINT` controls whether telemetry is enabled — the OTel SDK still honors the
standard per-signal `OTEL_EXPORTER_OTLP_{TRACES,METRICS}_ENDPOINT` variables for routing once
enabled, but setting only those (without the base endpoint) does not turn telemetry on. Existing
deployments are unaffected until an operator opts in.

---

## Contents

- [A. Architecture](#a-architecture)
- [B. Deployment modes](#b-deployment-modes)
- [C. Env vars](#c-env-vars)
- [D. Run the local stack](#d-run-the-local-stack)
- [E. Metric catalog — P2P](#e-metric-catalog--p2p)
- [F. Metric catalog — Compute resources](#f-metric-catalog--compute-resources)
- [G. OTel → Prometheus name mangling](#g-otel--prometheus-name-mangling)
- [H. Cardinality & privacy rules](#h-cardinality--privacy-rules)
- [I. Dashboards](#i-dashboards)

---

## A. Architecture

```text
ocean-node ─── OTLP/HTTP :4318 (metrics+traces) ───►  OTel Collector
                                                          │
                                                          ├─ prometheusremotewrite ──► Prometheus ──┐
                                                          │                                          ├─► Grafana
                                                          └─ otlp ────────────────────► Tempo ────────┘
```

The Collector applies `memory_limiter`, an `attributes/scrub` processor (defence-in-depth removal
of sensitive keys — see [H](#h-cardinality--privacy-rules)), and `batch`, then remote-writes
metrics into Prometheus and forwards traces to Tempo over OTLP/gRPC. Metrics arrive at Prometheus
by remote-write, so Prometheus only ever scrapes itself.

Resource attributes set on every process (`telemetry/otel.ts`):

- `service.name` — `ocean-node` (override with `OTEL_SERVICE_NAME`)
- `service.version` — from `package.json`
- `deployment.environment` — `DEPLOYMENT_ENVIRONMENT` (falls back to `NODE_ENV`)
- `service.instance.id` — the node's **libp2p peerId**, derived deterministically from
  `PRIVATE_KEY` before libp2p starts (falls back to a random UUID if P2P is disabled). This is
  the canonical per-node identity in Grafana — **no eth address or friendly name is ever
  attached.**
- `ocean.node.role` — `node` | `bootstrap` | `relay`
- `ocean.network` — optional operator tag, `OCEAN_NETWORK_LABEL`, to group fleets in central mode

## B. Deployment modes

| Mode | Who | Endpoint | Instance identity | Grafana |
|---|---|---|---|---|
| **Ocean-internal** | Ocean's 4 bootstraps + relay tier + core nodes | `OTEL_EXPORTER_OTLP_ENDPOINT` → Ocean's internal collector/Grafana | kept (`service_instance_id` = peerId) — bounded fleet, safe on cardinality | Ocean-internal, fleet + per-node dashboards |
| **Community self-host** | any community operator who wants observability | operator runs `deploy/telemetry/` themselves; node points at their own collector | kept (their own instance) | their own local Grafana |

The Ocean-internal collector is **not** exposed to community nodes. A community operator who wants
metrics stands up the shipped compose stack (below) and points their own node at it. Because only
the bounded core fleet pushes to Ocean's internal deployment, the "thousands of nodes fan into one
collector" cardinality problem doesn't apply there — see
[H](#h-cardinality--privacy-rules) for the fallback if that ever changes.

Two collector configs ship in `deploy/telemetry/`:

- `otel-collector.yaml` — the **operator-local** variant. Open OTLP receiver, local
  Prometheus + Tempo, `resource_to_telemetry_conversion` enabled (keeps `service.instance.id`).
  This is what `docker-compose.telemetry.yml` runs.
- `otel-collector.internal.yaml` — the **Ocean-internal** starting point. Same pipeline shape,
  plus a comment block on what to harden before pointing the real fleet at it (auth on the OTLP
  receiver, persistent/durable storage) and a commented-out `transform/strip_instance` fallback
  processor for if the fleet ever grows past a bounded, dozens-scale size.

## C. Env vars

All optional — telemetry stays off unless `OTEL_EXPORTER_OTLP_ENDPOINT` is set. Also listed in
[`env.md`](env.md) and `ENVIRONMENT_VARIABLES` in `src/utils/constants.ts`.

| Var | Purpose |
|---|---|
| `OTEL_EXPORTER_OTLP_ENDPOINT` | Collector endpoint, e.g. `http://localhost:4318`. Unset = telemetry off. |
| `OTEL_EXPORTER_OTLP_HEADERS` | Extra headers sent with every OTLP request (e.g. an auth token for the Ocean-internal endpoint). |
| `OTEL_METRIC_EXPORT_INTERVAL` | Metric export interval, ms. Lower it (e.g. `5000`) when testing locally so you don't wait a full minute for the first export. |
| `OTEL_SERVICE_NAME` | Override `service.name` (default `ocean-node`). |
| `DEPLOYMENT_ENVIRONMENT` | `deployment.environment` resource attribute; falls back to `NODE_ENV`. |
| `TELEMETRY_ENABLED` | Set to `off` to force telemetry off even with an endpoint configured. |
| `OCEAN_NETWORK_LABEL` | Optional operator tag (`ocean.network` resource attribute) to group fleets in central/dashboard views. |

Also relevant: `C2D_METRICS_INTERVAL_SECONDS` (compute sampling cadence — drives the
`ocean_compute_oldest_sample_age_seconds` freshness guard) and `GPU_METRICS` (enable/disable GPU
gauges). Setting either to disable sampling means the corresponding gauges simply stop reporting
— the freshness guard makes that an explicit, visible gap rather than a silent flatline at zero.

## D. Run the local stack

```bash
docker compose -f deploy/telemetry/docker-compose.telemetry.yml up -d
```

This brings up the OTel Collector (`:4317` gRPC / `:4318` HTTP), Prometheus (`:9090`), Tempo
(`:3200`), and Grafana (`:3001`, anonymous **Admin** access — dev-only, never expose this
configuration outside a trusted local/CI network). Dashboards and datasources are auto-provisioned
from `deploy/telemetry/grafana/`.

Point a node at it:

```bash
export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
# from inside the same compose network instead, use http://otel-collector:4318
npm start
```

Then open Grafana at `http://localhost:3001` — the "Ocean Node" folder has the P2P and Compute
Resources dashboards (see [I](#i-dashboards)). To confirm data is flowing without opening a
browser, query Prometheus directly, e.g. `curl 'http://localhost:9090/api/v1/query?query=ocean_p2p_ready'`.

Tear down with `docker compose -f deploy/telemetry/docker-compose.telemetry.yml down -v` (the
`-v` also drops the Tempo trace volume).

Optional convenience scripts in `deploy/telemetry/scripts/`:

- `import-dashboard.sh` — POST a dashboard JSON to a running Grafana via its HTTP API. Only needed
  when you are **not** using file provisioning (the compose stack above already provisions both
  dashboards on boot) — e.g. pushing to Grafana Cloud or an existing shared Grafana instance.
- `verify-telemetry.sh` — end-to-end check: brings the stack up, starts a node with telemetry
  enabled, asserts that the headline P2P series land in Prometheus, then tears down.

## E. Metric catalog — P2P

Emitted by both `ocean-node` and `ocean-node-bootstrap` (the bootstrap is itself a libp2p node).
All labels are bounded enums — see [H](#h-cardinality--privacy-rules).

**Counters**

| Prometheus name | Labels | Meaning |
|---|---|---|
| `ocean_p2p_peer_connect_total` | — | Peer connections established |
| `ocean_p2p_peer_disconnect_total` | — | Peer disconnections |
| `ocean_p2p_peer_discovery_total` | — | Peers discovered |
| `ocean_p2p_sendto_total` | `outcome` (ok/fail), `reason` (the 7 bounded `SENDTO_FAIL_REASONS`, empty on ok) | `sendTo` attempts |
| `ocean_p2p_resolve_total` | `result` (peerstore_hit/dht_hit/miss) | Peer address resolution |
| `ocean_p2p_dht_provide_total` | `outcome` | DHT `provide()` calls |
| `ocean_p2p_dht_find_total` | `kind` (providers/peer), `outcome` | DHT `findProviders`/`findPeer` |
| `ocean_p2p_command_total` | `command` (bounded to `SUPPORTED_PROTOCOL_COMMANDS`), `outcome` | Inbound protocol commands |
| `ocean_p2p_cert_event_total` | `type` (provision/renew) | AutoTLS certificate lifecycle |

**Observable gauges** (sampled from `getNetworkingStats()` / observability probes each export tick)

| Prometheus name | Labels | Meaning |
|---|---|---|
| `ocean_p2p_connections` | `direction` (inbound/outbound), `limited` (true/false) | Active connections |
| `ocean_p2p_dht_routing_table_peers` | — | Local Kademlia routing-table size |
| `ocean_p2p_dht_mode` | — | 1 = server, 0 = client |
| `ocean_p2p_dial_queue` | `status` (queued/active) | Outbound dial queue |
| `ocean_p2p_relay_reservations` | — | Active circuit-relay reservations |
| `ocean_p2p_autotls_cert_expiry_seconds` | — | Seconds until the AutoTLS cert expires |
| `ocean_p2p_resolution_cache_size` | — | Peer resolution cache size |
| `ocean_p2p_outbound_send_queue` | — | Outbound send-limiter queue depth |
| `ocean_p2p_ready` | — | `getP2PStatus().ready`, 0/1 |

`ocean_p2p_dht_mode` is shared between roles — filter by `ocean_node_role="bootstrap"` in the
dashboard's `role` variable to see bootstrap-only series. The bootstrap additionally emits
`ocean_bootstrap_rabbitmq_published_total` (a counter) when `RABBITMQ_URL` is set.

## F. Metric catalog — Compute resources

`ocean-node` only. Fleet/host-wide **aggregates** of what's already measured per-job/per-service.

**Host/engine aggregate** (label `engine` = the `C2DEngineDocker` cluster hash)

| Prometheus name | Labels | Meaning |
|---|---|---|
| `ocean_compute_cpu_usage_percent` | `engine` | Σ container CPU usage |
| `ocean_compute_cpu_cores_allocated` | `engine` | Σ allocated CPU cores |
| `ocean_compute_cpu_host_cores` | `engine` | Physical host core count |
| `ocean_compute_cpu_throttled_containers` | `engine` | Containers with `throttledPeriods > 0` |
| `ocean_compute_memory_used_bytes` | `engine` | Σ RAM used |
| `ocean_compute_memory_limit_bytes` | `engine` | Σ RAM limit |
| `ocean_compute_disk_used_bytes` | `engine` | Σ disk used |
| `ocean_compute_network_rx_bytes` / `_tx_bytes` | `engine` | Current aggregate bytes — a **point-in-time snapshot**, not a rate (see note below) |
| `ocean_compute_jobs_running` | `engine`, `free` (true/false) | Jobs currently running |
| `ocean_compute_jobs_queued` | `engine`, `free` | Jobs queued |
| `ocean_compute_sampled_containers` | `engine` | Containers included in the last sample |
| `ocean_compute_oldest_sample_age_seconds` | `engine` | Freshness guard — age of the oldest sample feeding the aggregate |

> **rx/tx note:** container network counters are cumulative per container, and containers are
> ephemeral, so summing across the fleet gives a snapshot, not a throughput series. A true
> per-container `rate()` would need a per-container label, which is a cardinality bomb we
> deliberately avoid. Read the network panels as "current aggregate bytes," not "bytes/sec."

**GPU** (per-GPU and total; label `gpu` = device index, `vendor` = nvidia/…)

| Prometheus name | Labels |
|---|---|
| `ocean_compute_gpu_utilization_percent` | `engine`, `gpu`, `vendor` |
| `ocean_compute_gpu_memory_used_bytes` | `engine`, `gpu`, `vendor` |
| `ocean_compute_gpu_memory_total_bytes` | `engine`, `gpu`, `vendor` |
| `ocean_compute_gpu_temperature_celsius` | `engine`, `gpu`, `vendor` |
| `ocean_compute_gpu_power_watts` | `engine`, `gpu`, `vendor` |
| `ocean_compute_gpu_devices_in_use` | `engine` |

Totals are a Grafana `sum()`/`avg()` over the per-GPU series rather than a separate instrument.
`gpu` cardinality is bounded — a host has a handful of GPUs at most — and jobs sharing a device are
deduped by `resourceId` before reporting, so utilization reflects the device, not job count.

**Per-environment resource pools** (declared capacity vs live use, from `getComputeEnvironments()`)

| Prometheus name | Labels |
|---|---|
| `ocean_compute_env_resource_total` | `engine`, `env`, `resource` (cpu/ram/disk/gpu/…) |
| `ocean_compute_env_resource_inuse` | `engine`, `env`, `resource` |

**Lifecycle counters**

| Prometheus name | Labels | Meaning |
|---|---|---|
| `ocean_compute_jobs_started_total` | `engine`, `free` | Jobs started |
| `ocean_compute_jobs_finished_total` | `engine`, `status` (bounded terminal statuses) | Jobs reaching a terminal state |

## G. OTel → Prometheus name mangling

This trips people up more than anything else — the exporter rewrites names on the way out:

| Rule | Example |
|---|---|
| Dots become underscores | `ocean.p2p.ready` → `ocean_p2p_ready` |
| Counters gain `_total` | `ocean.p2p.sendto` (counter) → `ocean_p2p_sendto_total` |
| Up-down-counters / gauges get **no** `_total` | `ocean.p2p.connections` (gauge) → `ocean_p2p_connections` |
| Histograms get a unit suffix + `_bucket`/`_sum`/`_count` | `ocean.p2p.sendto.duration` (ms) → `ocean_p2p_sendto_duration_milliseconds_bucket` / `_sum` / `_count` |
| Attribute dots become underscores | `service.instance.id` → label `service_instance_id`; `outcome` stays `outcome` |

When in doubt, query Prometheus directly — `curl 'http://localhost:9090/api/v1/label/__name__/values'`
lists every series name actually landing, which is the ground truth over any table in this doc.

## H. Cardinality & privacy rules

- **Metric labels are bounded enums only.** The tables in [E](#e-metric-catalog--p2p) and
  [F](#f-metric-catalog--compute-resources) list every allowed label. Never add `peerId`,
  multiaddr, IP, `did`, `jobId`, `consumerAddress`, a tx hash, or a free-text error message to a
  metric. Errors/outcomes are classified into small enums at the call site, not passed through
  verbatim.
- **Instance identity is a resource attribute, not a metric label**, and is stripped in central
  mode only if the fleet ever grows past a bounded size (the `transform/strip_instance` fallback
  in `otel-collector.internal.yaml`, not enabled by default). Operator-local always keeps it.
- **The collector scrubs defensively.** `attributes/scrub` in both collector configs deletes
  `privateKey`, `private_key`, `PRIVATE_KEY`, `consumerAddress`, `did`, `jobId`, `nonce`, and
  `signature` if present, even though the app never attaches these to a metric in the first place
  — defence in depth, not the primary control.
- **Traces may carry `service.instance.id`** (the peerId) for per-node drill-down; Tempo's
  `block_retention: 24h` bounds how long that's retrievable. No custom span attributes carrying
  DIDs or addresses in phase 1.
- **A disabled sampler is a gap, not a zero.** `GPU_METRICS=false` or
  `C2D_METRICS_INTERVAL_SECONDS=0` stop the corresponding gauges from reporting at all; the
  `ocean_compute_oldest_sample_age_seconds` freshness guard makes that visible on the dashboard
  instead of silently reading as "no load."

## I. Dashboards

Two boards are provisioned automatically by the local compose stack, in the "Ocean Node" folder:

- **`ocean-node-p2p.json`** (`uid: ocean-node-p2p`) — connections, DHT health, sendTo/resolve
  outcome rates (with the safe-ratio recording rules `ocean_node:p2p_sendto_fail_rate` /
  `ocean_node:p2p_resolve_miss_rate`), dial queue, relay reservations, peer churn, DHT
  provide/find outcomes, AutoTLS cert expiry, inbound command volume, and (in fleet mode) how
  many nodes are reporting and their ready share. Also serves the bootstrap — filter by the
  `role` template variable (`ocean_node_role`).
- **`ocean-node-compute.json`** (`uid: ocean-node-compute`) — total CPU/RAM/disk/network,
  cores allocated vs host capacity, running/queued/started/finished jobs, GPU utilization/memory/
  temperature/power (total and per-device), throttled containers, per-environment pool
  utilization, and the sample-freshness guard.

Both use a `${DS_PROMETHEUS}` datasource template variable (resolved to the provisioned
Prometheus datasource, uid `ocean-node-prometheus`, on import) and an `instance`
(`service_instance_id`) template variable so a single Grafana can show one node or the whole
fleet. The recording rules both dashboards lean on live in `deploy/telemetry/rules.yml` and use
the `clamp_min(denominator, 0.0001)` idiom to keep a ratio panel from going `NaN`/dividing by zero
when a fleet is momentarily empty.
