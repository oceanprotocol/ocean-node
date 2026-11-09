# AGENTS.md

This file provides guidance to coding agents (Claude Code, Codex, Cursor, and others) when
working with code in this repository.

Ocean Node is the all-in-one backend for the Ocean Protocol stack. A single Node process
replaces three legacy components: **Provider** (data access / encryption / compute),
**Aquarius** (metadata cache) and the **subgraph** (on-chain event indexing). It is a
TypeScript ESM project (Node >= 24, pinned to 26.12.1) that exposes an HTTP API and a
libp2p P2P interface, both of which dispatch to the same set of command handlers.

---

## 1. Environment & tooling prerequisites

- **Node.js >= 24 is required; 26.12.1 is the pinned runtime.** `package.json` `engines`
  requires `>=24` (Node 22 is no longer supported). `.nvmrc`, both `Dockerfile` stages
  (`node:26.12.1-trixie-slim`) and CI (`.github/workflows/ci.yml`) all pin `26.12.1`; keep
  them in lockstep when bumping. The Dockerfile also pins each base image by digest, so a
  bump means updating the `sha256:` alongside the tag — resolve it with
  `docker buildx imagetools inspect node:<version>-trixie-slim`, not from the tag alone.
  Run `nvm use` (or `source ~/.nvm/nvm.sh && nvm use`) before any `npm`, build, or
  test command. If the pinned version is already installed directly (no nvm available),
  verifying the active runtime against `.nvmrc` instead is sufficient — e.g.
  `test "v$(cat .nvmrc)" = "$(node -v)"`; do not abort the build just because `nvm` is
  absent. The wrong Node version fails with errors like `Unexpected token 'with'`,
  missing `GLIBC_2.38`, or — since the SQLite layer uses the built-in `node:sqlite`
  module — `ERR_UNKNOWN_BUILTIN_MODULE: node:sqlite` on Node < 22.13. This is enforced by
  `.cursor/rules/tests-nvm.mdc` and this `AGENTS.md`.
- **There is no `postinstall` step.** `npm install` is plain. (Historically a `postinstall`
  ran `scripts/fix-libp2p-http-utils.js` to default a missing URL port to 443/80 in
  `@libp2p/http-utils`; upstream shipped that fix in `2.0.3`, so both the hook and the
  script were removed.)
- **Docker + docker-compose** are needed for the metadata database (Typesense or
  Elasticsearch) and for C2D (Compute-to-Data) via the local Docker socket.
- TypeScript config: **TypeScript 6**, ESM (`module: esnext`, `target: ES2022`,
  `moduleResolution: node`), `experimentalDecorators` + `emitDecoratorMetadata` enabled,
  `rootDir: ./src`, `outDir: ./dist`. Most local imports use the `.js` extension
  (compiled ESM convention), though ~31 relative imports still omit it.
  - `strict` is **on**, with two documented exceptions: `strictNullChecks: false` and
    `useUnknownInCatchVariables: false`. Turning either on is a real project (~1324 and
    ~389 errors); do it subsystem by subsystem, not in passing.
  - Two things must be done before TypeScript 7: `moduleResolution` has to move off
    `node10` (`ignoreDeprecations: "6.0"` only defers it, and `nodenext` currently costs
    ~123 errors), and `typescript-eslint` has to support TS 7 — its peer range is
    `>=4.8.4 <6.1.0`, so it pins us below 7 today.

### Mandatory config: `PRIVATE_KEY` + a config file

`PRIVATE_KEY` (with the `0x` prefix, 66 chars) is the **only** required environment
variable — it seeds the node identity (libp2p peerId), the EVM signer, and encryption keys.
A JSON config file must also exist (see §3); every other setting has a default or comes
from that file / env overrides. Generate a key with:

```bash
node dist/helpers/scripts/generatePK.js            # prints a key/address to stdout
node dist/helpers/scripts/generatePK.js --save     # writes .pk.out / .wallet.out
```

Or use the interactive helper `./src/helpers/scripts/setupNodeEnv.sh` (npm: `setupEnv`),
which generates a key, configures DB, and writes `.env`. `npm run quickstart`
(`scripts/ocean-node-quickstart.sh`) walks through a full Docker deployment and auto-detects
GPUs into `DOCKER_COMPUTE_ENVIRONMENTS`.

---

## 2. Common commands

All commands assume `nvm use` has been run first.

### Build / run

```bash
npm run build        # clean ./dist then tsc (build:tsc, emits sourcemaps)
npm run type-check   # tsc --noEmit  (also runs as part of `npm run lint`)
npm run start        # node dist/index.js  (needs a prior `npm run build`)
```

`start` runs with `--max-old-space-size=28784 --experimental-specifier-resolution=node`.
The Dockerfile uses the identical CMD. The compiled entry point is `dist/index.js`
(source `src/index.ts`).

### Lint / format

```bash
npm run lint       # eslint + type-check
npm run lint:fix   # eslint --fix
npm run format     # prettier --write '**/*.{js,jsx,ts,tsx}'
```

ESLint 10 with flat config in `eslint.config.js` (there is no `.eslintrc`/`.eslintignore`).
`eslint-config-oceanprotocol` is **not** used — it is pinned to eslint ^8 and cannot follow
eslint to flat config, so the preset is composed in-repo from `@eslint/js`,
`typescript-eslint`, `eslint-plugin-security`, `eslint-plugin-promise` and
`eslint-plugin-prettier`. Only `**/*.ts` is linted; `.js` is ignored as build output.
Notable rules: `require-await` is an **error**, `no-unused-vars` is an **error** (with
`args: 'none'`, `caughtErrors: 'none'`), empty catch blocks are allowed. `@typescript-eslint`'s
`recommended` set is deliberately _not_ extended, and a few rules that eslint 9/10 and the
newer plugins added are switched off — see the comments in `eslint.config.js`. Prettier:
no semicolons, single quotes, `printWidth: 90`, no trailing commas, 2-space tabs.

### Tests (important build quirk)

**Tests run against compiled JS in `dist/test/`, not the TypeScript source.** The
`test:*` scripts all call `npm run build-tests` first, which:

- compiles `src/` (incl. `src/test`) into `dist/`,
- copies `src/test/.env.test` and `.env.test2` into `dist/test`,
- copies `src/test/config.json` to `$HOME/config.json`.

Mocha config (`.mocharc.json`): `bail: true` (stops on first failure), `timeout: 20000`,
`exit: true`, and it **requires `./dist/test/utils/hooks.js`** (global setup/teardown). The
runner is `npm run mocha` = `mocha --node-env=test --config .mocharc.json <glob>`.

```bash
npm run test              # full CI gate: lint + unit(+coverage) + integration(+coverage)
npm run test:unit         # build-tests + mocha ./dist/test/unit/**/*.test.js
npm run test:integration  # build-tests + mocha ./dist/test/integration/**/*.test.js
npm run test:integration:light   # integration minus the heavy compute.test.js
npm run test:computeunit         # unit compute tests only (fast; used for quick checks)
npm run test:computeintegration  # integration compute tests
npm run test:servicesintegration # service-on-demand integration
npm run test:indexer             # indexer integration
```

**Running a single test / file.** Build once, then invoke mocha directly on a compiled
file (or filter by name with `--grep`):

```bash
npm run build-tests
npx mocha --node-env=test --config .mocharc.json "./dist/test/unit/crypt.test.js"
npx mocha --node-env=test --config .mocharc.json "./dist/test/unit/**/*.test.js" --grep "nonce"
```

Remember to re-run `build-tests` after editing source or test files, since mocha only sees
the compiled output. In tests, do **not** mutate `process.env` directly — use the
`setupEnvironment()` / `tearDownEnvironment()` helpers in `before()`/`after()` (see
`docs/testing.md`) so config changes are reverted and don't leak between suites.

**Integration tests require a running local chain + services (Barge).** Clone
`oceanprotocol/barge`, `git checkout feature/nodes`, then `./start_ocean.sh -with-c2d`
(see `docs/testing.md` and `docs/database.md` for the exact flags per DB type). The default
`config.json` points the DB at Typesense on `http://localhost:8108`.

Other useful scripts: `npm run client` (2-node download flow demo), `npm run check-nonce`
(nonce tracking; needs DB), and k6 perf tests `test:smoke` / `test:load` / `test:stress` /
`test:request:rate` (require k6 installed and a running node).

`npm run logs` runs `scripts/logs.sh`, which makes **one** HTTP request to `<url>/logs` and
pipes the response to `jq` — it does not tail local log files. Arguments are positional:
`npm run logs -- [url] [startTime] [endTime] [maxLogs] [moduleName] [level]`. `url`
defaults to `http://localhost:8000` (the Docker `HTTP_API_PORT`), but the repo
`config.json` sets `httpPort: 8001`, so pass `http://localhost:8001` for a local
`npm run start`. The default `startTime` uses GNU `date -d` (Linux only; pass it explicitly
on macOS). **The script is currently broken:** it sends an unsigned `GET`, while `/logs` is
an admin-only signed `POST`, so the node rejects it. Use `ocean-cli downloadNodeLogs` or read
the files in `logs/` instead (see `docs/Logs.md`).

### Databases for local dev

```bash
docker-compose -f typesense-compose.yml up -d       # Typesense (default in config.json)
docker-compose -f elasticsearch-compose.yml up -d   # Elasticsearch alternative
```

---

## 3. Configuration mechanism

Config is resolved by `getConfiguration()` in `src/utils/config/builder.ts` (re-exported
via `src/utils/config/index.ts` and `src/utils/index.ts`). Key facts:

- **Required JSON file + environment overrides.** Env vars are not an alternative to the
  file: `buildMergedConfig()` always calls `loadConfigFromFile()` first, then deep-merges the
  mapped env overrides (`ENV_TO_CONFIG_MAPPING`) on top and validates the result with zod.
  The file is resolved from the `CONFIG_PATH` env var (must be absolute), else
  `./config.json` in cwd. `CONFIG_PATH` may begin with a literal `$HOME` prefix: the loader
  (`builder.ts`) expands it from `process.env.HOME`/`os.homedir()` **before** the absolute
  check (and errors `Config path contains $HOME but HOME is not set` if `HOME` is unset).
  If it is missing, startup fails with
  `Config file not found at path: ...`, even when every setting is given via env. The repo
  ships a ready `config.json` (Typesense DB, chain `8996`/development, HTTP port `8001`,
  single Docker C2D env).
- **`INTERFACES`** env var (JSON array like `["HTTP","P2P"]`) toggles `hasHttp` / `hasP2P`.
  Omitted = both enabled. `DB_URL`/`DB_TYPE` presence drives `hasIndexer` — without a valid
  metadata DB config the Indexer and the metadata-backed features (DDOs, orders, access
  lists, escrow events, DB logs) are disabled, but the SQLite core still runs: nonce, auth
  tokens, C2D jobs, node config (and best-effort node metrics). So nonce and auth services
  keep working. This graceful-degrade path only applies when the config itself is
  schema-valid: `dbConfig.dbType` is `z.string().nullable()` (`schemas.ts`), so a non-string
  value (number/bool/object) fails zod validation in `buildMergedConfig()` and aborts the
  **whole node** at startup — it does not disable just the metadata DB. A `null`/absent
  `dbType` is valid and selects the no-metadata-DB mode above.
  - **Paid/free compute still needs the metadata DB to resolve a published dataset.** SQLite
    preserves C2D **job storage**, but `FindDdoHandler.findAndFormatDdo` (`ddoHandler.ts`)
    falls back to the P2P `FIND_DDO` lookup when no local DDO DB exists, and that network
    response is a **summary** (`{id,lastUpdateTx,lastUpdateTime,provider}`), not the full
    DDO. Parsing it for `services`/`indexedMetadata` throws and returns `null`, so
    `initialize`/`startCompute` cannot resolve the asset. "C2D keeps working" means the job
    runtime, not compute against a published DID without a metadata DB.
- The full catalog of env vars is defined as `ENVIRONMENT_VARIABLES` in
  `src/utils/constants.ts` and documented in `docs/env.md` (long file — the authoritative
  reference). `.env.example` lists them grouped as core / p2p / compute.
- `getConfiguration(true)` is called once at startup with a verbose flag to reduce repeated
  logging (config is read from many places; there's a known TODO to centralize access on the
  `OceanNode` class).

Selected env vars worth knowing: `RPCS` (per-chain RPC map, JSON), `DB_URL`/`DB_TYPE`,
`ALLOWED_ADMINS`(+`_LIST`) (gate admin commands), `AUTHORIZED_DECRYPTERS`/`_PUBLISHERS`/
`ALLOWED_VALIDATORS` (+ their access-list variants), `MAX_REQ_PER_MINUTE` (rate limit),
`RATE_DENY_LIST`, `HTTP_API_PORT`, `JWT_SECRET`, `OPERATOR_SERVICE_URL` (external C2D
clusters), `POLICY_SERVER_URL`, `DOCKER_COMPUTE_ENVIRONMENTS` (C2D env + GPU/resource
definitions), and the `P2P_*` family (bind addresses/ports, bootstrap nodes, NAT/relay
toggles, announce address filtering).

---

## 4. High-level architecture

### Layered model (see `docs/Arhitecture.md`)

1. **Network layer** — libp2p (peer-to-peer) + Express HTTP API. Both are entry points that
   normalize a request into a `Command` object and hand it to the components layer.
2. **Components layer** — Indexer, Provider, C2D, Database, P2P, Auth, KeyManager,
   BlockchainRegistry, Escrow, PersistentStorage, PolicyServer.
3. **Modules / handlers layer** — the concrete command handlers under
   `src/components/core/` that execute the actual work.

### Startup (`src/index.ts` → `OceanNode`)

`src/index.ts` bootstraps in this order: load config → compute `codeHash` of the codebase →
`Database.init(config.dbConfig)` → create `KeyManager` and `BlockchainRegistry` → optionally
start `OceanP2P` (if `hasP2P`), `OceanIndexer` (if `hasIndexer` + DB), `OceanProvider` (if
DB) → build the **`OceanNode` singleton** via `OceanNode.getInstance(...)` →
`addC2DEngines()` → if `hasHttp`, wire up the Express app (CORS, a middleware that attaches
`req.oceanNode` + caller IP, `requestValidator`, then mounts `httpRoutes`) and start
HTTP/HTTPS → `scheduleCronJobs()`.

`OceanNode` (`src/OceanNode.ts`) is the central singleton wiring everything together. It
holds the `CoreHandlersRegistry`, `C2DEngines`, `Escrow`, `Auth`, `PersistentStorage`,
`Database`, `KeyManager`, `BlockchainRegistry`, and the per-caller rate-limit `requestMap`.
`handleDirectProtocolCommand(message)` is the single choke point for dispatch: it JSON-parses
the command, looks up the handler by `task.command`, and calls `handler.handle(task)`.

### Request / command flow

Two front doors, one dispatcher:

- **HTTP `POST /directCommand`** (`src/components/httpRoutes/commands.ts`): validates the
  body, then decides _local vs remote_. If the command targets this node (or no P2P), it
  calls `oceanNode.handleDirectProtocolCommand(...)`. If it targets another peer and P2P is
  enabled, it forwards via `oceanNode.getP2PNode().sendTo(node, msg, multiAddrs)`. Responses
  are streamed back to the client (binary or text).
- **P2P inbound** (`src/components/P2P/handleProtocolCommands.ts`): a libp2p protocol handler
  reads a length-prefixed command frame off the stream, applies connection/request rate
  limits, and dispatches through the same `CoreHandlersRegistry`.
- **RESTful routes** (`src/components/httpRoutes/*`, e.g. `provider.ts`, `aquarius.ts`,
  `compute.ts`, `auth.ts`, `escrow.ts`, `accessList.ts`, `persistentStorage.ts`) are
  ergonomic wrappers that build the equivalent `Command` and invoke the corresponding
  handler. Route mounting lives in `src/components/httpRoutes/index.ts`
  (`getAllServiceEndpoints()` enumerates them for the status/root endpoint).

So: **every capability is ultimately a command handler**, reachable identically over HTTP
`/directCommand`, over P2P, and (for most) via a dedicated REST route.

### Command registry & handler pattern

- **`src/utils/constants.ts`** defines `PROTOCOL_COMMANDS` (name → string) and the parallel
  `SUPPORTED_PROTOCOL_COMMANDS` allow-list. Keep both in sync.
- **`src/components/core/handler/coreHandlersRegistry.ts`** — `CoreHandlersRegistry` is a
  singleton that, in its constructor, instantiates and registers one handler per command
  (`download`, `encrypt`, `getDDO`, `query`, `status`, `getFees`, `fileInfo`, the `compute*`
  family, the `service*` family, the admin commands, `getP2P*`, auth tokens, persistent
  storage, access lists, escrow events, …). `getHandler(command)` returns the instance.
- **`src/components/core/handler/handler.ts`** — `BaseHandler` (abstract) defines the
  contract: `verifyParamsAndRateLimits(task)` and `handle(task)`, plus shared rate-limiting
  (`checkRateLimit` / `checkRequestData` against `OceanNode.requestMap`). Handlers extend
  `BaseHandler` / `CommandHandler` (admin handlers extend `AdminCommandHandler`).

**To add a new command:** add the name to `PROTOCOL_COMMANDS` + `SUPPORTED_PROTOCOL_COMMANDS`;
create a handler extending `BaseHandler`/`CommandHandler` under `src/components/core/`;
register it in the `CoreHandlersRegistry` constructor; add param validation; optionally add a
REST route in `src/components/httpRoutes/` and mount it in `httpRoutes/index.ts`.

Handler source is grouped under `src/components/core/`:

- `handler/` — general handlers (ddo, download, encrypt, fees, nonce, query, status, p2p,
  auth, accessList, escrow, fileInfo, persistentStorage, policyServer, getJobs).
- `compute/` — C2D command handlers: `initialize`, `startCompute` (paid), `freeStartCompute`,
  `getStatus`, `getResults`, `getStreamableLogs`, `stopCompute`, `environments`.
- `service/` — Service-on-Demand handlers (`start`, `stop`, `restart`, `extend`, `getStatus`,
  `getTemplates`, plus `templateLoader`).
- `admin/` — privileged handlers gated by `ALLOWED_ADMINS`: `stopNode`, `stopJob`,
  `reindexTx`, `reindexChain`, `IndexingThreadHandler`, `collectFees`, `fetchConfig`,
  `pushConfig`, `getLogs`.
- `utils/` — shared logic: `escrow`, `feesHandler`, `findDdoHandler`, `nonceHandler`,
  `statusHandler`, `validateOrders`.

### Components in `src/components/`

- **P2P/** — `OceanP2P` (extends EventEmitter) builds a libp2p node: TCP + WebSockets
  transports, Noise encryption, Yamux muxing, Kademlia DHT + mDNS peer discovery,
  circuit-relay v2, AutoNAT, UPnP, identify/ping/dcutr, and auto-TLS. Handles the custom
  Ocean protocol stream, DDO DHT caching (`FindDDOResponse`), peer/announce address filtering,
  and cross-node request forwarding (`sendTo`). A LevelDB datastore persists at
  `./databases/p2p-store`.
- **Indexer/** — `OceanIndexer` orchestrates one `ChainIndexer` per configured chain
  (single-threaded, async/await concurrency; **no worker threads**). Each ChainIndexer polls
  its chain, and a set of event **processors** (`src/components/Indexer/processors/`) handle
  specific events: `MetadataCreated/Updated/State`, `OrderStarted/Reused`, exchange/dispenser
  lifecycle, access-list changes, and Escrow events. It validates DDOs against SHACL schemas,
  stores orders, supports version-based + admin-triggered reindexing, and a `purgatory`.
  Communication uses module-level `EventEmitter`s (`INDEXER_DDO_EVENT_EMITTER`,
  `INDEXER_CRAWLING_EVENT_EMITTER`).
- **Provider/** — deliberately thin (`OceanProvider` just wraps the `Database`). The real
  "provider" behavior (download streaming, encrypt/decrypt, fees, initialize, nonce) lives in
  the core handlers and the `providerRoutes`.
- **c2d/** — Compute-to-Data. `C2DEngines` builds engines from `config.c2dClusters`; the
  implemented engine is `C2DEngineDocker` (`compute_engine_docker.ts`, base
  `compute_engine_base.ts`) which orchestrates jobs via the host Docker socket. Compute
  lifecycle: `initializeCompute` → `startCompute`/`freeStartCompute` → `getComputeStatus` →
  `getComputeResult` (+ `getComputeStreamableLogs`) → `stopCompute`. Paid compute settles via
  the `Escrow` component; `serviceResourceMatching.ts` maps requested cpu/ram/disk/gpu against
  environment pools (dual-gate: per-env ceiling + engine-wide pool; GPUs tracked globally).
  See `docs/compute.md`.
- **database/** — `Database.init()` factory (`index.ts`, `DatabaseFactory.ts`). The metadata
  DB backend is pluggable: **Typesense or Elasticsearch** (chosen by `DB_TYPE`) for DDOs,
  indexer state, logs, orders, ddoState, access lists, escrow events — behind the
  `Abstract*Database` interfaces in `BaseDatabase.ts`. **SQLite** is always used for the
  nonce DB, config DB, C2D job DB, and auth-token DB (works even with no metadata DB
  configured) — via Node's built-in `node:sqlite` module (no native addon), wrapped by
  `SqliteClient` in `src/components/database/sqliteClient.ts`. See `docs/database.md`.
- **KeyManager/** — provider-abstraction over the node key (`docs/KeyManager.md`). Currently
  `RawPrivateKeyProvider` (from `PRIVATE_KEY`); derives the libp2p peerId/keys and the EVM
  address, and caches the ethers signer. Designed to add KMS providers (GCP/AWS) later.
- **BlockchainRegistry/** — manages per-chain `Blockchain` instances (`src/utils/blockchain.ts`),
  giving handlers RPC providers/signers keyed by `chainId` (`OceanNode.getBlockchain(chainId)`).
- **Auth/** — auth-token issuance/validation (JWT-based, `JWT_SECRET`) as an alternative to
  per-request signatures.
- **persistentStorage/** — pluggable storage for C2D job outputs and user buckets. Only
  `localfs` (`PersistentStorageLocalFS`) is implemented; the `s3` backend
  (`PersistentStorageS3`) is a stub — every operation throws
  `PersistentStorageS3 is not implemented yet`, so selecting `type: s3` yields no usable
  persistent storage. Backend is selected by `type` in `createPersistentStorage.ts`; there is
  no IPFS backend. See `docs/persistentStorage.md`, `docs/Storage.md`.
- **policyServer/** — passthrough integration to an external policy server for access
  decisions (`POLICY_SERVER_URL`, `docs/PolicyServer.md`).

### Types, utils, and support directories

- `src/@types/` — shared TypeScript types (`OceanNode.ts` for config/response shapes,
  `commands.ts` for `Command`/handler interfaces, `blockchain.ts`, `C2D/`).
- `src/utils/` — cross-cutting helpers: `config/` (config builder + zod schemas),
  `constants.ts`, `crypt.ts` (hashing/signing), `blockchain.ts`, `logging/` (winston: console, per-module
  rotating files in `logs/` by default when `LOG_DB` is off, optional DB transport), `cronjobs/`, `validators.ts`, `credentials.ts`,
  `accessList.ts`, `asset.ts`, `attestation.ts`.
- Runtime data dirs: `databases/` (SQLite files + libp2p LevelDB store), `c2d_storage/` (C2D
  job working data), `logs/`, `schemas/` (SHACL DDO validation schemas — shipped into the
  Docker image). Service-on-demand templates are not shipped: the node reads
  them from the folder given by `serviceTemplatesPath` / `SERVICE_TEMPLATES_PATH`, which the
  operator mounts in at run time.
- `tsoa.json` configures OpenAPI spec generation from `src/components/httpRoutes/**`; the
  actual routing is plain Express routers, not tsoa-generated.

---

## 5. Docker & deployment

Multi-stage `Dockerfile` (builder + runner), both stages on
`node:26.12.1-trixie-slim` pinned by digest. The runner ships only
`dist/`, `node_modules`, `schemas/`, `hfpatch/` (the `sitecustomize.py` the node copies
into services — see `docs/services.md`) and `config.json` (`.dockerignore` excludes all of
`docs/`) — no service templates. It exposes P2P ports `9000-9003,9005` and
HTTP `8000`. `docker-entrypoint.sh` handles Docker socket group membership at runtime so C2D
can talk to `/var/run/docker.sock`. Deployment options (Docker, local Docker build via
`quickstart`, PM2, plain npm) are in `README.md`; production deployment details in
`docs/dockerDeployment.md`.

---

## 6. Documentation map (`docs/`)

`Arhitecture.md` (note the spelling), `API.md` (full HTTP API reference — very large, plus a
Postman collection), `env.md` (authoritative env-var reference), `database.md`,
`Storage.md` / `persistentStorage.md`, `KeyManager.md`, `PolicyServer.md`, `services.md`
(Service-on-Demand), `compute.md` (C2D configuration: resources, GPUs, constraints, pricing), `networking.md`, `Logs.md`,
`Publishing.md`, `testing.md`, `dockerDeployment.md`.
