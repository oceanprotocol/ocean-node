# Ocean Node Database Configuration

Ocean Node keeps all its data in one database. You must select the database with `DB_TYPE`:
a node with no `DB_TYPE` does not start. The node does not get the type from `DB_URL`, and it
does not check the URL: the driver of `DB_TYPE` connects to it as given.

| `DB_TYPE`       | When to use it                                | What the node needs                                |
| --------------- | --------------------------------------------- | -------------------------------------------------- |
| `sqlite`        | One node instance. No database container.     | Nothing. The files are in the `databases/` folder. |
| `postgresql`    | Several node instances on one database.       | `DB_URL`, `DB_USERNAME`, `DB_PASSWORD`             |
| `elasticsearch` | Several node instances, or a large catalogue. | `DB_URL`, `DB_USERNAME`, `DB_PASSWORD`             |

There is no mode that runs without a database. The node tries to open its database a few
times at start (`DB_INIT_MAX_ATTEMPTS`), then stops.

The database holds two groups of data:

- **Index data**, which the indexer reads from the chains: DDOs, DDO states, orders, access
  lists, escrow events, and the last indexed block of each chain. The logs are here too when
  `LOG_DB` is on. The node can make this data again from the chains.
- **Node state**: compute jobs, service jobs, Docker image records, service locks, nonces,
  auth tokens, node settings, persistent-storage buckets and node metrics.

## Database Configuration

### SQLite

Set `DB_TYPE="sqlite"`. The node makes these files in `databases/` (next to `p2p-store`, the libp2p
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

## DDO search

The query of the node is the same on all databases: a JSON object with a type, typed
filters, a sort key and a page. It has the searches that the markets use, and nothing more.
Each database runs it with its own fixed queries: there is no Elasticsearch query syntax, and
an Elasticsearch body (with `query`, `from` or `index`) gives HTTP 400.

```json
{
  "type": "assets",
  "filter": { "chainIds": [8996], "types": ["dataset"], "text": "weather" },
  "sort": { "by": "created", "order": "desc" },
  "page": 1,
  "size": 21
}
```

The answer is `{ "results": [...], "totalResults": 42 }`: one list for the DDOs of all
versions (v4 and v5), sorted and paged over all of them.

| Field    | Value                                                                                                                                     |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `type`   | `assets` (the default), `orders` or `tags`                                                                                                |
| `filter` | The filters below. With `orders`: `{ "consumer": "0x…" }` or `{ "payer": "0x…" }`                                                         |
| `sort`   | `assets` only. `by`: `created` (the event block), `orders`, `price`, `tokenSymbol` or `relevance`; `order`: `asc` or `desc` (the default) |
| `page`   | Starts at 1. `page` × `size` is 10000 at most                                                                                             |
| `size`   | 0 to 10000, 1000 when absent. With `tags`: the largest number of tags                                                                     |

The asset filters. A filter that is not set adds no condition; all filters that are set must
hold. Each filter covers the field of a DDO v4 and of a DDO v5 (`credentialSubject.…`).

| Filter                                         | Matches                                                                                                                        |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `chainIds`                                     | `chainId` is one of the values                                                                                                 |
| `versions`                                     | the DDO `version` is one of the values, for example `"5.0.0"`                                                                  |
| `ids`, `excludeIds`                            | the DID is (is not) one of the values                                                                                          |
| `excludeNftAddresses`                          | `nftAddress` is not one of the values                                                                                          |
| `owners`                                       | `indexedMetadata.nft.owner` is one of the values                                                                               |
| `anyOf: [{ ids, owners, datatokenAddresses }]` | in each group, one of the lists matches (DID, owner, a service datatoken). All groups must hold                                |
| `types`                                        | `metadata.type`: `dataset`, `algorithm`                                                                                        |
| `serviceTypes`                                 | a service has the type: `access`, `compute`                                                                                    |
| `datatokenAddresses`                           | a service has one of the datatokens                                                                                            |
| `tags`                                         | `metadata.tags` has one of the values                                                                                          |
| `text`                                         | each word is in the name, description, author, tags, owner, or datatoken name, symbol or address; or the whole text is the DID |
| `nftStates`                                    | `indexedMetadata.nft.state` is one of the values                                                                               |
| `includeUnlisted`                              | `true` also gives the unlisted assets (state 5). Not set: they are hidden, also when `nftStates` has 5                         |
| `includePurgatory`                             | `true` also gives the assets in purgatory. Not set: they are hidden                                                            |
| `priceTypes`, `excludePriceTypes`              | `indexedMetadata.stats.prices.type` is (is not) one of the values                                                              |
| `createdAfter`                                 | `metadata.created` is at or after the ISO date                                                                                 |
| `serviceEndpoints`                             | a service has one of the endpoints                                                                                             |
| `dataspace`                                    | `credentialSubject.dataspace` is the value                                                                                     |
| `trustedAlgorithm: { did, serviceId }`         | a compute service trusts the algorithm (`"*"`: all algorithms)                                                                 |
| `trustedAlgorithmPublisher`                    | a compute service trusts the publisher (`"*"`: all publishers)                                                                 |
| `indexedOnly`                                  | the DDO has `indexedMetadata`                                                                                                  |

`type: "tags"` answers the distinct tags of the assets that match the filter, the most used
first: `{ "results": [{ "tag": "weather", "count": 2 }], "totalResults": 1 }`.

An address (owner, datatoken, NFT, consumer, payer) matches in any letter case. The databases
differ in these points:

- `text`: on SQLite and PostgreSQL a word matches when a value contains it; on Elasticsearch
  it matches a word of a value, or the start of one.
- `relevance` sorts by the text score on Elasticsearch, then the newest first; SQLite and
  PostgreSQL have no score and give the newest first.
- `price` is stored as text: SQLite and PostgreSQL sort it as a number, Elasticsearch as text.
- The tags of a `tags` answer are in lower case on SQLite and PostgreSQL. Their comparisons
  ignore the letter case; on Elasticsearch a tag, a type and an id must match exactly.
- A value longer than 512 characters is searchable by its first 512 characters on SQLite and
  PostgreSQL.

## Upgrade from an older release, and a change of database

The older releases had no `DB_TYPE`. Add it to the compose file or `.env` of every node, or
the node does not start.

The older releases kept the node state in the SQLite files of `databases/` also when the
index data was in Elasticsearch. The node state does not move from these files to a database
server, and it does not move between databases. You have two choices:

- Keep the state: set `DB_TYPE=sqlite` (and remove `DB_URL`). The node makes the index data
  again in SQLite.
- Start with empty state on the database server: stop the node when it has no running jobs
  or services, then set `DB_TYPE` to `postgresql` or `elasticsearch`. The node does not use
  the SQLite files that stay in `databases/`. With no nonces, a signed request that the node
  accepted before can be accepted again, and the paid jobs in the SQLite files are not
  claimed.

A node that used Elasticsearch in an older release keeps its Elasticsearch, but four indices
changed: `logs` is now `log`, `state` is now `ddo_state`, `access_list` keeps `chainId` as a
`long`, and `op_ddo_v5.0.0` indexes the trusted algorithms of a compute service (the DDO
search filters on them). The node does not change an index that exists. Before the first
start, delete the indices `logs`, `state`, `access_list` and `op_ddo_v5.0.0`. The node state
of the older release is in SQLite, so the node settings on Elasticsearch hold no index
version: at the first start the node indexes all chains again, and makes these indices
again.

The DDO search of the older releases took an Elasticsearch query body. It now takes the
query of the "DDO search" section on all databases, and answers `{ results, totalResults }`:
a client that sends an Elasticsearch body gets HTTP 400.

A compose file of an older release can have a `DB_URL` for Typesense, which the node no longer
supports. Remove the `DB_URL` line and the Typesense service, and set `DB_TYPE=sqlite`: the
node keeps its state in `databases/` and makes the index data again from the chains.

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
