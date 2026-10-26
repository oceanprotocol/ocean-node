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
requested resources ([cpu/ram/disk/gpu](compute.md)), the duration, and encrypted `userData`
that is injected as container environment variables. An optional `metadata` object carries
arbitrary user labels (scalar values, ≤1 KB JSON) that the node stores verbatim and never
interprets — returned to the owner on `serviceStatus`, replaceable on `serviceRestart`, and
stripped from the node-wide `serviceList`.

## Lifecycle

All endpoints live under `/api/services`. Every request except `serviceTemplates` is
authenticated by a signature (or auth token) over the caller's `consumerAddress` +
`nonce` + command. `serviceStatus` is a `GET`, so it carries `consumerAddress`, `nonce`,
and `signature` as query parameters (or an auth-token `Authorization` header).

| Command | Route | Method | Purpose |
| --- | --- | --- | --- |
| `SERVICE_START` | `/api/services/serviceStart` | POST | Validate, persist a `Starting` record, and return the `serviceId` immediately (escrow + image + container happen in the background) |
| `SERVICE_GET_STATUS` | `/api/services/serviceStatus` | GET | Read job status / endpoints — authenticated, owner-scoped (see notice below); poll this to follow a starting service |
| `SERVICE_LIST` | `/api/services/serviceList` | GET | Node-wide service listing — authenticated, **not** owner-scoped. Default: only services currently holding a resource reservation; `status=<n>` filters to one specific status, `includeAllStatuses=true` returns everything, `fromTimestamp` keeps services created at/after that moment. Output is listing-sanitized (no `userData`, no `dockerCmd`/`dockerEntrypoint`, no Dockerfile) but keeps user `metadata` |
| `SERVICE_EXTEND` | `/api/services/serviceExtend` | POST | Pay to push the expiry further out |
| `SERVICE_RESTART` | `/api/services/serviceRestart` | POST | Recreate the container (no extra charge); asynchronous like start — returns once the job is `Restarting`, poll `serviceStatus`. Optionally restart on a **new image spec** (bug-fix flow) — see below |
| `SERVICE_STOP` | `/api/services/serviceStop` | POST | Tear down the container; the paid resource reservation (cpu/ram/gpu + host ports) is kept until `expiresAt`, so the service can be restarted anytime on the same endpoints. `release: true` ends the paid window now and frees it instead (no refund, no restart) |
| `SERVICE_GET_TEMPLATES` | `/api/services/serviceTemplates` | GET | List operator-published service templates |
| `SERVICE_GET_STREAMABLE_LOGS` | `/api/services/serviceStreamableLogs` | GET | Stream the container's live stdout/stderr logs — authenticated, owner-scoped; available while `Running` or `Error`; optional `since` to skip history |
| `SERVICE_GET_RESULT` | `/api/services/serviceResult` | GET | Download the service's `/data/outputs` as a zip — one of its archives (`index`, resumable with `offset`) or the running container's (`live=true`); authenticated, owner-scoped. See [Service outputs](#service-outputs) |

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
free. Start a new service instead. A service with an `outputBucketId` the owner can no
longer use (the bucket was deleted, or it belongs to someone else and bucket sharing is
disabled or the owner was removed from its access list) is refused with `403` before
anything is torn down, so the running container is left as it was.

**Restart can change the image — atomically.** A restart is either *all-old* or *all-new*;
it never mixes new request params over the stored job:

- **REUSE mode** — send no container params and the service restarts on exactly its stored
  spec (image, `userData`, `dockerCmd`, `dockerEntrypoint`).
- **RESPEC mode** — send *any* container param and the container is rebuilt entirely from the
  request. `image` is then **required** and exactly one of `tag`/`checksum`/`dockerfile` applies
  (validated like `serviceStart`); `userData`/`dockerCmd`/`dockerEntrypoint` are taken as-sent,
  so anything omitted is empty — never inherited from the old job.

This is the fix-and-redeploy flow: you started a service on your own image, found a bug, pushed
a corrected image under a new tag, and now restart on it — same `image`, new `tag` — without
losing the paid window, resources or host ports. Requiring `image` whenever any container param
is present is what makes a partial change impossible: a lone new `dockerCmd`/`userData` (which
would silently run on top of the old image) is rejected with `400`, and a `dockerfile` respec on
an environment with `allowImageBuild=false` is rejected with `403`. Payment, resources and
duration are always preserved — only the container spec changes.

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

## Readiness and startup progress

`Running` only means the container started. For workloads it recognizes, the node also reports
whether the service can serve requests and how far its startup downloads have got, on the job
returned by `SERVICE_GET_STATUS`:

- `readiness` — `waiting`, `ready` or `failing`, from a request the node makes to the workload
  itself: vLLM `GET /v1/models` on 8000, llama.cpp `GET /health` on 8080, ComfyUI
  `GET /system_stats` on 8188. A profile applies only when the service publishes that port, so an
  app that runs an engine behind its own port reports no readiness and `Running` stays the signal.
  A service still `waiting` 15 minutes after its container started is logged once as a node warning
  with the last probe error — usually a node that cannot reach its containers.
- `imagePull` — byte progress of the image pull.
- `modelDownload` — bytes downloaded against the total, and `filesComplete` / `filesTotal` when the
  download is listed up front.

`modelDownload` comes from the launch script's download manifest when it writes one: a
tab-separated `/tmp/ocean/downloads.tsv` in the container, one `<kind> <bytes> <path> [<source>]`
line per item, written before the first download. A `file` entry is complete once `<path>` exists
and in flight while `<path>.part` does, or while a `.xet-<name>` folder beside it does (a Xet
download staging there, measured with `du -sb`); a `dir` entry is a folder filled under names of its
own (huggingface_hub's snapshot cache), measured with `du -sb`. A `bytes` of `0` means unknown. Lines may
be appended while the script runs; at most 64 entries are read. Without a manifest, the node falls
back to the engine's own Hugging Face cache (vLLM, llama.cpp).

From the engine's cache, `downloadedBytes` is raised to the bytes the container has received over
the network. Xet, huggingface_hub's default transfer backend, holds most of a file in memory and
writes it near the end, so the cache alone can read near zero for most of a download. The bytes
received also count anything else the container fetches, so with a known total they are held below
it: only the files in the cache complete a download.

A service with no engine profile (an app that runs its engine behind its own port) still reports
`modelDownload` from its manifest, with no `readiness`. With nothing to say when such a service is
ready, the node checks it only within 30 minutes of the container starting unless a manifest has
appeared, and stops once everything listed is complete. All of it is best-effort and owner-only: a
missing or wrong manifest only changes what that service's own progress report says.

## Service outputs

A service writes its results to `/data/outputs`. With an `outputBucketId` that folder is the
bucket, bind-mounted into the container, and everything below does not apply — the results
are in the bucket. Without a bucket, the node handles `/data/outputs` like it handles a
compute job's outputs:

- **The folder always exists.** Before starting a container the node creates
  `/data/outputs` in it (mode `0777`, so a non-root service user can write), unless the image
  already has one. An existing `/data` is left untouched.
- **A restart keeps it.** `serviceRestart` replaces the container, so the node carries the
  folder over: the old container is stopped (not removed), and once the new one is created
  its `/data/outputs` is copied in, before the new container starts and the old one is
  removed. The service comes back with the files it had, and a restart normally produces no
  archive. If the old container can't be stopped, the copy fails, or the restart itself
  fails, the folder is archived instead, so nothing is lost. A service with an output bucket needs none of
  this: the bucket is mounted into the new container again.
- **It is archived when the service's container goes away for good**: `serviceStop`, the
  expiry sweep, and the crash recovery at node start. The folder lives in the container's
  writable layer, so it is zipped right before the container is removed. Each such container
  gives one archive, `outputs-<n>.zip` under `<c2d storage>/services/<serviceId>/`, listed on
  `serviceStatus` as `outputArchives` (`index`, `filename`, `filesize`, `createdAt` and
  `containerId`). Archiving is best-effort: if it fails, teardown continues and the error is
  only logged by the node. A container without `/data/outputs`, or with an empty one, produces
  no archive. A service that is stopped and later restarted starts with an empty folder;
  what it had is in the stop archive.
- **The zip holds the folder's regular files and folders**, uncompressed, with their mtimes
  and permission bits. Symlinks, hardlinks, devices and entries with an absolute or `..`
  path are left out, so an archive can't write outside the folder it is extracted into.
- **Download it any time.** `serviceResult?serviceId&index=<n>` streams an archive, in any
  status, including `Expired`; add `offset=<bytes>` to resume a broken download.
  `serviceResult?serviceId&live=true` zips the running container's `/data/outputs` on the
  fly (while `Running`, or `Error` before teardown) — a service can run for weeks, and its
  owner shouldn't have to stop it to get results. A live download isn't written to the
  node's disk and can't be resumed. Files the service is writing at that moment may come out
  partial.
- **Archives expire like job results.** They are deleted `storageExpiry` seconds (of the
  service's environment, default 604800) after `expiresAt`, by the same cron that cleans
  expired compute jobs (`CRON_CLEANUP_C2D_STORAGE`). An early `release` moves `expiresAt` to
  the stop time, and `serviceExtend` moves it later. The service record is kept, with
  `outputArchives: []`.
- There is no size cap on archives beyond the node's free disk.

## Configuration

Service-on-demand is configured per Docker connection under `serviceOnDemand`:

| Field | Meaning |
| --- | --- |
| `enabled` | Master switch for the feature on this connection. |
| `nodeHost` | Externally reachable host used to build endpoint URLs. |
| `hostPortRange` | `[start, end]` range the node allocates published host ports from. |
| `minDurationSeconds` | Hard floor under a service's duration for this daemon (default 0 — no floor). An environment may raise it with its own `minServiceDuration`; a smaller per-env value is clamped up to this one at startup, with a warning. |
| `maxDurationSeconds` | Hard ceiling on a service's lifetime for this daemon (default 86400). An environment may lower it with its own `maxServiceDuration`; a larger per-env value is clamped to this one at startup, with a warning. |
| `allowImageBuild` | If true, consumers may submit an inline `dockerfile` to build. |

Whether a given environment accepts services is gated by its `features.services` flag,
and access can be restricted with the environment's `access` allow-list
(`addresses` + on-chain `accessLists`).

Each environment resolves its own service bounds at startup and advertises them in
GET_COMPUTE_ENVIRONMENTS as `minServiceDuration` and `maxServiceDuration`. SERVICE_START
rejects a `duration` outside that range; SERVICE_EXTEND caps the resulting remaining window to
the maximum. Set them per environment to give, say, a cheap CPU env a 1 h limit while a GPU
env keeps the full 24 h:

```json
{ "id": "cpu-small", "minServiceDuration": 600, "maxServiceDuration": 3600, "fees": { "1": [ ... ] } }
```

`minServiceDuration` is a minimum **purchase**, applied to a start and to an extension alike:
SERVICE_START rejects a shorter `duration` and SERVICE_EXTEND rejects a shorter
`additionalDuration`, rather than granting the smaller window and charging for the floor.
Anything accepted is priced by its actual duration, rounded up to whole minutes. Rejecting is
what keeps the two honest — billing a 100 s top-up as 600 s would let ten of them add 1000 s of
runtime while charging for 6000 s. It defaults to the environment's `minJobDuration`, which is
exactly what services were already billed at, so leaving both new fields unset changes nothing.

Both are separate from `minJobDuration` / `maxJobDuration`, which are per-env too but apply
only to compute jobs.

An environment whose resolved floor exceeds its resolved cap is a **fatal config error**: no
duration could satisfy both, so the node logs the offending environment and refuses to start
rather than advertising an environment that can never be booked.

**Templates are not shipped in the image.** The node reads them from a folder the operator
mounts in, so a node without that mount advertises no templates at all. Point
`serviceTemplatesPath` (env var `SERVICE_TEMPLATES_PATH`) at the mount:

```yaml
volumes:
  - /srv/service-templates:/templates:ro
environment:
  SERVICE_TEMPLATES_PATH: /templates
```

The node re-reads the folder on every request, so edits take effect on the next call — no
restart needed. Layout is one folder per flow, named after the
flow's `id`, with the template itself always at `template.json` inside it. Template secret
values are never returned by the API (only the env-var keys are exposed).

The compute environments a service can run on — and the resources (cpu/ram/disk/gpu) it may
request — are the same ones configured at the node's Docker-connection level for compute jobs,
and services draw from and are counted against the same shared resource pool. For how to
declare resources, configure GPUs, set per-environment constraints, and price them, see the
[Compute Configuration guide](compute.md).

## Hugging Face mirror (DingoSpeed)

Model servers (vLLM, TGI, ComfyUI nodes, notebooks) usually download their weights from
huggingface.co on every start, because a service container starts with an empty HF cache.
A node can point every service at a local caching mirror instead, so the second and later
starts of the same model are served from the host's disk. Off by default; two env vars:

| Env var | Config field | Meaning |
| --- | --- | --- |
| `SERVICE_HF_MIRROR_URL` | `serviceHfMirrorUrl` | Mirror URL as **service containers** reach it, e.g. `http://172.17.0.1:8092`. When set, every service gets `HF_ENDPOINT=<url>` and `HF_HUB_DISABLE_XET=1`. Must be `http://` or `https://`; anything else is logged and the feature stays off (the node still starts). |
| `SERVICE_HF_CLIENT_PATCH` | `serviceHfClientPatch` | Ship the node's download-client patch into services (see below). Defaults to `true` when a mirror is set, `false` otherwise; `false` turns it off, `true` without a mirror applies the patch alone. |

Only **service** containers get any of this; compute jobs are unchanged.

**Precedence.** The service's own env (template `envVars` and the consumer's `userData`)
wins, key by key: a service that sets `HF_ENDPOINT` itself keeps it, and then also keeps
its own choice of `HF_HUB_DISABLE_XET` (the node does not add it — that endpoint is not the
node's mirror). A service that sets only `HF_HUB_DISABLE_XET` (e.g. `0`) gets the mirror
`HF_ENDPOINT` with its own Xet setting.

**Why Xet is disabled.** With Xet on, `huggingface_hub` fetches a xet-read-token and pulls
the file contents from huggingface.co's Xet storage directly, so the mirror would see only
metadata requests. `HF_HUB_DISABLE_XET=1` makes hub use plain HTTP against `HF_ENDPOINT`.

### The download-client patch

Hub's stock plain-HTTP client is GIL-bound: a warm mirror hit tops out around 190-230 MB/s
even on a 160-core host. The node ships `hfpatch/sitecustomize.py`, which swaps
`huggingface_hub.file_download.http_get` for a `urllib` loop that reads into a reused 1 MiB
buffer (the socket read runs without the GIL). Measured inside a vLLM v0.28 service on an
H200, a warm load of the same model took 12.7 s (≈2.5 GB/s) against 157 s with the stock
client and 44 s straight from huggingface.co over Xet. Hub keeps everything else (metadata,
locks, `.incomplete` files, the size check); the swap only happens for hub 1.32-2.2, and any
response it does not handle (an HTTP error, a compressed body, an unhonoured Range) goes to
the stock client before a byte is written.

How the node applies it to a service:

- After creating the service container and before starting it, the node copies
  `sitecustomize.py` into it at `/ocean/hfpatch/sitecustomize.py` through the Docker archive
  API (the same call that creates `/data/outputs`). The bytes travel over the Docker API, so there
  is no host folder, volume or extra setting to configure, and it works the same for a
  containerized node, a node on the host and a remote Docker daemon.
- `PYTHONPATH` is set to `/ocean/hfpatch` followed by what the container would have had
  without the node: the service's own `PYTHONPATH` if its env sets one (as in plain Docker,
  that replaces the image's), otherwise the image's `Config.Env` `PYTHONPATH`. That value is
  kept verbatim, empty entries included (they mean "the working directory"); an unset or
  empty value gives just `/ocean/hfpatch`.
- The patch chains to an image's own `sitecustomize.py` that it shadows.
- Kill switches, as service env vars: `OCEAN_HFPATCH=0` makes the node skip the copy and
  the `PYTHONPATH` change entirely; `OCEAN_HFPATCH_URLLIB=0` keeps the file but leaves
  `http_get` stock. `OCEAN_HFPATCH_DEBUG=1` prints one line per file to stderr.
- It does not apply to `python -I`, `-E` or `-S`, or to a process that replaces `PYTHONPATH`.

The patch never fails a start: if the shipped file cannot be read or the image's env cannot
be read, the node logs a warning and starts the service with the mirror env only. If Docker
refuses the copy — the container has a read-only rootfs, or the image has a regular file at
`/ocean` or `/ocean/hfpatch` — the node removes that never-started container and creates it
again without the patch, before anything else is copied in. Start errors are never retried
for the patch.

**Each container has its own copy.** It lives in the container's writable layer, so a
stop/start of the same container keeps it, and every `serviceRestart` (which always creates
a new container) gets a fresh copy of the node's current `hfpatch/sitecustomize.py` — a node
upgrade reaches running services on their next restart. A non-root service cannot modify
the file; a service running as root (the vLLM and ComfyUI images do) can change its own
copy, which affects only that container, just as setting `OCEAN_HFPATCH=0` or its own
`PYTHONPATH` would. If services are ever given a read-only rootfs, the copy fails on every
start and the patch is silently skipped; delivering it would then need a read-only volume.

### Deploying DingoSpeed

[DingoSpeed](https://github.com/dingodb/dingospeed) is a Go Hugging Face mirror with no
published image, so build it from source at a pinned commit. Each service runs on its own
bridge network, where `host.docker.internal` does not resolve on Linux, but the docker0
gateway (normally `172.17.0.1`) is reachable from every bridge. Publish the mirror on that
address only — **never `0.0.0.0`**: Docker's published ports bypass ufw, so that would open
an unauthenticated mirror (and the HF tokens services send it) to the internet.

```yaml
services:
  dingospeed:
    image: ocean-dingospeed:5671348
    build:
      context: .
      dockerfile_inline: |
        FROM golang:1.23-bookworm AS build
        ARG DINGOSPEED_COMMIT=567134812f76689d17069ead3d8ed527f5f8330f
        ENV CGO_ENABLED=0 GOFLAGS=-mod=readonly
        RUN git clone https://github.com/dingodb/dingospeed /src \
         && cd /src && git -c advice.detachedHead=false checkout --detach "$$DINGOSPEED_COMMIT" \
         && go build -trimpath -ldflags "-s -w" -o /out/dingospeed dingospeed/cmd
        FROM debian:bookworm-slim
        RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates tzdata \
         && rm -rf /var/lib/apt/lists/*
        COPY --from=build /out/dingospeed /usr/local/bin/dingospeed
        WORKDIR /app
        CMD ["/usr/local/bin/dingospeed"]
    restart: unless-stopped
    cap_drop: [ALL]
    security_opt: [no-new-privileges:true]
    ports:
      - '172.17.0.1:8092:8090' # docker0 gateway only, never 0.0.0.0
    volumes:
      - ./dingospeed/config.yaml:/app/config/config.yaml:ro
      - /srv/dingospeed/repos:/app/repos # the cache; must be writable by the container
      - /srv/dingospeed/log:/app/log
```

The container runs as root with every capability dropped, so root cannot write to a
directory it does not own: create `/srv/dingospeed/repos` and `/srv/dingospeed/log` owned by
uid 0 (or make them writable). `./dingospeed/config.yaml`:

```yaml
server:
  mode: release
  host: 0.0.0.0
  port: 8090
  pprof: false
  metrics: true
  online: true # check huggingface.co for every request (see caveats)
  repos: ./repos
  hfNetLoc: huggingface.co # the upstream sample points at hf-mirror.com, a third party: override it
  bpHfNetLoc: huggingface.co
  hfScheme: https
scheduler:
  mode: standalone
  publicDomain: http://172.17.0.1:8092
  linkDomain: http://172.17.0.1:8092
download:
  blockSize: 8388608
  reqTimeout: 0
  respChunkSize: 2048
  respChanSize: 30
  remoteFileBufferSize: 8388608
  remoteFileRangeSize: 0 # one upstream request per file
  remoteFileRangeWaitTime: 0
  goroutineMaxNumPerFile: 8
cache:
  defaultExpiration: 30
  cleanupInterval: 60
  readBlock:
    enabled: false
retry:
  delay: 1
  attempts: 3
diskClean:
  enabled: false
dynamicProxy:
  enabled: false
proxyPool:
  enabled: false
```

Check it from a throwaway container on a fresh bridge, as a service would see it:
`docker network create t && docker run --rm --network t curlimages/curl -sI http://172.17.0.1:8092/openai-community/gpt2/resolve/main/config.json`,
then `docker network rm t`.

### Caveats

- **Cold fills are slow.** The first download of a file goes through the mirror at roughly
  50-85 MB/s, against ~700 MB/s straight from huggingface.co over Xet. The mirror pays off
  from the second start of the same revision; a node that rarely repeats a model gains little.
- **HF rate limits in online mode.** `online: true` re-asks huggingface.co on every HEAD/GET,
  so under anonymous HTTP 429s even cached files fail to serve. A service that passes its own
  `HF_TOKEN` avoided that in testing; the token is forwarded to the mirror and on to HF.
- **Gated repos are untested.** Whether a gated file cached with one consumer's token can be
  read by another consumer without one has not been tested. Treat the mirror as able to leak
  gated content between services until it is.
- **Only `huggingface_hub` uses it.** Clients that do not read `HF_ENDPOINT` bypass the mirror
  (curl/wget of absolute `huggingface.co` URLs, `git lfs`, ComfyUI nodes that download by
  absolute URL). Non-hub clients that do honour it, such as `llama.cpp -hf`, get no speed-up
  from the patch, which only replaces `huggingface_hub`'s own download function.
- The mirror sees every service's model requests and any `HF_TOKEN` they send.

## Security model & important notices

- **Container hardening.** Service containers are created with
  `SecurityOpt: ['no-new-privileges']`, `CapDrop: ['ALL']`, and `PidsLimit: 512`.
  Unlike the compute path, the service path does **not** force a non-root `User` —
  arbitrary service images often expect to start as root, so the image's declared user
  is kept. Dropping all capabilities + `no-new-privileges` keeps that root process
  unprivileged. `PidsLimit` is the only one of the three an operator can raise, via
  `init.advanced` on a resource (see the next-to-last bullet).

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
  revoked owner can still shut their own service down. The same goes for the
  `outputBucketId`: `start`, `extend` and `restart` all check that the owner may still use
  the bucket, and refuse with `403` (before any payment or teardown) once they may not —
  e.g. bucket sharing was turned off, the owner was removed from the bucket's access list,
  or the bucket was deleted. A running service keeps its mount until `expiresAt`.

- **No privileged/advanced Docker config, with three narrow exceptions.** The service path
  deliberately omits most of the advanced Docker config the compute path supports — host
  bind mounts, extra capabilities, `seccomp:unconfined`, devices beyond the priced GPU
  pool. Do not thread those in.

  The exceptions are `ShmSize`, `IpcMode` and `PidsLimit`, read from the **operator's**
  `init.advanced` block on a requested resource (see
  [Multi-GPU workloads](compute.md#multi-gpu-workloads-shared-memory)). They are required
  for any service spanning more than one GPU: Docker's default 64 MB `/dev/shm` is too
  small for the per-GPU worker processes such a service starts, and it fails at boot
  without them.

  These come only from node configuration. Nothing in a service template, `userData`, or
  the start request can set them — a consumer-selected template able to ask for
  `IpcMode: 'host'` would be a way out of the `CapDrop: ['ALL']` sandbox. Keep it that way.

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

- **`serviceResult` is authenticated and owner-scoped, like `serviceStreamableLogs`.** A
  service's outputs are its owner's data; a non-owner gets the same `400` as an unknown
  `serviceId`. The node-wide `serviceList` leaves out `outputArchives`.

- **`allowImageBuild` runs arbitrary build instructions.** When enabled, a consumer's
  inline `dockerfile` is built by the Docker daemon, so its `RUN` steps execute arbitrary
  commands in the daemon's build sandbox. Leave it disabled unless you intend to offer
  build-from-source and trust the consumer set.
