# Ocean Node Database Configuration

Ocean Node can be run with two types of databases: Elasticsearch or Typesense, or with no database at all (using a NoSQL setup). This flexibility allows you to configure the node based on your infrastructure needs.

## Database Configuration

Depending on the database type you choose, you will need to set specific environment variables. Ocean Node supports either Elasticsearch or Typesense as the database for storing the various node components.

### 1. Set the Environment Variables

    •	For Typesense, you need to set the following environment variables:

```bash
DB_TYPE=typesense
DB_URL="http://localhost:8108/?apiKey=xyz"  # Example URL when using Barge for Typesense
```

    •	For Elasticsearch, you need to set:

```bash
DB_TYPE=elasticsearch
DB_URL="http://localhost:9200"  # Example URL when using Barge for Elasticsearch
```

Ensure that the correct DB_TYPE is specified as either typesense or elasticsearch depending on your chosen setup.

### 2. Starting Ocean Barge

To run Ocean Node with the appropriate database, you need to start Barge with specific flags.

    •	To run Ocean Node with Typesense, use the following command:

```bash
./start_ocean.sh --no-aquarius --no-provider --no-dashboard --with-c2d --with-typesense --no-elasticsearch
```

    •	To run Ocean Node with Elasticsearch, use the following command:

```bash
./start_ocean.sh --no-aquarius --no-provider --no-dashboard --with-c2d
```

By specifying these flags, you can configure Ocean Node to work with either Typesense or Elasticsearch databases, depending on your requirements.

## Runtime metrics on C2D job records

While a compute job or Service-on-Demand container runs, the node periodically samples live
Docker (and, on NVIDIA hosts, NVML) metrics — CPU, RAM, disk usage vs quota, network, block
I/O, PID count, CPU throttling, memory peak, exit/OOM info, and per-GPU utilization/memory —
and stores the latest snapshot on the job record (inside the existing JSON `body` blob of the
SQLite `c2djobs` / `service_jobs` tables). A **final** snapshot is written at termination
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
