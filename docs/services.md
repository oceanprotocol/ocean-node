# Services (Service-on-Demand)

A high-level overview of the service-on-demand feature: how it works, how it is
configured, and the security properties you should be aware of.

## What is a service?

A **service** is a long-running Docker container that a consumer launches on a compute
environment and pays for up front via on-chain escrow. Unlike a compute job — which runs
an algorithm to completion and exits — a service stays up for a requested **duration** and
exposes one or more network **endpoints** (`http://<nodeHost>:<hostPort>`) that the
consumer can connect to while it runs.

The consumer supplies the container spec directly in the request: an `image`
(referenced by `tag` or `checksum`, or an inline `dockerfile` when the operator allows
building), optional `dockerCmd` / `dockerEntrypoint`, the container ports to expose, the
requested resources (cpu/ram/disk/gpu), the duration, and encrypted `userData` that is
injected as container environment variables.

## Lifecycle

All endpoints live under `/api/services`. Every request except `serviceTemplates` is
authenticated by a signature (or auth token) over the caller's `consumerAddress` +
`nonce` + command. `serviceStatus` is a `GET`, so it carries `consumerAddress`, `nonce`,
and `signature` as query parameters (or an auth-token `Authorization` header).

| Command | Route | Method | Purpose |
| --- | --- | --- | --- |
| `SERVICE_START` | `/api/services/serviceStart` | POST | Validate, persist a `Starting` record, and return the `serviceId` immediately (escrow + image + container happen in the background) |
| `SERVICE_GET_STATUS` | `/api/services/serviceStatus` | GET | Read job status / endpoints — authenticated, owner-scoped (see notice below); poll this to follow a starting service |
| `SERVICE_EXTEND` | `/api/services/serviceExtend` | POST | Pay to push the expiry further out |
| `SERVICE_RESTART` | `/api/services/serviceRestart` | POST | Recreate the container (no extra charge); asynchronous like start — returns once the job is `Restarting`, poll `serviceStatus` |
| `SERVICE_STOP` | `/api/services/serviceStop` | POST | Tear down the container; the paid resource reservation (cpu/ram/gpu + host ports) is kept until `expiresAt`, so the service can be restarted anytime on the same endpoints |
| `SERVICE_GET_TEMPLATES` | `/api/services/serviceTemplates` | GET | List operator-published service templates |
| `SERVICE_GET_STREAMABLE_LOGS` | `/api/services/serviceStreamableLogs` | GET | Stream the container's live stdout/stderr logs — authenticated, owner-scoped; available while `Running` or `Error`; optional `since` to skip history |

**Start is asynchronous.** `serviceStart` does only the fast, synchronous validation and then
returns the `serviceId` right away — it does **not** wait for escrow or the (potentially
multi-minute) image pull/build. A background loop on the node then advances the service through
a sequence of statuses; clients **poll `serviceStatus`** to follow it to `Running` (or a
terminal `*Failed` / `Error`).

**Handler (synchronous, before responding):** signature check → environment + access-list +
`features.services` check → `userData` decrypt (validity check) → duration cap → resource
resolution & availability → cost computed from **server-side** environment pricing → escrow
funds pre-check (fail fast with `400 Insufficient escrow funds` when the consumer's available
escrow visibly can't cover the cost; best-effort — an RPC hiccup skips it and the background
Locking step remains the authoritative check) → persist the job as `Starting` (which also
reserves its resources) → respond `200` with the `serviceId`.

**Background pipeline (per the start statuses below):**
`Starting (10)` → **locking** `Locking (20)`: escrow `createLock` (+ wait for it to mine) →
**image** `PullImage (11)` / `BuildImage (13)`: pull or build the image and run the vulnerability
scan → **payment** `Claiming (30)`: `claimLock` on success, or `cancelLock` (refund) if the image
step failed → allocate host ports, create the network, create + start the container →
`Running (40)`.

Escrow is **claimed only after the image succeeds**; if the image pull/build/scan fails, or
container creation fails before the claim, the lock is **cancelled (refunded)** and the job ends
in a `*Failed` / `Error` status. This is a change from the previous synchronous flow, which
locked-then-claimed up front.

**Restart is asynchronous too.** `serviceRestart` performs only the fast validations
(ownership, environment/access, not expired, payment not refunded), persists the job as
`Restarting (45)` and responds immediately — the teardown, image re-pull/rebuild and new
container happen in the background under the same per-service lock. Poll `serviceStatus`
and watch `Restarting` → `PullImage`/`BuildImage` → `Running` (or `Error` with the failure
reason in `statusText`). A service whose start payment was **never claimed** — the escrow
lock failed outright (e.g. insufficient funds) or was refunded before being claimed —
cannot be restarted: it was never paid for, so restarting it would run the service for
free. Start a new service instead.

**The reservation lasts the whole paid window — only `Expired` releases it.** The consumer
paid for the resources for a time interval and may use them as they please within it:
running the service, stopping it, restarting it. An explicit `SERVICE_STOP` therefore tears
down the container/network but **keeps** the resource amounts (cpu/ram/gpu) counted and the
host ports reserved — another consumer cannot take them, and a restart resumes on the same
endpoints. The reservation is tied to **payment**: an `Error`/`Stopped` job whose payment
was never claimed (lock failed or refunded) does not reserve anything — otherwise anyone
could squat a node's GPU for free by starting services against an empty escrow account.
Once `expiresAt` passes, the expiry sweep tears down whatever is left, marks the
job `Expired`, and only then releases everything. The sweep refuses to mark `Expired` while
teardown fails (e.g. Docker unreachable) — the job stays `Error` and is retried every tick,
so a resource release is never silently skipped.

**`Running` is monitored too.** The same background loop that advances a starting service also
checks every `Running` service's container on each tick (~every few seconds). If the container
exits on its own — crash, OOM, or the Docker daemon itself becoming unreachable — the job is
moved to `Error` immediately instead of waiting for `expiresAt`. This health check does **not**
release the service's reserved host ports/network/container record, since the consumer already
paid for them; use `SERVICE_RESTART` to bring the service back on the same endpoints. `Error`
counts as an active/resource-reserving status just like `Running` and `Stopped` do — it still
occupies its cpu/ram/gpu allocation and keeps its host ports held — until it is restarted or
swept by the expiry check once `expiresAt` passes (which then fully releases everything).

**Restart is self-healing with respect to leftover Docker state.** Each service gets a Docker
network with the deterministic name `ocean-svc-<serviceId>`. Teardown (restart, stop, expiry
sweep) removes that network by name — not just by the stored network id — force-removing any
stale attached container first, so state leaked by a node crash mid-start cannot wedge the
service. If network creation still hits a name conflict, the stale network is removed and
creation is retried once.

A leftover network is deliberately **removed and recreated rather than reused**. Reusing it
would save nothing: a leaked network can still have a stale container attached (crashed after
`container.start()` but before the job record was persisted), still bound to the service's
host ports — so the old container must be inspected and force-removed either way, and at that
point recreating the now-empty network is a single cheap API call. Recreating also guarantees
the network always reflects the current code's configuration instead of silently inheriting
whatever options a previous node version created it with, and it matches restart's overall
tear-down-and-rebuild semantics (the container is never reused either).

**Lifecycle operations are exclusive per service.** At most one lifecycle operation — the
background start pipeline, `SERVICE_RESTART`, `SERVICE_STOP`, or the expiry sweep — runs per
service at a time. A restart or stop issued while another operation is in flight (e.g. a
restart still pulling the image) is rejected with
`Service <id> has a start/stop/restart operation in progress — retry shortly`; simply retry
once the in-flight operation settles. Without this exclusivity, the background loop's
crash-orphan recovery could tear down the `ocean-svc-<serviceId>` network in the middle of a
restart that had just created it, failing the restart with
`network ocean-svc-<id> not found`. If a service expires while such an operation is in
flight, the expiry sweep simply retries on a later tick.

Exclusivity holds **across node processes** too, not just within one: each operation also
takes a lease row in the SQLite `service_locks` table, so two processes sharing the same
`databases/` directory and Docker daemon (e.g. an old container still running during a
redeploy) cannot run conflicting operations on the same service. Leases are heartbeated
every 30 s while the operation runs; a lease not refreshed for 2 minutes belongs to a
crashed process and is stolen automatically, so no manual cleanup is ever needed.

## Configuration

Service-on-demand is configured per Docker connection under `serviceOnDemand`:

| Field | Meaning |
| --- | --- |
| `enabled` | Master switch for the feature on this connection. |
| `nodeHost` | Externally reachable host used to build endpoint URLs. |
| `hostPortRange` | `[start, end]` range the node allocates published host ports from. |
| `maxDurationSeconds` | Upper bound on a service's lifetime (default 86400). |
| `allowImageBuild` | If true, consumers may submit an inline `dockerfile` to build. |

Whether a given environment accepts services is gated by its `features.services` flag,
and access can be restricted with the environment's `access` allow-list
(`addresses` + on-chain `accessLists`). Operator-published **templates** are loaded from
`serviceTemplatesPath` (default `databases/serviceTemplates/`); template secret values
are never returned by the API (only the env-var keys are exposed).

## Security model & important notices

- **Container hardening.** Service containers are created with
  `SecurityOpt: ['no-new-privileges']`, `CapDrop: ['ALL']`, and `PidsLimit: 512`.
  Unlike the compute path, the service path does **not** force a non-root `User` —
  arbitrary service images often expect to start as root, so the image's declared user
  is kept. Dropping all capabilities + `no-new-privileges` keeps that root process
  unprivileged.

- **⚠️ Low ports won't bind inside the container.** Because `CapDrop: ['ALL']` removes
  `NET_BIND_SERVICE`, a process **inside** the container cannot bind to a container port
  below 1024. Have your service listen on a **high port** (the externally published
  *host* port is allocated by the node from `hostPortRange` regardless). If a specific
  image genuinely needs a low in-container port, that requires explicitly adding
  `CapAdd: ['NET_BIND_SERVICE']` in the engine — it is intentionally not enabled by
  default.

- **Access lists apply to the whole lifecycle.** `start`, `extend`, and `restart` all
  re-check the environment's `access` allow-list (access lists are mutable, so a
  revoked consumer cannot keep a service alive). `stop` is owner-gated only, so a
  revoked owner can still shut their own service down.

- **No privileged/advanced Docker config.** The service path deliberately omits the
  user-injectable advanced Docker config (host bind mounts, extra capabilities,
  `seccomp:unconfined`, devices beyond the priced GPU pool) that the compute path
  supports. Do not thread it in.

- **Payment is server-priced.** Cost is computed only from the environment's configured
  pricing for the requested token/chain; the consumer cannot influence the charged
  amount, and the escrow payer is always the signature-authenticated `consumerAddress`
  (you cannot charge someone else).

- **`serviceStatus` is authenticated and owner-scoped.** The caller must supply
  `consumerAddress` plus a valid `nonce`/`signature` (or auth token) proving control of
  that address; results are restricted to services owned by it, so one consumer cannot
  read another's job records or endpoint URLs. That said, a published service endpoint is
  still reachable by anyone who learns or guesses its URL — the node only port-forwards
  and does not authenticate traffic to the container, so put your own authentication in
  front of any sensitive service and do not rely on endpoint-URL secrecy as access
  control.

- **`serviceStreamableLogs` is authenticated and owner-scoped, like `serviceStatus`.**
  Container stdout/stderr can leak secrets or sensitive request data, so the same
  proof-of-`consumerAddress` + ownership check gates log access — a non-owner gets `401`.
  Logs are only served while the service is `Running` or `Error` (a crashed container's
  logs stay available for diagnosis until `stop`/`restart` tears it down); otherwise the
  route returns `404`. By default the full history since container start is returned before
  the stream switches to following live output — for a service that has been running for
  days or weeks that can be a lot of data, so pass `since` (a Unix timestamp, or a relative
  duration like `1h`) to skip straight to recent output.

- **`allowImageBuild` runs arbitrary build instructions.** When enabled, a consumer's
  inline `dockerfile` is built by the Docker daemon, so its `RUN` steps execute arbitrary
  commands in the daemon's build sandbox. Leave it disabled unless you intend to offer
  build-from-source and trust the consumer set.
