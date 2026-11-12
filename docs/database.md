# Ocean Node Database Configuration

Ocean Node requires Elasticsearch. It is the only database: the node does not start its stores without it, and there is no mode that runs without a database.

## Database Configuration

Set `DB_URL`, `DB_USERNAME` and `DB_PASSWORD`. Elasticsearch holds the DDO, indexer, log, order, DDO state, access list and escrow indices, and the node state indices `nonce`, `node_config`, `auth_tokens`, `buckets`, `node_metrics_samples`, `node_metrics_hourly`, `c2d_jobs`, `service_jobs`, `docker_images` and `service_locks`. The local `databases/` folder holds only `p2p-store` (the libp2p datastore).

### 1. Set the Environment Variables

    •	For Elasticsearch, you need to set:

```bash
DB_URL="http://localhost:9200"  # Example URL when using Barge for Elasticsearch
DB_USERNAME="elastic"
DB_PASSWORD="changeme"
```

### 2. Starting Ocean Barge

To run Ocean Node with the appropriate database, you need to start Barge with specific flags.

    •	To run Ocean Node with Elasticsearch, use the following command:

```bash
./start_ocean.sh --no-aquarius --no-provider --no-dashboard --with-c2d
```

By specifying these flags, you can configure Ocean Node to work with Elasticsearch.

## Public read access to the DDO indices

Some frontends read the DDO indices directly from Elasticsearch (for example
`POST http://<host>:9200/op_ddo_v4.1.0/_search`), so port 9200 stays published. Elasticsearch
also holds the node state, so its security is on:

- The node logs in with `DB_USERNAME` and `DB_PASSWORD`. That user has full access. Change
  the default password `changeme` on a host that publishes the port.
- A caller that sends no credentials gets the `ocean_ddo_reader` role from
  [`elasticsearch-roles.yml`](../elasticsearch-roles.yml). It can only read the `op_ddo_*`
  indices. Writes, the other indices and the cluster APIs return `403`.

The compose files set this with `xpack.security.enabled: 'true'`,
`xpack.security.authc.anonymous.roles: 'ocean_ddo_reader'` and a mount of the roles file to
`/usr/share/elasticsearch/config/roles.yml`. If you run your own Elasticsearch, apply the same
three settings, or do not publish the port: the node's `query` command and
`POST /api/aquarius/assets/metadata/query` take the same Elasticsearch query body.

## Auth tokens

Auth tokens live in the `auth_tokens` index. The node stores only the sha256 hash of each
token (as the document id), never the token itself. A daily cron job deletes expired and
invalidated tokens.

## Node metrics history

Node metrics history lives in the `node_metrics_samples` and `node_metrics_hourly` indices and
is kept per instance. Instances that share one `PRIVATE_KEY` share one peer id, so the node
keys its metrics by `INSTANCE_ID`, or by the hostname when `INSTANCE_ID` is not set. A history
request answers from the instance that receives it. In containers the hostname changes on
redeploy, so container deployments set `INSTANCE_ID` (see [env.md](env.md)). Retention
runs per instance id, so the node never sweeps the rows of a retired `INSTANCE_ID`: set
`INSTANCE_ID` to a stable value.

## Runtime metrics on C2D job records

While a compute job or Service-on-Demand container runs, the node periodically samples live
Docker (and, on NVIDIA hosts, NVML) metrics — CPU, RAM, disk usage vs quota, network, block
I/O, PID count, CPU throttling, memory peak, exit/OOM info, and per-GPU utilization/memory —
and stores the latest snapshot on the job record (inside the existing JSON `body` blob of the
`c2d_jobs` / `service_jobs` documents). A **final** snapshot is written at termination
(publishing results, quota kill, service stop/restart, or unexpected container death) so
peak/exit metrics remain queryable after the container is gone. No schema migration is needed;
pre-upgrade records simply lack the field.

These snapshots are **owner-only**: they are stripped from the escrow claim proof and from every
response except the authenticated owner's own `COMPUTE_GET_STATUS` / `SERVICE_GET_STATUS` (where
they are included by default — see [API.md](API.md)). Sampling cadence is controlled by
`C2D_METRICS_INTERVAL_SECONDS` (`0` disables it) and GPU collection by `GPU_METRICS` — see
[env.md](env.md). When metrics are missing, [Logs.md](Logs.md#when-a-status-response-has-no-runtimemetrics)
covers how to inspect what is actually stored, and [compute.md](compute.md#troubleshooting-gpu-metrics)
covers the GPU-specific warnings.
