# Environmental Variables

Environmental variables are also tracked in `ENVIRONMENT_VARIABLES` within `src/utils/constants.ts`. Descriptions and example values are provided below:

## Core

- `PRIVATE_KEY` (Required): The private key for the node, required for node operations. Example: `"0x1d751ded5a32226054cd2e71261039b65afb9ee1c746d055dd699b1150a5befc"`
- `CONFIG_PATH`: Absolute path to JSON config file
- `RPCS`: JSON object defining RPC endpoints for various networks. Example: `"{ \"11155420\":{ \"rpc\":\"https://sepolia.optimism.io\", \"fallbackRPCs\": [\"https://public.stackup.sh/api/v1/node/optimism-sepolia\"], \"chainId\": 11155420, \"network\": \"optimism-sepolia\", \"chunkSize\": 1000 }}"`
- `DB_URL`: URL for connecting to the database. Required for running a database with the node. Example: `"http://localhost:8108/?apiKey=xyz"`
- `IPFS_GATEWAY`: The gateway URL for IPFS, used for downloading files from IPFS. Example: `"https://ipfs.io/"`
- `ARWEAVE_GATEWAY`: The gateway URL for Arweave, used for downloading files from Arweave. Example: `"https://arweave.net/"`
- `LOAD_INITIAL_DDOS`: If set, the node will load initial DDOs from JSON files at startup. This is useful for testing or bootstrapping the network with predefined data. Example: `false`
- `FEE_TOKENS`: Mapping of chain IDs to token addresses for setting fees in the network. Example: `"{ \"1\": \"0x967da4048cD07aB37855c090aAF366e4ce1b9F48\", ...}"`
- `FEE_AMOUNT`: Specifies the fee amount and unit (e.g., MB for megabytes). Example: `"{ \"amount\": 1, \"unit\": \"MB\" }"`
- `ADDRESS_FILE`: File location where Ocean contract addresses are saved. Example: `"ADDRESS_FILE=${HOME}/.ocean/ocean-contracts/artifacts/address.json"`
- `NODE_ENV`: Typically used to specify the environment (e.g., development, production) the node is running in. Example: `'development'`
- `AUTHORIZED_DECRYPTERS`: A JSON array of addresses that are authorized to decrypt data. Example: `"['0xe2DD09d719Da89e5a3D0F2549c7E24566e947260']"`
- `AUTHORIZED_DECRYPTERS_LIST`: AccessList contract addresses (per chain). If present, only accounts present on the given access lists can decrypt data. Example: `"{ \"8996\": [\"0x967da4048cD07aB37855c090aAF366e4ce1b9F48\",\"0x388C818CA8B9251b393131C08a736A67ccB19297\"] }"`
- `OPERATOR_SERVICE_URL`: Configures C2D cluster URLs for the node. Example: `"[\"http://example.c2d.cluster1.com\",\"http://example.cd2.cluster2.com\"]"`
- `INTERFACES`: Network interfaces the node supports, e.g., HTTP and P2P. By default, if not specified, both are supported. Example: `"[\"HTTP\",\"P2P\"]"`
- `ALLOWED_VALIDATORS`: Array of addresses for allowed validators to verify asset signatures before indexing. Example: `"[\"0x123\",\"0x456\"]"`
- `ALLOWED_VALIDATORS_LIST`: Array of access list addresses (per chain) for allowed validators to verify asset signatures before indexing. Example: `"{ \"8996\": [\"0x123\",\"0x456\"]"`
- `INDEXER_INTERVAL`: Sets the interval in milliseconds for the indexer to crawl. The default is 30 seconds if not set. Example: `10000`
- `INDEXER_NETWORKS`: Specifies the networks the Indexer will crawl. If not set, the Indexer will index all networks defined in the RPCS environment variable. If set to an empty string, indexing will be disabled. Example: `[1, 137]`
- `ALLOWED_ADMINS`: Sets the public address of accounts which have access to admin endpoints e.g. shutting down the node. Example: `"[\"0x967da4048cD07aB37855c090aAF366e4ce1b9F48\",\"0x388C818CA8B9251b393131C08a736A67ccB19297\"]"`
- `ALLOWED_ADMINS_LIST`: Array of access list addresses (per chain) for accounts that have access to admin endpoints. Example: `"{ \"8996\": [\"0x123\",\"0x456\"]"`
- `RATE_DENY_LIST`: Blocked list of IPs and peer IDs. Example: `"{ \"peers\": [\"16Uiu2HAkuYfgjXoGcSSLSpRPD6XtUgV71t5RqmTmcqdbmrWY9MJo\"], \"ips\": [\"127.0.0.1\"] }"`
- `MAX_REQ_PER_MINUTE`: Number of requests per minute allowed by the same client (IP or Peer id). Example: `30`
- `MAX_CONNECTIONS_PER_MINUTE`: Max number of requests allowed per minute (all clients). Example: `120`
- `MAX_CHECKSUM_LENGTH`: Define the maximum length for a file if checksum is required (Mb). Example: `10`
- `IS_BOOTSTRAP`: Is this node to be used as bootstrap node or not. Default is `false`.
- `AUTHORIZED_PUBLISHERS`: Authorized list of publishers. If present, Node will only index assets published by the accounts in the list. Example: `"[\"0x967da4048cD07aB37855c090aAF366e4ce1b9F48\",\"0x388C818CA8B9251b393131C08a736A67ccB19297\"]"`
- `AUTHORIZED_PUBLISHERS_LIST`: AccessList contract addresses (per chain). If present, Node will only index assets published by the accounts present on the given access lists. Example: `"{ \"8996\": [\"0x967da4048cD07aB37855c090aAF366e4ce1b9F48\",\"0x388C818CA8B9251b393131C08a736A67ccB19297\"] }"`
- `VALIDATE_UNSIGNED_DDO`: If set to `false`, the node will not validate unsigned DDOs and will request a signed message with the publisher address, nonce and signature. Default is `true`. Example: `false`
- `JWT_SECRET`: Secret used to sign JWT tokens. Default is `ocean-node-secret`. Example: `"my-secret-jwt-token"`
- `PERSISTENT_STORAGE`: Persistent storage config. See [persistent storage](persistentStorage.md).

## Database

- `DB_URL`: URL for connecting to the database. Required for running a database with the node. Example: `"http://localhost:8108/?apiKey=xyz"`
- `DB_USERNAME`: Username for database authentication. Optional if not using authentication. Example: `"elastic"`
- `DB_PASSWORD`: Password for database authentication. Optional if not using authentication. Example: `"password123"`
- `ELASTICSEARCH_REQUEST_TIMEOUT`: Request timeout in milliseconds for Elasticsearch operations. Default is `60000`. Example: `60000`
- `ELASTICSEARCH_PING_TIMEOUT`: Ping timeout in milliseconds for Elasticsearch health checks. Default is `5000`. Example: `5000`
- `ELASTICSEARCH_RESURRECT_STRATEGY`: Strategy for bringing failed Elasticsearch nodes back online. Options are 'ping', 'optimistic', or 'none'. Default is `ping`. Example: `"ping"`
- `ELASTICSEARCH_MAX_RETRIES`: Maximum number of retry attempts for failed Elasticsearch operations. Default is `5`. Example: `5`
- `ELASTICSEARCH_SNIFF_ON_START`: Enable cluster node discovery on Elasticsearch client startup. Default is `true`. Example: `true`
- `ELASTICSEARCH_SNIFF_INTERVAL`: Interval in milliseconds for periodic cluster health monitoring and node discovery. Set to 'false' to disable. Default is `30000`. Example: `30000`
- `ELASTICSEARCH_SNIFF_ON_CONNECTION_FAULT`: Enable automatic cluster node discovery when connection faults occur. Default is `true`. Example: `true`
- `ELASTICSEARCH_HEALTH_CHECK_INTERVAL`: Interval in milliseconds for proactive connection health monitoring. Default is `60000`. Example: `60000`
- `DB_INIT_MAX_ATTEMPTS`: Maximum number of database initialization attempts at node startup. Raise it when the database container/pod starts slower than the node. Set to `1` to disable retrying. All three `DB_INIT_*` variables are validated as integers `>= 1`; a non-numeric or out-of-range value fails configuration validation and the node refuses to start. Default is `10`. Example: `10`
- `DB_INIT_RETRY_DELAY`: Initial delay in milliseconds before retrying a failed database initialization. Doubles after each attempt. Default is `2000`. Example: `2000`
- `DB_INIT_MAX_RETRY_DELAY`: Upper bound in milliseconds for the database initialization retry backoff. Default is `30000`. Example: `30000`

## Payments

- `ESCROW_CLAIM_TIMEOUT`: Amount of time reserved to claim a escrow payment, in seconds. Defaults to `3600`. Example: `3600`

## Logs

- `LOG_LEVEL`: Define the default log level. Example: `debug`
- `LOG_CONSOLE`: Write logs to the console. Default is `false`, but becomes `true` if neither `LOG_FILES` or `LOG_DB` are set.
- `LOG_FILES`: Write logs to files. Default is `false`
- `LOG_DB`: Write logs to noSQL database. Default is `false`
- `UNSAFE_URLS`: Array or regular expression URLs to be excluded from access.Example: ["^.*(169.254.169.254).*","^.*(127.0.0.1).*"]

## HTTP

- `HTTP_API_PORT`: Port number for the HTTP API. Example: `8000`
- `HTTP_CERT_PATH`: Absolute path to the TLS certificate file. If provided along with `HTTP_KEY_PATH`, the node will start an HTTPS server. Example: `"/etc/letsencrypt/live/example.com/fullchain.pem"`
- `HTTP_KEY_PATH`: Absolute path to the TLS private key file. If provided along with `HTTP_CERT_PATH`, the node will start an HTTPS server. Example: `"/etc/letsencrypt/live/example.com/privkey.pem"`

## P2P

- `P2P_ENABLE_IPV4`: Enable IPv4 connectivity. Defaults: `True`
- `P2P_ENABLE_IPV6`: Enable IPv6 connectivity. Defaults: `True`
- `P2P_ipV4BindAddress`: Bind address for IPV4. Defaults to `0.0.0.0`. Example: `"0.0.0.0"`
- `P2P_ipV4BindTcpPort`: Port used on IPv4 TCP connections. Defaults to `9000`, which is the port the public bootstrap list advertises — set it to `0` only if you want whatever port is free, and note that a node on a random port is not reachable at the address its peers were given. Example: `9000`
- `P2P_ipV4BindWsPort`: Port used on IPv4 WS connections. Defaults to `9001`. Example: `9001`
- `P2P_ipV4BindWssPort`: Port used on IPv4 secure WebSocket (wss) connections. Defaults to `9005`. Example: `9005`
- `P2P_ipV6BindAddress`: Bind address for IPV6. Defaults to `::` — the wildcard, not `::1`, which is loopback and would make every announced `/dns6/...` address unreachable. Example: `"::"`
- `P2P_ipV6BindTcpPort`: Port used on IPv6 TCP connections. Defaults to `9002`. Example: `9002`
- `P2P_ipV6BindWsPort`: Port used on IPv6 WS connections. Defaults to `9003`. Example: `9003`
- `P2P_ANNOUNCE_ADDRESSES`: List of addresses to announce to the network. Example: `"[\"/ip4/1.2.3.4/tcp/8000\"]"`

  To enable SNI (Server Name Indication) with autoTLS, include `/tls/ws` or `/tls/wss` addresses:
  - `"[\"/ip4/<your-ip-addr>/tcp/9001/tls/ws\"]"` - TLS WebSocket
  - `"[\"/ip4/<your-ip-addr>/tcp/9005/tls/wss\"]"` - TLS WebSocket Secure

- `P2P_ANNOUNCE_PRIVATE`: Announce private IPs. Default: `False`. Setting it to `True` also forces `passthroughMapper` on the DHT, which is what a local or test network needs and what a public node must not have.
- `P2P_dhtMaxInboundStreams`: Maximum number of DHT inbound streams. Defaults to `500`. Example: `500`
- `P2P_dhtMaxOutboundStreams`: Maximum number of DHT outbound streams. Defaults to `500`. Example: `500`
- `P2P_DHT_FILTER`: Filter address in DHT. Accepts either the enum name or the legacy numeric form: `filterNone`/`0` = No filter. `filterPrivate`/`1` = (Default) Filter private addresses. `filterPublic`/`2` = Filter public addresses. An unrecognised value falls back to the default (`filterPrivate`) and logs a warning.
- `P2P_DHT_FORCE_SERVER`: Force this node's DHT to run in server mode, bypassing kad-dht's own promote-on-public-address auto-switch. Only set this if the operator already knows the node is reachable. Default: `False`
- `P2P_mDNSInterval`: Interval (in ms) for discovery using mDNS. Defaults to `20000` (20 seconds). Example: `20000`
- `P2P_connectionsMaxParallelDials`: Maximum number of parallel dials. Defaults to `50`. Example: `50`
- `P2P_connectionsDialTimeout`: Timeout for dial commands. Defaults to `15000` (15 seconds). Example: `15000`
- `P2P_MAXDIALQUEUELENGTH`: Maximum number of dials that may be queued at once before new dial requests are rejected. Defaults to `500` (libp2p's own default).
- `P2P_ENABLE_UPNP`: Enable UPNP gateway discovery. Default: `True`
- `P2P_ENABLE_AUTONAT`: Enable AutoNAT discovery. Default: `True`
- `P2P_ENABLE_CIRCUIT_RELAY_SERVER`: Enable Circuit Relay Server. It will help the network but increase your bandwidth usage. It should be disabled for edge nodes. Default: `False`
- `P2P_ENABLE_CIRCUIT_RELAY_CLIENT`: Enable the Circuit Relay client, i.e. let this node reserve a slot on relay servers so unreachable peers can be dialled through them. Needed by a node behind a NAT it cannot open a port on. Default: `False`
- `P2P_CIRCUIT_RELAYS`: Numbers of relay servers. Default: `0`
- `P2P_BOOTSTRAP_NODES` : List of bootstrap nodes. Defaults to OPF nodes. Example: ["/dns4/node3.oceanprotocol.com/tcp/9000/p2p/"]
- `P2P_BOOTSTRAP_TIMEOUT` : How long to wait before discovering bootstrap nodes. In ms. Default: `10000` ms
- `P2P_BOOTSTRAP_TAGNAME` : Tag a bootstrap peer with this name before "discovering" it. Default: 'bootstrap'
- `P2P_BOOTSTRAP_TAGVALUE` : The bootstrap peer tag will have this value. Default: `50`
- `P2P_BOOTSTRAP_TTL` : Cause the bootstrap peer tag to be removed after this number of ms. **No default — the tag is permanent unless you set this**, which is deliberate: an expired tag makes a bootstrap peer prunable again, and libp2p's reconnect queue only re-dials peers whose tag name starts with `keep-alive`, so a trimmed bootstrap peer would never be reconnected. Set it only if you know you want that.
- `P2P_FILTER_ANNOUNCED_ADDRESSES`: CIDR filters to filter announced addresses. Default: the private, link-local, shared-address-space, documentation, multicast and reserved ranges — `["127.0.0.0/8", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "100.64.0.0/10", "169.254.0.0/16", "192.0.0.0/24", "192.0.2.0/24", "198.51.100.0/24", "203.0.113.0/24", "224.0.0.0/4", "240.0.0.0/4"]`. Setting this **replaces** the list rather than adding to it. Example: ["192.168.0.1/27"]
- `P2P_MIN_CONNECTIONS`: The minimum number of connections below which libp2p will start to dial peers from the peer book. Setting this to 0 disables this behaviour. Default: `1`
- `P2P_MAX_CONNECTIONS`: The maximum number of connections libp2p is willing to have before it starts pruning connections to reduce resource usage. Default: `300`
- `P2P_AUTODIALPEERRETRYTHRESHOLD`: When we've failed to dial a peer, do not autodial them again within this number of ms. Default: `120000` (1000 \* 120)
- `P2P_AUTODIALCONCURRENCY`: When dialling peers from the peer book to keep the number of open connections, add dials for this many peers to the dial queue at once. Default: `5`
- `P2P_MAXPEERADDRSTODIAL`: Maximum number of addresses allowed for a given peer before giving up. Default: `30`
- `P2P_AUTODIALINTERVAL`: Auto dial interval (milliseconds). Amount of time between close and open of new peer connection. Default: `5000`
- `P2P_ENABLE_NETWORK_STATS`: Enables 'getP2pNetworkStats' http endpoint. Since this contains private informations (like your ip addresses), this is disabled by default

### P2P timeout / attempt budgets

The P2P budgets. Every one of them is a **positive integer**, in milliseconds
unless stated otherwise, and every one is optional — leave it unset to get the default.

**How a bad value is treated.** A blank, non-numeric, zero or negative value is **ignored**, and
the default below is used instead; fractional values are floored. Every millisecond budget also
has a **floor of 50 ms**, and a value below it is ignored in exactly the same way: every budgeted
stage costs at least one round trip to the peer, so a smaller budget expires before the operation
it bounds can finish — `P2P_STREAM_IDLE_TIMEOUT_MS=1` used to be accepted and broke every
transfer. The two keys that are counts rather than durations, `P2P_SENDTO_MAX_ATTEMPTS` and
`P2P_COMMAND_MAX_INBOUND_STREAMS`, keep a floor of 1. This is a single shared rule
(`normalizeP2pBudget` in `src/components/P2P/timeouts.ts`), used both by the `P2P_TIMEOUTS`
getters that consume these variables and by `OceanNodeP2PConfigSchema` that validates them, so
the two cannot disagree. Two specific cases are worth knowing because they used to behave
differently :

- `P2P_SENDTO_DIAL_MS=` — an **empty** value, the style the rest of `.env.example` uses — used
  to coerce to `0` and land in the config as a 0 ms, i.e. instantly expired, budget while the
  code still used 15000. It is now dropped in favour of the default. Prefer leaving the variable
  out entirely; the `.env.example` entries for these keys are commented out rather than blank.
- `P2P_SENDTO_DIAL_MS=15s` — a **non-numeric** value — used to be rejected by the schema and
  made the node refuse to boot. A typo in a tuning knob is no longer startup-fatal.

**Set these as environment variables, not in `config.json`.** The consuming code reads
`process.env` directly, so a value placed only in `config.json` reaches the validated config but
not the code that uses it. Every key listed here does have an `ENV_TO_CONFIG_MAPPING` entry, so
setting it through the environment reaches both.

- `P2P_FINDPEER_TIMEOUT_MS`: Budget for a Kademlia `findPeer` walk. A multi-hop walk needs 10–30s, not 3–5s. Defaults to `20000` (20 seconds). Example: `20000`
- `P2P_FINDPROVIDERS_TIMEOUT_MS`: Budget for a `findProviders` query. Without it kad-dht falls through to its own 180 second default. Defaults to `20000` (20 seconds). Example: `20000`
- `P2P_STREAM_IDLE_TIMEOUT_MS`: Per-frame **idle** budget when reading a response stream. Not the same thing as the dial timeout — a large transfer is legitimately slow overall but never idle. Defaults to `60000` (60 seconds). Example: `60000`
- `P2P_STREAM_BODY_TIMEOUT_MS`: Ceiling on the **whole** response body of one command, measured from the moment the caller starts reading it. Distinct from `P2P_STREAM_IDLE_TIMEOUT_MS`, which rearms on every frame and therefore bounds a *stall* rather than a *transfer*: a peer that keeps trickling frames is never cut off by the idle budget, however long it goes on. Defaults to `3600000` (60 minutes), which clears every transfer this protocol legitimately carries — at the 16–64 KiB frame sizes seen on the wire that is roughly 3.5 GiB at 1 MiB/s. Raise it if your peers legitimately stream for longer, e.g. a multi-hour download on a slow link. Example: `3600000`
- `P2P_SENDTO_RESOLVE_MS`: `sendTo` stage 1 — address resolution. Defaults to `20000` (20 seconds). Example: `20000`
- `P2P_SENDTO_DIAL_MS`: `sendTo` stage 2 — dial. Defaults to `15000` (15 seconds). Example: `15000`
- `P2P_SENDTO_STREAM_MS`: `sendTo` stage 3 — stream open, command write and status read. Defaults to `10000` (10 seconds). Example: `10000`
- `P2P_SENDTO_TOTAL_MS`: Overall deadline for one `sendTo` **setup** phase, spanning all attempts. It bounds resolution, dial, stream open, the command write and the status frame; it deliberately does **not** bound the response body, which is bounded per frame by `P2P_STREAM_IDLE_TIMEOUT_MS` and in total by `P2P_STREAM_BODY_TIMEOUT_MS`. Defaults to `45000` (45 seconds), which is exactly one complete slow path (`20000 + 15000 + 10000`). Example: `45000`
- `P2P_SENDTO_MAX_ATTEMPTS`: Number of `sendTo` attempts, each with fresh per-stage signals. Defaults to `2`. Hard-capped at `5` — a larger value is clamped rather than ignored, so it cannot multiply the whole `sendTo` budget. Example: `2`
- `P2P_ADVERTISE_TIMEOUT_MS`: Budget for one `contentRouting.provide()`, i.e. advertising a DDO or a C2D capability string. Defaults to `20000` (20 seconds). Example: `20000`
- `P2P_PEERSTORE_GET_MS`: Budget for a local peerStore lookup. Defaults to `3000` (3 seconds). Example: `3000`
- `P2P_DISCOVERY_DIAL_MS`: Budget for the opportunistic dial of a newly discovered peer. Defaults to `10000` (10 seconds). Example: `10000`
- `P2P_COMMAND_MAX_INBOUND_STREAMS`: `maxInboundStreams` for the Ocean command protocol handler. Not a timeout; a plain positive integer. Defaults to `32` (libp2p's own default, stated explicitly so it is tunable). Example: `32`
- `P2P_FINDDDO_TIMEOUT_MS`: Overall FindDDO deadline across all providers. Defaults to `60000` (60 seconds). Example: `60000`
- `P2P_FINDDDO_PROVIDER_TIMEOUT_MS`: Budget for asking **one** provider for a DDO inside FindDDO. Providers are queried concurrently and the first legitimate answer ends the search, so this bounds a single branch rather than dividing `P2P_FINDDDO_TIMEOUT_MS` between them; a provider that exceeds it is abandoned while the others keep answering. It replaces the fixed inter-provider back-off that existed while providers were queried one at a time — nothing sleeps between providers now, so there is no interval left to configure. Defaults to `10000` (10 seconds). Example: `10000`
- `P2P_DDO_NOT_FOUND_CACHE_MS`: How long FindDDO remembers that a DDO id was found nowhere — not locally and not at any provider the DHT returned. The ids callers ask for are frequently ids that do not exist (a stale link, a client polling for something never published, a retry loop around a 404), and each such request otherwise costs a full provider walk plus a query to every provider it turns up. The entry is consulted **after** the local database lookup, never before, so a DDO this node holds is always returned regardless; all it can skip is the network half of the search. Kept short so a genuinely new DDO does not look missing after its publisher advertises it. Defaults to `30000` (30 seconds). Example: `30000`
- `P2P_RESOLVE_CACHE_MS`: Lifetime of the app-level "these are the peer's addresses" cache that sits in front of the connection, peer-store and DHT tiers. Distinct from `P2P_PEERSTORE_MAX_ADDRESS_AGE_MS`: that is how long an address stays valid, this is how long a burst of identical lookups is collapsed into one — a provider fan-out asks for the same peers repeatedly, and so does the indexer's decrypt loop. Correctness does not rest on the value, because an entry is dropped whenever a dial against it fails. Defaults to `45000` (45 seconds). Example: `45000`
- `P2P_RESOLVE_NEGATIVE_CACHE_MS`: Lifetime of the negative half of that cache — "this peer resolved to nothing". Deliberately a quarter of the positive lifetime: a resolved address is a durable fact backed by the peer store, while a failed resolution describes one instant, and the peer it describes comes back on its own schedule. Short enough that a negatively-cached peer becomes reachable again without a node restart, which is the property that makes a negative cache acceptable at all. A failed dial clears the negative entry too. Defaults to `15000` (15 seconds). Example: `15000`
- `P2P_SENDTO_MAX_CONCURRENCY`: Ceiling on concurrent outbound `sendTo` calls. Not a timeout; a plain positive integer. A send occupies a slot in libp2p's dial queue for its whole setup phase, and two paths fan out without a bound of their own — FindDDO's provider queries and the indexer's decrypt loop — so without this they can put more dials in flight than the dial queue runs, at which point unrelated traffic (bootstrap reconnects, discovery dials, DHT walks) queues behind them. A send that waits here has not yet started its deadline, so a deep queue costs latency and never turns into a timeout. Defaults to `25` — half of `P2P_connectionsMaxParallelDials`, and five whole FindDDO fan-outs at the provider maximum. Hard-capped at `200`; a larger value is clamped rather than ignored, so the guard stays in place. Example: `25`
- `P2P_READY_MIN_ROUTING_PEERS`: How many peers the DHT routing table must hold before the node reports its P2P interface as ready in the `p2pStatus` block of the status endpoint. Not a timeout; a plain positive integer. Gated on the routing table rather than on the connection count because queries are refused outright against an empty table (`allowQueryWithZeroPeers` is `false`), and a connection to a peer that does not speak the DHT protocol is not a peer a query can start from. Defaults to `4`, the number of disjoint lookup paths one query is configured to run — the smallest table at which a query can use the fan-out it is set up for. Example: `4`
- `P2P_INITIAL_QUERY_SELF_MS`: Delay before kad-dht runs its **first** self-query, the query whose results populate the routing table. Raising this is the fix rather than lowering it, which is worth spelling out: the self-query runs once at this interval and is then not run again for five minutes, and at kad-dht's own default of `1000` a fresh node has no DHT peers yet — bootstrap peers are only discovered after `P2P_BOOTSTRAP_TIMEOUT` (10 seconds) and each still has to be dialled — so the first query failed against an empty routing table and the table stayed empty for the next five minutes but for whatever arrived passively. Defaults to `20000` (20 seconds), which is `P2P_BOOTSTRAP_TIMEOUT` plus `P2P_DISCOVERY_DIAL_MS`, i.e. the point by which a bootstrap connection exists in the worst case; raise it in step if you raise either of those. Example: `20000`
- `P2P_PEERSTORE_MAX_ADDRESS_AGE_MS`: How long the peer store keeps a peer's multiaddrs before treating them as expired and dropping them from every read. libp2p's own default is `3600000` (1 hour), while a DHT provider record stays valid for **48 hours** — so with the library default the DHT kept returning providers whose addresses had already been discarded, and the lookup resolved to nothing. The expiry is not refreshed by re-learning the same address either: storing an address that is already present carries the previous observation timestamp forward, so a peer heard about continuously still expired an hour after it was first seen. This defaults to the provider-record lifetime instead, so a provider record and the addresses it points at expire together. The cost is a stale address for a peer that changed IP, which `sendTo` already absorbs by re-resolving DHT-only after a failed dial. Defaults to `172800000` (48 hours). Example: `172800000`
- `P2P_PEERSTORE_MAX_PEER_AGE_MS`: How long a peer *record* carrying no addresses survives before the peer store evicts it (libp2p's own default is `21600000`, 6 hours). It is held to **at least** `P2P_PEERSTORE_MAX_ADDRESS_AGE_MS`: a lower value would evict the record while the addresses it carries were still inside their own lifetime, which would silently undo the address setting. Set it below the address age and the address age is used. Defaults to `172800000` (48 hours). Example: `172800000`

## Policy Server

- `POLICY_SERVER_URL`: URI definition of PolicyServer, if any. See [the policy server documentation for more details](docs/PolicyServer.md).
- `POLICY_SERVER_API_KEY`: Optional API key sent by Ocean Node as `X-API-Key` when calling Policy Server.

## Additional Nodes (Test Environments)

- `NODE1_PRIVATE_KEY`: Used on test environments, specifically CI, represents the private key for node 1. Example: `"0xfd5c1ccea015b6d663618850824154a3b3fb2882c46cefb05b9a93fea8c3d215"`
- `NODE2_PRIVATE_KEY`: Used on test environments, specifically CI, represents the private key for node 2. Example: `"0x1263dc73bef43a9da06149c7e598f52025bf4027f1d6c13896b71e81bb9233fb"`

## Cron Jobs

- `CRON_DELETE_DB_LOGS`: Delete old logs from database Cron expression. Example: `0 0 * * *` (runs every day at midnight)
- `CRON_CLEANUP_C2D_STORAGE`: Clear c2d expired resources/storage and delete old jobs. Example: `*/5 * * * *` (runs every 5 minutes)

## Node Metrics History

Powers the `getNodeMetrics` (live snapshot) and `getNodeMetricsHistory` (hourly averages) commands / REST routes. The history layer is SQLite-backed (`databases/nodeMetrics.sqlite`) so it works even with no metadata DB configured. A minute sampler writes the same per-node aggregate the live command returns into a short-lived raw buffer, an hourly roll-up at minute `:05` averages each complete hour into `node_metrics_hourly`, and a daily sweep drops rows older than the retention window. The sampler **warns and skips** (persists no row) when there is no fresh compute aggregate — i.e. `C2D_METRICS_INTERVAL_SECONDS=0` or no engine has sampled yet — so all-zero rows never skew the averages. The live `getNodeMetrics` command still returns a (zeroed) snapshot in that case.

- `NODE_METRICS_HISTORY_ENABLED`: Enable/disable the node-metrics history sampler + roll-up + retention cron jobs. Defaults to enabled whenever a database is available. Set to `false` (also accepts `0`/`no`) to turn the history layer off; the live `getNodeMetrics` command is unaffected. Example: `true`
- `NODE_METRICS_SAMPLE_CRON`: Cron expression for the minute sampler. Defaults to `* * * * *` (every minute). Example: `* * * * *`
- `NODE_METRICS_RETENTION_DAYS`: How many days of hourly rows to keep before the daily retention sweep deletes them. Also clamps the range `getNodeMetricsHistory` will return. Defaults to `180` (~6 months). Example: `180`

## Compute

- `C2D_DOWNLOAD_TIMEOUT`: Timeout (in seconds) for pulling the algorithm docker image during a C2D job. If the pull exceeds this timeout, the job fails with `PullImageFailed` instead of getting stuck. Defaults to `900` (15 minutes). Example: `900`

- `C2D_METRICS_INTERVAL_SECONDS`: How often (in seconds) the node samples live Docker runtime metrics (CPU, RAM, disk, network, block I/O, PIDs, exit info — plus NVIDIA GPU utilization/memory) for running compute jobs and services, persisting a snapshot onto the job record in the C2D database. These metrics are **owner-only**: they are never included in the escrow claim proof and never returned to anyone but the authenticated owner of the job/service. To that owner they come back **by default** on `COMPUTE_GET_STATUS` / `SERVICE_GET_STATUS` (no flag needed — see [API.md](API.md) for the `includeMetrics` override); an unauthenticated status call and the node-wide `serviceList` never return them. Set to `0` to disable collection entirely. Metrics are best-effort (up to one interval of staleness). Defaults to `10`. Example: `10`

- `GPU_METRICS`: Controls the GPU metrics collector. `auto` (default) detects and enables the NVIDIA (NVML) backend when a GPU host is available; `off` disables GPU collection. Requires the optional `koffi` dependency and `libnvidia-ml.so.1` reachable **by the node process** — note that a containerized node does not get the NVIDIA driver libraries just because the host has them, so this is the usual reason GPU metrics are missing (`could not bind libnvidia-ml.so.1`); [compute.md → Troubleshooting GPU metrics](compute.md#troubleshooting-gpu-metrics) lists every warning and its fix. If either is missing, GPU metrics are skipped (no `gpu` field) while container-level metrics continue. AMD and Intel backends are not yet implemented. Cadence reuses `C2D_METRICS_INTERVAL_SECONDS`. Defaults to `auto`. Example: `auto`

- `SERVICE_TEMPLATES_PATH`: Path to a folder of operator-published Service-on-Demand template files (`*.json`, validated against the template schema). The folder is re-read on every `serviceTemplates` request, so templates can be added, edited, or removed without restarting the node. Maps to the `serviceTemplatesPath` config field. Defaults to `databases/serviceTemplates/`, which the image does not create — the operator mounts templates into it (a missing folder simply means no templates). See the [Services guide](services.md). Example: `/templates`

The `DOCKER_COMPUTE_ENVIRONMENTS` environment variable is used to configure Docker-based compute environments in Ocean Node. For the full guide — resources, GPU setup, constraints and pricing — see [Compute Configuration](compute.md).

`cpu`, `ram`, and `disk` resources are **auto-detected** from the host at startup. All resource values are expressed in natural units: CPU in cores, RAM and disk in GB.

The config has a two-level structure:
- **Connection level** (`C2DDockerConfig`): Docker connection details + optional hardware resource pool (GPUs, NICs, or overrides for auto-detected cpu/ram/disk)
- **Environment level** (`C2DEnvironmentConfig`): per-environment business rules (fees, access, durations) + lightweight resource refs

```json
[
  {
    "socketPath": "/var/run/docker.sock",
    "scanImages": false,
    "imageRetentionDays": 7,
    "imageCleanupInterval": 86400,
    "paymentClaimInterval": 3600,

    "resources": [
      { "id": "cpu", "total": 6 },
      { "id": "disk", "total": 50 }
    ],

    "environments": [
      {
        "id": "default",
        "description": "CPU compute environment",
        "storageExpiry": 604800,
        "maxJobDuration": 3600,
        "minJobDuration": 60,
        "enableNetwork": false,
        "access": {
          "addresses": ["0x123", "0x456"],
          "accessLists": []
        },
        "fees": {
          "1": [
            {
              "feeToken": "0x967da4048cD07aB37855c090aAF366e4ce1b9F48",
              "prices": [{ "id": "cpu", "price": 1 }]
            }
          ]
        },
        "resources": [
          { "id": "cpu", "min": 1, "max": 4 },
          { "id": "ram", "min": 1, "max": 8 },
          { "id": "disk", "min": 1, "max": 50 }
        ],
        "free": {
          "maxJobDuration": 60,
          "minJobDuration": 10,
          "maxJobs": 3,
          "access": { "addresses": [], "accessLists": [] },
          "resources": [
            { "id": "cpu", "max": 1 },
            { "id": "ram", "max": 1 },
            { "id": "disk", "max": 1 }
          ]
        }
      }
    ]
  }
]
```

#### Connection-level fields

- **socketPath** / **host** / **port** / **protocol** / **caPath** / **certPath** / **keyPath**: Docker connection settings.
- **scanImages**: Scan algorithm images for vulnerabilities with Trivy. Default: `false`
- **scanImageDBUpdateInterval**: Vulnerability DB update interval in seconds. Default: `43200` (12 hours)
- **imageRetentionDays**: How long to keep Docker images, in days. Default: `7`
- **imageCleanupInterval**: Image cleanup interval in seconds. Min: `3600`, Default: `86400`
- **paymentClaimInterval**: Payment claim interval in seconds. Min: `60`, Default: `3600`
- **resources** *(optional)*: Hardware resource pool for this connection. `cpu`, `ram`, and `disk` are auto-detected from the host — include them only to cap their totals or to add custom resources (GPUs, NICs, etc.).
  - **id**: Resource identifier. `cpu`, `ram`, `disk` are built-in; any other string defines a custom resource.
  - **kind**: `"discrete"` (non-fungible device, e.g. GPU) or `"fungible"` (interchangeable units, e.g. CPU). Auto-inferred: `"discrete"` if `init` is present, `"fungible"` otherwise.
  - **shareable** *(discrete only)*: `true` allows multiple jobs to use the device simultaneously (NIC, TPM). Default: `false`. **Not allowed** on `type: "gpu"` or `type: "fpga"`.
  - **total**: Total units available. Capped at the physical host limit.
  - **cpuList** *(cpu resource only)*: Restricts which host core IDs compute containers may be pinned to. Comma-separated core IDs and/or integer ranges, e.g. `"3"`, `"0-1,3"` or `"32-63"`. Ranges `a-b` must have `b` strictly greater than `a`, all parts must be ascending and non-overlapping, core IDs may not exceed `8192`, and every core ID must exist on the host — otherwise the node fails to start with an error. Mutually exclusive with **total**: the cpu resource must specify exactly one of the two, and with `cpuList` the effective total is the number of listed cores.
  - **min** / **max**: Per-job minimum/maximum.
  - **description**, **platform**, **driverVersion**, **memoryTotal**: Informational metadata.
  - **init**: Docker device configuration (`deviceRequests` for NVIDIA, `advanced` for AMD/Intel). See [Compute Configuration](compute.md#configuring-gpus).
  - **constraints**: Cross-resource requirements. `{ "id": "ram", "min": 4 }` means renting this resource also requires 4 GB RAM.

#### Environment-level fields

- **id** *(optional)*: Stable identifier for the environment. Used to compute the environment hash.
- **description**: Human-readable description.
- **storageExpiry**: Seconds before compute results expire.
- **maxJobDuration** / **minJobDuration**: Maximum/minimum **compute job** duration in seconds. These do not apply to services.
- **maxServiceDuration** *(optional)*: Maximum **service** duration in seconds, for service-on-demand. Omit to inherit the daemon's `serviceOnDemand.maxDurationSeconds` (default 86400). That daemon value is a hard ceiling — an environment can only lower it, and a larger value is clamped at startup with a warning. Advertised to clients on every environment as `maxServiceDuration`.
- **maxJobs**: Maximum simultaneous paid jobs.
- **enableNetwork**: Whether algorithm containers can make outbound network connections. Default: `false`
- **access**: Access control for paid jobs.
  - **addresses**: Ethereum addresses allowed to submit jobs. Empty + no accessLists = open access.
  - **accessLists**: AccessList NFT contract addresses. NFT holders can submit jobs.
- **fees**: Fee structure per chain.
  - **feeToken**: ERC-20 token address for payment.
  - **prices**: `[{ "id": "<resource-id>", "price": <per-unit-per-minute> }]`
- **resources**: Lightweight refs to the connection pool. `cpu`, `ram`, `disk` are always available.
  - **id**: Must match a connection-level resource id, or `cpu` / `ram` / `disk`.
  - **total**: Env aggregate ceiling — max units all running jobs in this env can use simultaneously. Omit for no per-env cap.
  - **min** / **max**: Per-job limits for this environment (further restricted from pool values).
  - **constraints**: Per-env override for pool-level constraints. Replaces (not merges) the pool constraints. Set `[]` to remove constraints for this env.
- **free** *(optional)*: Free tier configuration.
  - **maxJobDuration** / **minJobDuration** / **maxJobs**: Free job limits.
  - **allowImageBuild**: Allow image builds on free jobs. Default: `false`
  - **access**: Same structure as the paid access field.
  - **resources**: Same structure as environment resources — lightweight refs limiting what free jobs can request.

> **Strict isolation**: If you need strict physical CPU isolation between environments (e.g., for regulated data), run each environment on a separate Docker connection. All environments on the same connection share the same CPU core pool dynamically.

#### Migration from old format

The old format placed hardware details (`init`, `driverVersion`, etc.) inside environments. This is now **a startup error**.

**Old (rejected):**
```json
[{ "socketPath": "...", "environments": [{ "resources": [{ "id": "myGPU", "init": {...} }] }] }]
```

**New:**
```json
[{
  "socketPath": "...",
  "resources": [{ "id": "myGPU", "kind": "discrete", "total": 1, "init": {...} }],
  "environments": [{ "resources": [{ "id": "myGPU" }] }]
}]
```

Move all `init`, `driverVersion`, `platform`, `memoryTotal`, `type`, `kind`, and `constraints` fields to the connection-level `resources` array. Environment resources keep only `id` and optionally `total`/`min`/`max`/`constraints`.

### Docker Registry Authentication

- `DOCKER_REGISTRY_AUTHS`: JSON object mapping Docker registry URLs to authentication credentials. Used for accessing private Docker/OCI registries when validating and pulling Docker images. Each registry entry must provide either `username`+`password` or `auth`. Example:

```json
{
  "https://registry-1.docker.io": {
    "username": "myuser",
    "password": "mypassword"
  },
  "https://ghcr.io": {
    "username": "myuser",
    "password": "ghp_..."
  },
  "https://registry.gitlab.com": {
    "auth": "glpat-..."
  }
}
```

**Configuration Options:**

- **Registry URL** (key): The full registry URL including protocol (e.g., `https://registry-1.docker.io`, `https://ghcr.io`, `https://registry.gitlab.com`)
- **username** (optional): Username for registry authentication. Required if using password-based auth.
- **password** (optional): Password or personal access token for registry authentication. Required if using username-based auth.
- **auth** (optional): Authentication token (alternative to username+password). Required if not using username+password.

**Notes:**

- For Docker Hub (`registry-1.docker.io`), you can use your Docker Hub username and password, or a personal access token (PAT) as the password.
- For GitHub Container Registry (GHCR), use your GitHub username with a personal access token (PAT) as the password, or use a token directly.
- For GitLab Container Registry, use a personal access token (PAT) or deploy token.
- The registry URL must match exactly (including protocol) with the registry used in the Docker image reference.
- If no credentials are configured for a registry, the node will attempt unauthenticated access (works for public images only).

---

## Private Docker Registries with Per-Job Authentication

In addition to node-level registry authentication via `DOCKER_REGISTRY_AUTHS`, you can provide encrypted Docker registry authentication credentials on a per-job basis. This allows different users to use different private registries or credentials for their compute jobs.

### Overview

The `encryptedDockerRegistryAuth` parameter allows you to securely provide Docker registry credentials that are:

- Encrypted using ECIES (Elliptic Curve Integrated Encryption Scheme) with the node's public key
- Validated to ensure proper format (either `auth` string OR `username`+`password`)
- Used only for the specific compute job, overriding node-level configuration if provided

### Encryption Format

The `encryptedDockerRegistryAuth` must be:

1. A JSON object matching the Docker registry auth schema (see below)
2. Encrypted using ECIES with the node's public key
3. Hex-encoded as a string

**Auth Schema Format:**

The decrypted JSON must follow this structure:

```json
{
  "username": "myuser",
  "password": "mypassword"
}
```

OR

```json
{
  "auth": "base64-encoded-username:password"
}
```

OR (all fields present)

```json
{
  "username": "myuser",
  "password": "mypassword",
  "auth": "base64-encoded-username:password"
}
```

**Validation Rules:**

- Either `auth` string must be provided (non-empty), OR
- Both `username` AND `password` must be provided (both non-empty)
- Empty strings are not accepted

### Usage Examples

#### 1. Paid Compute Start (`POST /api/services/compute`)

```json
{
  "command": "startCompute",
  "consumerAddress": "0x...",
  "signature": "...",
  "nonce": "123",
  "environment": "0x...",
  "algorithm": {
    "meta": {
      "container": {
        "image": "registry.example.com/myorg/myimage:latest"
      }
    }
  },
  "datasets": [],
  "payment": { ... },
  "encryptedDockerRegistryAuth": "0xdeadbeef..." // ECIES encrypted hex string
}
```

#### 2. Free Compute Start (`POST /api/services/freeCompute`)

```json
{
  "command": "freeStartCompute",
  "consumerAddress": "0x...",
  "signature": "...",
  "nonce": "123",
  "environment": "0x...",
  "algorithm": {
    "meta": {
      "container": {
        "image": "ghcr.io/myorg/myimage:latest"
      }
    }
  },
  "datasets": [],
  "encryptedDockerRegistryAuth": "0xdeadbeef..." // ECIES encrypted hex string
}
```

#### 3. Initialize Compute

The `initialize` command accepts `encryptedDockerRegistryAuth` as part of the command payload, as it validates the image

```json
{
  "command": "initialize",
  "datasets": [...],
  "algorithm": {
    "meta": {
      "container": {
        "image": "registry.gitlab.com/myorg/myimage:latest"
      }
    }
  },
  "environment": "0x...",
  "payment": { ... },
  "consumerAddress": "0x...",
  "maxJobDuration": 3600,
  "encryptedDockerRegistryAuth": "0xdeadbeef..." // ECIES encrypted hex string
}
```

### Encryption Process

To create `encryptedDockerRegistryAuth`, you need to:

1. **Prepare the auth JSON object:**

   ```json
   {
     "username": "myuser",
     "password": "mypassword"
   }
   ```

2. **Get the node's public key** (available via the node's API or P2P interface)

3. **Encrypt the JSON string** using ECIES with the node's public key

4. **Hex-encode the encrypted result**

### Behavior

- **Priority**: If `encryptedDockerRegistryAuth` is provided, it takes precedence over node-level `DOCKER_REGISTRY_AUTHS` configuration for that specific job
- **Validation**: The encrypted auth is decrypted and validated before the job starts. Invalid formats will result in an error
- **Scope**: The credentials are used for:
  - Validating the Docker image exists (during initialize)
  - Pulling the Docker image (during job execution)
- **Security**: Credentials are encrypted and only decrypted by the node using its private key

### Error Handling

If `encryptedDockerRegistryAuth` is invalid, you'll receive an error:

- **Decryption failure**: `Invalid encryptedDockerRegistryAuth: failed to parse JSON - [error message]`
- **Schema validation failure**: `Invalid encryptedDockerRegistryAuth: Either 'auth' must be provided, or both 'username' and 'password' must be provided`

### Notes

- The `encryptedDockerRegistryAuth` parameter is optional. If not provided, the node will use `DOCKER_REGISTRY_AUTHS` configuration or attempt unauthenticated access
- The registry URL in the Docker image reference must match the registry you're authenticating to
- For Docker Hub, use `registry-1.docker.io` as the registry URL
- Credentials are stored encrypted in the job record and decrypted only when needed for image operations
