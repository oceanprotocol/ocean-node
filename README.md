# Ocean Node

Ocean Node is the all-in-one backend for the Ocean Protocol stack. A single Node process
replaces three legacy components — [Provider](https://github.com/oceanprotocol/provider)
(data access, encryption, compute), [Aquarius](https://github.com/oceanprotocol/aquarius)
(metadata cache) and the [subgraph](https://github.com/oceanprotocol/ocean-subgraph)
(on-chain event indexing) — and adds Compute-to-Data, payment settlement and more. It
exposes an HTTP API and a libp2p peer-to-peer interface, both of which dispatch to one
shared set of command handlers.

This README is a quick guide for operators and developers. See the [`docs/`](docs/)
directory (indexed at the bottom) for the detailed references.

**Capabilities**

- **Metadata indexing** — per-chain indexer for DDOs, orders, pricing (fixed-rate /
  dispenser), access lists and escrow events, with reindexing and purgatory support.
- **Provider / consume flows** — asset download streaming, encrypt/decrypt, fees,
  nonce/signature checks and order validation.
- **Compute-to-Data (C2D)** — Docker-based compute jobs with CPU/RAM/disk/GPU resource
  matching, free and paid compute, and job result/log retrieval.
- **Service-on-Demand** — template-driven long-running services (start/stop/restart/extend).
- **Escrow / payment settlement** — on-chain settlement for paid compute and services.
- **Auth tokens** — JWT-based auth as an alternative to per-request signatures.
- **Persistent storage** — local filesystem (`localfs`) storage for C2D outputs and user
  buckets, configured via `PERSISTENT_STORAGE` (the S3 backend is a stub).
- **Policy Server integration** — delegate access decisions to an external policy server.
- **Pluggable key management** — node identity and signer behind a KeyManager abstraction.
- **Observability** — OpenTelemetry traces/metrics and rotating file logging.

## Architecture at a glance

Ocean Node has **two front doors and one dispatcher**:

- **HTTP** — `POST /directCommand` (plus ergonomic REST routes under `provider`, `aquarius`,
  `compute`, `auth`, `escrow`, …) normalizes each request into a `Command`.
- **P2P** — a libp2p protocol handler reads length-prefixed command frames off the stream.

Both paths converge on the same `CoreHandlersRegistry`, where every capability is a command
handler reachable identically over HTTP, over P2P and (for most) via a dedicated REST route.
See [Architecture](docs/Arhitecture.md) for the layered model and Mermaid diagrams.

## System requirements

- **Basic node** (indexer + provider + P2P): ~2 vCPU, 4 GB RAM, a few GB of storage for the
  databases and logs.
- **Node running C2D / GPU**: C2D runs jobs as Docker containers on the host, so size for the
  workloads you intend to accept — multiple cores, substantial RAM/disk, and one or more GPUs
  for GPU compute environments. Resource ceilings are declared in
  `DOCKER_COMPUTE_ENVIRONMENTS`.
- **OS**: latest LTS Ubuntu or latest macOS recommended; other OSes (including Windows) should
  also work.

A **persistent `databases/` volume is REQUIRED**, not optional. It holds the SQLite files
(nonce, config, C2D jobs, auth tokens) and `databases/p2p-store`, the libp2p datastore that
backs this node's DHT provider records. Starting it empty silently drops content the node
still serves. The Dockerfile declares `VOLUME ["/usr/src/app/databases"]` for this reason —
see "Persistent node data" in [Docker deployment](docs/dockerDeployment.md).

## Quick start (operators)

### Option 1 — Docker (recommended)

The recommended way to host a node and be eligible for incentives. Follow the
[Docker deployment guide](docs/dockerDeployment.md). The other options below are aimed at
developers who want to tinker.

### Option 2 — Docker Compose via the quickstart script (pulls the published image)

```bash
npm run quickstart
# OR
scripts/ocean-node-quickstart.sh
```

This walks you through setting up the environment variables and deploying the node.

> [!NOTE]
> The quickstart script auto-detects GPUs (NVIDIA via `nvidia-smi`, others via `lspci`) and
> appends them to `DOCKER_COMPUTE_ENVIRONMENTS`. Detected GPUs are added to
> `DOCKER_COMPUTE_ENVIRONMENTS[0].resources` (the connection-level pool) plus a lightweight
> ref in `environments[0].resources`. If you pre-configure `DOCKER_COMPUTE_ENVIRONMENTS`
> yourself, auto-detected GPUs are **merged** in, which can duplicate entries — for most
> users it is best to let the script handle GPU detection.

### Option 3 — PM2

PM2 is a process manager that makes it easy to run and monitor Node.js apps.

```bash
npm install -g pm2

# 1. Start a metadata database (Typesense is the default in config.json)
docker-compose -f typesense-compose.yml up -d

# 2. Install deps and build — `npm run start` runs dist/index.js, so a prior build is required
npm install
npm run build

# 3. Set up env vars. The node does NOT auto-load .env at runtime (dotenv is only used in
#    tests), so the vars must be in the shell environment before `pm2 start`.
#    Interactive helper, then load the generated .env into this shell:
npm run setupEnv
source .env
# …or set them manually (PRIVATE_KEY is the only mandatory one; keep the 0x prefix):
# export PRIVATE_KEY="0x<64-hex-characters>"   # or generate one: node dist/helpers/scripts/generatePK.js
# if you use a JSON config file instead, point CONFIG_PATH at its absolute path:
# export CONFIG_PATH="/absolute/path/to/config.json"

# 4. Start under PM2
pm2 start npm --name "ocean-node" -- run start
```

Manage it with `pm2 list`, `pm2 logs ocean-node`, `pm2 restart|stop|delete ocean-node`. The
node also writes daily-rotating files to `logs/` (see [Logs](docs/Logs.md)); PM2 keeps its
own stdout copy in `~/.pm2/logs` with no size cap unless `pm2-logrotate` is installed.

### Option 4 — Plain npm (development)

**Prerequisites**

- **Node.js**: use the version pinned in [`.nvmrc`](.nvmrc) (run `nvm use`). The effective
  supported runtime is **Node 24+** (`package.json` `engines`), and the `.nvmrc`/Dockerfile
  pin the exact tested version (currently 26.12.1). Note that on anything below **22.13** the
  node fails to even start, because the SQLite layer uses the built-in `node:sqlite` module
  (`ERR_UNKNOWN_BUILTIN_MODULE: node:sqlite`) — but 22.x is not a supported runtime, use 24+.
- **Docker + Docker Compose** (for the metadata database and C2D).

```bash
# 1. Start a metadata database (Typesense is the default in config.json)
docker-compose -f typesense-compose.yml up -d
#    …or Elasticsearch:
# docker-compose -f elasticsearch-compose.yml up -d

# 2. Install and build
nvm use
npm install
npm run build

# 3. Configure env vars (interactive helper, or set PRIVATE_KEY manually)
./src/helpers/scripts/setupNodeEnv.sh && source .env

# 4. Start
npm run start
```

`npm run start` is **not** a plain `node dist/index.js`. It runs
`node --import ./dist/telemetry/otel.js --max-old-space-size=28784 --trace-warnings
--experimental-specifier-resolution=node dist/index.js` (identical to the Docker `CMD`), so a
prior `npm run build` is required.

## Configuration

- **`PRIVATE_KEY`** (exactly 66 characters: `0x` + 64 hex) is the **only mandatory**
  variable. It seeds the node identity (libp2p peerId), the EVM signer and the encryption
  keys; everything else has defaults. Generate one with
  `node dist/helpers/scripts/generatePK.js`.
- **Config sources**: a JSON config file plus environment-variable overrides. The file is
  resolved from `CONFIG_PATH`, else `./config.json` in the working directory, and must exist —
  the repo ships a ready-to-run [`config.json`](config.json) (Typesense DB, chain
  `8996`/development, a single Docker C2D environment). Environment variables are merged on
  top of the file and take precedence.
  - ⚠️ **Blank env vars override the file.** Only *unset* variables fall through to
    `config.json`; an **empty** value (e.g. `export HTTP_API_PORT=`) is treated as set and
    overrides the file's value. `npm run setupEnv` creates `.env` by copying
    [`.env.example`](.env.example), which has many blank `export VAR=` lines, so after
    `source .env` those blanks shadow your `config.json`. Remove or comment out the lines you
    are not actually setting, and keep only the vars you want to override.
- **`INTERFACES`** (JSON array, e.g. `["HTTP","P2P"]`) toggles which front doors are enabled;
  omitted means both.
- [`docs/env.md`](docs/env.md) is the authoritative reference. Key groups worth knowing:
  - `RPCS` — per-chain RPC endpoint map (JSON).
  - `DB_URL` / `DB_TYPE` — metadata DB connection and backend; presence drives whether the
    indexer runs.
  - `ALLOWED_ADMINS`, `AUTHORIZED_DECRYPTERS`, `AUTHORIZED_PUBLISHERS`, `ALLOWED_VALIDATORS`
    (and their access-list variants) — admin / decrypter / validator allow-lists.
  - `MAX_REQ_PER_MINUTE`, `RATE_DENY_LIST` — rate limiting.
  - `DOCKER_COMPUTE_ENVIRONMENTS` — C2D environments, resources and GPUs.
  - `POLICY_SERVER_URL` — external policy server.
  - `JWT_SECRET` — signing secret for auth tokens.
  - `P2P_*` — bind addresses/ports, bootstrap nodes, NAT/relay toggles, announce filtering.

## Databases

The metadata backend is pluggable: **Typesense** or **Elasticsearch**, chosen via `DB_TYPE`.
Both ship with a compose file ([`typesense-compose.yml`](typesense-compose.yml),
[`elasticsearch-compose.yml`](elasticsearch-compose.yml)) and hold DDOs, indexer state, logs,
orders, access lists and escrow events.

> **Default differs by config source.** The shipped [`config.json`](config.json) defaults to
> **Typesense**, but when you supply the DB through **environment variables** (`DB_URL`, e.g.
> via `npm run setupEnv`) the builder sets `dbConfig.dbType` to `DB_TYPE || 'elasticsearch'`.
> So if you enable the DB via env vars and want Typesense, you must set `DB_TYPE=typesense`
> explicitly — otherwise the node tries to talk to your Typesense endpoint as Elasticsearch.

**SQLite is always on**, independent of the metadata DB: it backs the nonce, config, C2D-job
and auth-token stores via Node's built-in `node:sqlite` module (no native addon). A valid
`dbConfig` in `config.json` is **retained** when `DB_URL` is unset or empty (env `DB_TYPE`
alone does not build or override it), so the file's DB config still drives the indexer; it is
disabled outright only when **neither** the file nor the environment provides a valid DB
config (the SQLite stores keep working regardless). A valid `dbConfig` is **necessary but not
sufficient**, though: if the metadata DB is unreachable when the node starts (connection
fails after the init retries), the node logs *DEGRADED mode*, disables the indexer, and keeps
only the SQLite-backed C2D / nonce / auth stores — so also make sure the configured
Typesense/Elasticsearch endpoint is actually up and reachable. A config value of the wrong type instead fails
`OceanNodeConfigSchema` (zod) validation and stops startup before any DB is initialized. See
[Database guide](docs/database.md).

## Compute (C2D) & services

Compute-to-Data runs jobs as Docker containers through the host Docker socket. The lifecycle
is `initializeCompute` → `startCompute` / `freeStartCompute` → `getComputeStatus` →
`getComputeResult` (+ streamable logs) → `stopCompute`. Requested CPU/RAM/disk/GPU are matched
against environment resource pools, and paid compute settles through the Escrow component.
Service-on-Demand runs template-driven long-lived services with a similar lifecycle.

- [Compute (C2D) configuration](docs/compute.md) — resources, GPUs, constraints, pricing.
- [Services (Service-on-Demand)](docs/services.md).
- [Persistent storage for C2D jobs](docs/persistentStorage.md).

## Developer guide

- **Build**: `npm run build` (clean + `tsc`). **Lint/format**: `npm run lint`,
  `npm run lint:fix`, `npm run format`.
- **Tests run against compiled JS in `dist/test/`, not the TypeScript source.** The `test:*`
  scripts call `npm run build-tests` first, so re-run it after editing source or tests.

  ```bash
  npm run test:unit                 # unit suite
  npm run test:integration          # integration suite (needs Barge)
  npm run test:computeunit          # C2D unit tests (fast)
  npm run test:computeintegration   # C2D integration tests
  npm run test:servicesintegration  # Service-on-Demand integration
  npm run test:indexer              # indexer integration
  ```

- **Integration tests require a running local stack** — clone
  [`oceanprotocol/barge`](https://github.com/oceanprotocol/barge) and start it with C2D (see
  [testing guide](docs/testing.md) for exact flags per DB backend).
- **Adding a command/handler**: register the name in `PROTOCOL_COMMANDS` +
  `SUPPORTED_PROTOCOL_COMMANDS`, add a handler under `src/components/core/`, register it in the
  `CoreHandlersRegistry`, add param validation, and optionally wire a REST route. See
  [`CLAUDE.md`](CLAUDE.md) for the full architecture notes and [testing guide](docs/testing.md).

## Observability

The node emits OpenTelemetry traces and metrics (loaded via `--import ./dist/telemetry/otel.js`
at startup) and writes per-module daily-rotating logs to `logs/`. See
[Telemetry](docs/telemetry.md) and [Logging](docs/Logs.md).

> [!NOTE]
> `npm run logs` (the signed `/logs` API helper) is currently broken — see
> [docs/Logs.md](docs/Logs.md) for the current way to access logs.

## Networking & P2P

Ocean Node builds a libp2p node (TCP + WebSockets, Noise, Yamux, Kademlia DHT + mDNS
discovery, circuit-relay v2, AutoNAT, UPnP, auto-TLS) and forwards commands between peers. See
[Network configuration](docs/networking.md).

## Documentation index

- [Architecture](docs/Arhitecture.md)
- [API reference](docs/API.md) · [Postman collection](<docs/Ocean Node.postman_collection.json>)
- [Environment variables](docs/env.md)
- [Database guide](docs/database.md)
- [Asset storage types](docs/Storage.md) · [Persistent storage](docs/persistentStorage.md)
- [Compute (C2D)](docs/compute.md) · [Services (Service-on-Demand)](docs/services.md)
- [Publishing](docs/Publishing.md)
- [KeyManager](docs/KeyManager.md) · [Policy Server](docs/PolicyServer.md)
- [Telemetry](docs/telemetry.md) · [Logging](docs/Logs.md)
- [Network configuration](docs/networking.md)
- [Testing guide](docs/testing.md) · [Docker deployment](docs/dockerDeployment.md)
- [`CLAUDE.md`](CLAUDE.md) — in-repo architecture & contributor notes.

## Related repositories

- [ocean.js (`@oceanprotocol/lib`)](https://github.com/oceanprotocol/ocean.js) — JavaScript
  client library.
- [ocean-cli](https://github.com/oceanprotocol/ocean-cli) — command-line client.
- [contracts](https://github.com/oceanprotocol/contracts) — Ocean smart contracts.
- [barge](https://github.com/oceanprotocol/barge) — Docker-based local full-stack environment
  for integration testing.
