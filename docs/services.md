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
| `SERVICE_RESTART` | `/api/services/serviceRestart` | POST | Recreate the container (no extra charge) |
| `SERVICE_STOP` | `/api/services/serviceStop` | POST | Tear down the container and release resources |
| `SERVICE_GET_TEMPLATES` | `/api/services/serviceTemplates` | GET | List operator-published service templates |

**Start is asynchronous.** `serviceStart` does only the fast, synchronous validation and then
returns the `serviceId` right away — it does **not** wait for escrow or the (potentially
multi-minute) image pull/build. A background loop on the node then advances the service through
a sequence of statuses; clients **poll `serviceStatus`** to follow it to `Running` (or a
terminal `*Failed` / `Error`).

**Handler (synchronous, before responding):** signature check → environment + access-list +
`features.services` check → `userData` decrypt (validity check) → duration cap → resource
resolution & availability → cost computed from **server-side** environment pricing → persist the
job as `Starting` (which also reserves its resources) → respond `200` with the `serviceId`.

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

**`Running` is monitored too.** The same background loop that advances a starting service also
checks every `Running` service's container on each tick (~every few seconds). If the container
exits on its own — crash, OOM, or the Docker daemon itself becoming unreachable — the job is
moved to `Error` immediately instead of waiting for `expiresAt`. This health check does **not**
release the service's reserved host ports/network/container record, since the consumer already
paid for them; use `SERVICE_RESTART` to bring the service back on the same endpoints. `Error`
counts as an active/resource-reserving status just like `Running` does — it still occupies its
cpu/ram/gpu allocation and keeps its host ports held — until it is restarted, explicitly
stopped, or swept by the same expiry check once `expiresAt` passes (which then fully releases
everything, same as a normal expiry).

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

- **`allowImageBuild` runs arbitrary build instructions.** When enabled, a consumer's
  inline `dockerfile` is built by the Docker daemon, so its `RUN` steps execute arbitrary
  commands in the daemon's build sandbox. Leave it disabled unless you intend to offer
  build-from-source and trust the consumer set.
