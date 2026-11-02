# Logs

Refer to Logs section in the [environmental variables documentation](env.md#logs) for information on how to configure the logs.

## Where logs go

| Sink | Default | Level | Controlled by |
| --- | --- | --- | --- |
| Console (stdout) | on | `LOG_LEVEL` (`info` in production, `debug` otherwise) | `LOG_CONSOLE` (`false` turns it off) |
| Files on disk (`logs/`) | on when `LOG_DB` is off | `LOG_FILES_LEVEL` (default `info`), 30 days retention | `LOG_FILES`, `LOG_FILES_*` |
| Log database | off | `LOG_LEVEL` | `LOG_DB` (needs `DB_URL`), `LOG_RETENTION_TIME` |

- The console stays on whatever `LOG_FILES` and `LOG_DB` are set to. Use `LOG_CONSOLE=false` to turn it off.
- If `LOG_DB=true` but the log database cannot be used (no `DB_URL`, init failed, degraded mode), the node falls back to files on disk and logs a warning. `LOG_FILES=false` disables that fallback.
- In Docker, mount `./logs:/usr/src/app/logs` (the quickstart compose file does) or the files are lost when the container is recreated. See [dockerDeployment.md](dockerDeployment.md).
- With PM2, files are written to `logs/` in the node's working directory. PM2 also keeps stdout in `~/.pm2/logs`, which is not size-limited unless `pm2-logrotate` is installed.

### Log files on disk

One rotating file per module, plus one exceptions file:

```text
logs/
  core-2025-06-01.log        # today's file for the CORE module
  core-2025-05-31.log.gz     # older days are gzipped
  core-2025-06-01.1.log      # part 2 of the day, created when LOG_FILES_MAX_SIZE is reached
  core-current.log           # symlink to the active file
  .core-audit.json           # rotation bookkeeping
  exceptions-2025-06-01.log  # uncaught exceptions, all modules
```

- Modules: `oceannode`, `core`, `database`, `http`, `indexer`, `p2p`, `provider`, `config`, plus `reindexer` and `all` (lines from loggers with an unrecognised module name). A file appears when its module first logs something at or above `LOG_FILES_LEVEL`.
- Unhandled promise rejections are logged at `error` in `oceannode-*.log`, not in the exceptions file.
- Days are UTC. Files older than `LOG_FILES_RETENTION_DAYS` are deleted automatically.
- Each line is a JSON object with sorted keys: `component`, `level`, `message`, `moduleName`, `timestamp` (ISO 8601).
- The hidden `.<module>-audit.json` files track which files to rotate and delete. Do not delete or rename them.
- Old `logs/<module>.log` and `<module>_exceptions.log` files from earlier versions have no timestamps and are never deleted by the rotator. They can be removed by hand.

```bash
tail -F logs/core-current.log                  # follow a module live
zgrep -h '"level":"error"' logs/*.log*         # errors across modules, including .gz archives
```

## Log Retrieval using HTTP

Both endpoints are admin-only and signed (`POST`). Send `address`, `signature` and `nonce` in the body (auth tokens are not accepted for admin commands). The address must be in `ALLOWED_ADMINS`. The same parameters are available over P2P with the `getLogs` command (`PROTOCOL_COMMANDS.GET_LOGS`). See [API.md](API.md#logs).

### Get Multiple Logs

HTTP POST /logs

Retrieves log entries, newest first. Parameters are optional and can be sent as query parameters:

- `startTime`: start of the window, ISO 8601 or epoch milliseconds. Default: 7 days before `endTime`.
- `endTime`: end of the window, ISO 8601 or epoch milliseconds. Default: now.
- `maxLogs`: entries per page. Default `100`, maximum `1000`.
- `moduleName`: filter by module name (case-insensitive, e.g. `core`). Uncaught exceptions are tagged `OCEANNODE`.
- `level`: filter by exact level (e.g. `info`, `error`).
- `page`: 1-based page number.

An invalid `startTime`/`endTime` returns `400`.

**Where results come from:**

- Log database, when `LOG_DB` is on and the log database is available.
- Otherwise the rotating files on disk. Entries come back newest first, have no `id`, and only include levels at or above `LOG_FILES_LEVEL`. If `moduleName` is not a known module, the result is empty.

**Example Request:**

```http
POST /logs?startTime=2023-01-01T00:00:00Z&endTime=2023-01-02T00:00:00Z&maxLogs=50&moduleName=http&level=info
Content-Type: application/json

{ "address": "0x...", "signature": "0x...", "nonce": "1700569124" }
```

**Example Response:**

```json
[
  {
    "timestamp": 1700569124922,
    "level": "info",
    "message": "User logged in successfully.",
    "moduleName": "HTTP"
  },
  {
    "timestamp": 1700569124922,
    "level": "info",
    "message": "Session refreshed.",
    "moduleName": "HTTP"
  }
  // More log entries...
]
```

If no logs are found for the given criteria, the response is `200` with an empty array (`[]`).

### Get a Single Log by ID

HTTP POST /log/:id

Retrieves one log entry. The id is read from `logId` in the request body, together with the same auth fields. This works only with `LOG_DB` and an available log database, because file entries have no id; otherwise the response is `404`.

```http
POST /log/123456789
Content-Type: application/json

{ "logId": "123456789", "address": "0x...", "signature": "0x...", "nonce": "1700569124" }
```

```json
{
  "id": "1",
  "level": "info",
  "message": "NEW Test log message 1700569124912",
  "timestamp": 1700569124922,
  "moduleName": "HTTP"
}
```

If the log with the given ID is not found, you will receive a `404 Not Found` response. For server errors, you will receive a `500 Internal Server Error` response.

## Log Retrieval Using Script

`scripts/logs.sh` (`npm run logs`) is currently broken: it sends an unsigned `GET`, but `/logs` is a signed `POST`, so it is rejected. Use `ocean-cli downloadNodeLogs` instead, or read the files in `logs/` directly.

## Compute/Service runtime metrics in the logs

While compute jobs and services run, the node samples live container stats (CPU, RAM, disk,
network, block I/O, PIDs, exit info, GPU) every `C2D_METRICS_INTERVAL_SECONDS` — see
[env.md](env.md). All of those lines come from the `CORE` module with a `[metrics]` tag, so one
filter shows the whole picture. Samples, summaries and pressure lines are logged at **debug**:
they reach the console only with `LOG_LEVEL=debug` and disk only with `LOG_FILES_LEVEL=debug`
(the default file level is `info`). Collection failures (`collection failed`, `could not
sample`, `… sample failed`, `… counter failed`) are logged at **error**, so they are visible at
the default levels:

```bash
# follow live on disk
tail -F logs/core-current.log | grep --line-buffered '\[metrics\]'

# console instead (needs LOG_LEVEL=debug)
docker logs ocean-node 2>&1 | grep '\[metrics\]'

# everything metrics-related (needs LOG_FILES_LEVEL=debug; zgrep also reads .gz archives)
zgrep '\[metrics\]' logs/core-*.log*

# just the engine-wide roll-up: one line per sampling interval
zgrep '\[metrics\] summary' logs/core-*.log*

# just the workloads close to a limit (mem/disk/pids/cpu-throttling)
zgrep '\[metrics\] pressure' logs/core-*.log*

# one specific job or service, sample by sample
zgrep '\[metrics\] job 88ee41c8' logs/core-*.log*
```

What each tag means:

| line | when | what it tells you |
| --- | --- | --- |
| `[metrics] C2D Engine <hash>: sampling every Ns` / `collection DISABLED` | engine start | whether metrics are being collected at all — the first thing to check when a job shows no `runtimeMetrics` |
| `[metrics] summary engine <hash>: …` | once per interval | totals across every sampled job/service on that engine: cpu % of host, cores allocated, memory used vs allocated, disk, network, GPU count, how many containers are cpu-throttled, and the age of the oldest sample |
| `[metrics] pressure job\|service <id>: …` | once per interval, only when relevant | that workload is ≥90% of its memory limit (OOM-kill risk), ≥90% of its disk quota (stop risk), ≥80% of its PID limit, or is being cpu-throttled (undersized `cpu` request) |
| `[metrics] job\|service <id>: cpu … mem … disk … pids … net … blkio … state …` | per sample | the full `docker stats` view of that container, plus throttling, peak memory, disk vs quota, exit info and GPU. `[final]` marks the last snapshot taken before teardown |
| `[metrics] job <id>: first snapshot …` | first sample of a job | reminder that `cpu` reads 0% until the second sample (deltas need two samples) |
| `[metrics] … dropping sample …` / `collection failed …` | on failure | why a snapshot is missing: the container vanished, or a lifecycle operation was in flight |
| `[metrics] gpu: …` and `GPU metrics (nvidia): …` | on failure | no GPU numbers, and why. Each message is explained — with its fix — in [compute.md → Troubleshooting GPU metrics](compute.md#troubleshooting-gpu-metrics) |

These are pure diagnostics — collection is best-effort and never affects job or service
execution. The same numbers are available over the API to the owner of a job/service
(`runtimeMetrics` on `COMPUTE_GET_STATUS` / `SERVICE_GET_STATUS`, see [API.md](API.md)).

### When a status response has no `runtimeMetrics`

Snapshots are persisted on the job record, so you can check the stored state directly instead
of guessing whether they were never written or dropped on the way out:

```bash
npm run job-metrics              # the 5 most recent jobs
npm run job-metrics -- 018c0121  # one job (full id or any trailing part)
```

For each job it prints whether the row holds a snapshot, its values, and whether the delta
accumulator that CPU % needs is there. Read-only; run it from the node's working directory.

- **`runtimeMetrics: ABSENT`** — nothing was ever stored for that job, so the API cannot return
  it and `cpu usagePercent` stays 0 (each sample would be a "first sample"). The node also warns
  about this itself: `[metrics] job <id>: no previous snapshot after Ns of runtime`.
- **present, but missing from the response** — the caller was not recognised as the owner.
  Metrics only go to the job's owner (or an `additionalViewers` address), proven by
  `consumerAddress` + signature/nonce or an `Authorization` token issued to that same address.
