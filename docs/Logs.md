# Logs

Refer to Logs section in the [environmental variables documentation](env.md#logs) for information on how to configure the logs.

## Log Retrieval using HTTP

### Get Multiple Logs

HTTP GET /logs

This endpoint retrieves multiple log entries based on various query parameters. If query parameters are not provided, it defaults to the last 24 hours of logs and a maximum of 100 log entries. Please replace the `startTime`, `endTime` values with actual data as per your requirement when making requests.

**Query Parameters:**

- `startTime` (optional): The start time for logs retrieval in ISO 8601 format.
- `endTime` (optional): The end time for logs retrieval in ISO 8601 format.
- `maxLogs` (optional): The maximum number of log entries to retrieve.
- `moduleName` (optional): The module name to filter the logs.
- `level` (optional): The log level to filter the logs (e.g., "info", "error").

**Example Request:**

```http
GET /logs?startTime=2023-01-01T00:00:00Z&endTime=2023-01-02T00:00:00Z&maxLogs=50&moduleName=auth&level=info

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

If no logs are found for the given criteria, you will receive a `404 Not Found` response.

### Get a Single Log by ID

HTTP GET /log/:id

This endpoint retrieves a single log entry by its unique identifier.

**Path Parameters:**

- `id`: The unique identifier of the log entry.

Example Request:

```http
GET /log/123456789
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

The logging system provides a convenient way to retrieve logs via a command-line script. The script is capable of fetching logs with various filters, such as start time, end time, maximum number of logs, module name, and log level.

**Usage**
You can call the script directly from your command line with optional parameters to filter the logs. The parameters are as follows:

- `API_URL`: The URL of the logs API endpoint. Defaults to http://localhost:8000.
- `START_TIME`: The start time for the logs you want to retrieve. Defaults to 24 hours before the current time.
- `END_TIME`: The end time for the logs you want to retrieve. Defaults to the current time.
- `MAX_LOGS`: The maximum number of logs to retrieve. Defaults to 100.
- `MODULE_NAME`: The specific module name to filter the logs. Optional.
- `LEVEL`: The specific log level to filter the logs. Optional.

**Example Without Parameters (Uses Defaults):**

```bash
npm run logs
```

**Example With Specific Parameters:**

```
npm run logs http://localhost:8000 "2023-11-01T00:00:00Z" "2023-11-30T23:59:59Z" 50 "http" "info"
```

## Compute/Service runtime metrics in the logs

While compute jobs and services run, the node samples live container stats (CPU, RAM, disk,
network, block I/O, PIDs, exit info, GPU) every `C2D_METRICS_INTERVAL_SECONDS` — see
[env.md](env.md). Every one of those lines is logged at **debug** level by the `CORE` module
with a `[metrics]` tag, so one filter shows the whole picture:

```bash
# everything metrics-related (needs LOG_LEVEL=debug)
grep '\[metrics\]' logs/*.log

# just the engine-wide roll-up: one line per sampling interval
grep '\[metrics\] summary' logs/*.log

# just the workloads close to a limit (mem/disk/pids/cpu-throttling)
grep '\[metrics\] pressure' logs/*.log

# one specific job or service, sample by sample
grep '\[metrics\] job 88ee41c8' logs/*.log
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
