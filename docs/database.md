# Ocean Node Database Configuration

Ocean Node keeps all its data in one database. You select the database with `DB_TYPE`.
With no `DB_TYPE` and no `DB_URL`, the node uses SQLite. With no `DB_TYPE` and a `DB_URL`,
the node uses the database server that the URL is for (`http(s)://` is Elasticsearch,
`postgresql://` is PostgreSQL), as the older releases did.

| `DB_TYPE`          | When to use it                                                                                    | What the node needs                                |
| ------------------ | ------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `sqlite` (default) | One node instance. No database container.                                                         | Nothing. The files are in the `databases/` folder. |
| `postgresql`       | Several node instances on one database.                                                           | `DB_URL`, `DB_USERNAME`, `DB_PASSWORD`             |
| `elasticsearch`    | Several node instances, a large catalogue, or the full Elasticsearch query syntax for DDO search. | `DB_URL`, `DB_USERNAME`, `DB_PASSWORD`             |

There is no mode that runs without a database. A node that cannot open its database stops.

The database holds two groups of data:

- **Index data**, which the indexer reads from the chains: DDOs, DDO states, orders, access
  lists, escrow events, and the last indexed block of each chain. The logs are here too when
  `LOG_DB` is on. The node can make this data again from the chains.
- **Node state**: compute jobs, service jobs, Docker image records, service locks, nonces,
  auth tokens, node settings, persistent-storage buckets and node metrics.

## Database Configuration

### SQLite (default)

Set nothing. The node makes these files in `databases/` (next to `p2p-store`, the libp2p
datastore):

| File                       | Content                                                  |
| -------------------------- | -------------------------------------------------------- |
| `c2dDatabase.sqlite`       | compute jobs, service jobs, image records, service locks |
| `nonceDatabase.sqlite`     | nonces                                                   |
| `authTokenDatabase.sqlite` | auth tokens                                              |
| `config.sqlite`            | node settings                                            |
| `persistentStorage.sqlite` | persistent-storage buckets                               |
| `nodeMetrics.sqlite`       | node metrics history                                     |
| `index.sqlite`             | the index data and the logs                              |

One `databases/` folder is for one node instance. Two instances must not use the same folder.
In Docker, mount a volume on `/usr/src/app/databases`, or the data is lost when the container
is replaced.

### PostgreSQL

```bash
DB_TYPE="postgresql"
DB_URL="postgresql://localhost:5432/ocean"   # host, port and database name
DB_USERNAME="ocean"
DB_PASSWORD="changeme"
```

The node makes its tables in the database of the URL. Several instances can use one database.
For local development, `docker-compose -f postgresql-compose.yml up -d` starts PostgreSQL
with these values.

### Elasticsearch

```bash
DB_TYPE="elasticsearch"
DB_URL="http://localhost:9200"
DB_USERNAME="elastic"
DB_PASSWORD="changeme"
```

The node makes its indices: the DDO indices (`op_ddo_*`), `indexer`, `log`, `order`,
`ddo_state`, `access_list`, `escrow`, and the node state indices `nonce`, `node_config`,
`auth_tokens`, `buckets`, `node_metrics_samples`, `node_metrics_hourly`, `c2d_jobs`,
`service_jobs`, `docker_images` and `service_locks`. For local development,
`docker-compose -f elasticsearch-compose.yml up -d` starts Elasticsearch with these values.
Barge starts one too:

```bash
./start_ocean.sh --no-aquarius --no-provider --no-dashboard --with-c2d
```

## Do not publish the database

The database holds the node state, and the database user of the node has full access. Do not
publish the port of PostgreSQL or Elasticsearch to the internet: only the node must reach it.
`scripts/ocean-node-quickstart.sh` makes a compose file where the database has no published
port, and a random database password for each new deployment. The development compose files
bind the port to `127.0.0.1` and use the password `changeme`.

A database server reads its password only when it creates its data. To use your own password,
change it for the node and for the database before the first start. For the same reason,
remove the data volume of a database before you select that database again in the quickstart
script: the script makes a new password, and the old volume keeps the old one.

Frontends read DDOs through the node: the `query` command and
`POST /api/aquarius/assets/metadata/query`.

## DDO queries

The query of the node is the Elasticsearch query body (`query`, `sort`, `from`, `size`) on all
databases. `from` is a page number that starts at 1, and `size` is 100 when absent. The answer
is one array of documents for each DDO schema that has hits.

The `index` field selects what the query reads:

- `order`: the orders.
- the name of a DDO schema (for example `op_ddo_v4.1.0`): the DDOs of that schema.
- all other values, or no `index`: all DDOs.

A query cannot read the other data of the node.

Elasticsearch runs the full query syntax. SQLite and PostgreSQL run this part of it:

| Part                    | Support                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bool`                  | `must`, `filter`, `should`, `must_not`, nested. `minimum_should_match` can be `0` or `1`.                                                                                                                                                                                                                                                                                                                                                     |
| `term`, `terms`         | Equal to the value, or to one of the values.                                                                                                                                                                                                                                                                                                                                                                                                  |
| `match`, `match_phrase` | The value contains the text.                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `range`                 | `gt`, `gte`, `lt`, `lte`. A number, or a text that holds a number (a price `"10"`), is compared as a number; other text (an ISO date) as text. A date is not rounded: `lte: "2022-06-10"` does not include the times of that day, and a time-zone offset is not converted.                                                                                                                                                                    |
| `exists`, `match_all`   | Yes.                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `query_string`          | Simplified: the words of the text, with `AND` or `OR` between them (`default_operator`), in the fields of `fields`. A word matches when a value contains it. Wildcards, quotes, parentheses, boosts, `minimum_should_match` and `phrase_slop` are not evaluated. The other operators (`NOT`, `+word`, `-word`, `field:word`, `word~`, `?`) give HTTP 400 when they are not escaped with a backslash, and so does a `*` in a name of `fields`. |
| `sort`                  | One to eight fields, `asc` or `desc`. A text that holds a number sorts as a number. `_score` gives no order: there is no relevance. Other sort options (`missing`, `mode`) give HTTP 400.                                                                                                                                                                                                                                                     |
| `aggs`                  | Accepted and not evaluated. The answer of the node holds documents only, on all databases.                                                                                                                                                                                                                                                                                                                                                    |

On these two databases:

- Text comparison ignores the letter case. Text is compared and sorted by its bytes, so the
  order is the same on SQLite and PostgreSQL.
- `match` looks for the text as one piece: `weather ocean` does not find `ocean weather`.
- A `.keyword` suffix on a field name has no effect, and `_id` is the `id` field.
- A field in an array (`services.type`) matches when one element matches.
- A value longer than 512 characters is searchable by its first 512 characters.
- All other clauses and options (`wildcard`, `nested`, `script`, a terms lookup, `operator`
  in `match`, ...) give HTTP 400 with `Query clause '<name>' is not supported on the <DB_TYPE>
database`. The node never ignores a clause or an option.
- A query has limits: 1024 conditions (each value of `terms` and each word of `query_string`
  is one), 20 levels of `bool`, and one field for each leaf clause. A query over a limit, or
  with a part of a wrong type, gives HTTP 400.

On all databases, `size` and `from` must be whole numbers, 0 or more, and the `query` command
reads the first 10000 documents at most.

## Upgrade from an older release, and a change of database

The older releases kept the node state in the SQLite files of `databases/` also when the
index data was in Elasticsearch. The node state does not move from these files to a database
server, and it does not move between databases. A node that starts on empty state is not
safe: with no nonces, a signed request can be sent again, and paid jobs are not claimed.

So a node with `DB_TYPE` `postgresql` or `elasticsearch` does not start while `databases/`
holds node state files (`c2dDatabase.sqlite`, `nonceDatabase.sqlite`,
`authTokenDatabase.sqlite`, `config.sqlite`, `persistentStorage.sqlite`,
`nodeMetrics.sqlite`). The error message names the files. You have two choices:

- Keep the state: set `DB_TYPE=sqlite` (and remove `DB_URL`). The node makes the index data
  again in SQLite.
- Start with empty state on the database server: stop the node when it has no running jobs
  or services, then remove these files.

A node that used Elasticsearch in an older release keeps its Elasticsearch, but three indices
changed: `logs` is now `log`, `state` is now `ddo_state`, and `access_list` keeps `chainId`
as a `long`. The node does not change an index that exists. Before the first start, delete
the indices `logs`, `state` and `access_list`. The node state of the older release is in
SQLite, so the node settings on Elasticsearch hold no index version: at the first start the
node indexes all chains again, and makes `ddo_state` and `access_list` again.

A compose file of an older release can have a `DB_URL` for a database that the node no longer
supports. The node reads an `http(s)` URL as Elasticsearch and stops with
`DB_USERNAME and DB_PASSWORD are required when DB_TYPE is elasticsearch`. Remove the `DB_URL`
line and the service of that database from the compose file: the node then uses SQLite, keeps
its state in `databases/`, and makes the index data again from the chains.

## Auth tokens

The node stores only the sha256 hash of each auth token, never the token itself. A daily cron job deletes expired and
invalidated tokens.

## Node metrics history

Node metrics history is kept per instance. Instances that share one `PRIVATE_KEY` share one peer id, so the node
keys its metrics by `INSTANCE_ID`, or by the hostname when `INSTANCE_ID` is not set. A history
request answers from the instance that receives it. In containers the hostname changes on
redeploy, so container deployments set `INSTANCE_ID` (see [env.md](env.md)). Retention
runs per instance id, so the node never sweeps the rows of a retired `INSTANCE_ID`: set
`INSTANCE_ID` to a stable value.

## Runtime metrics on C2D job records

While a compute job or Service-on-Demand container runs, the node periodically samples live
Docker (and, on NVIDIA hosts, NVML) metrics — CPU, RAM, disk usage vs quota, network, block
I/O, PID count, CPU throttling, memory peak, exit/OOM info, and per-GPU utilization/memory —
and stores the latest snapshot on the job record (inside the JSON `body` of the compute job
or service job). A **final** snapshot is written at termination
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
