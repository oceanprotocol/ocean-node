# Environmental Variables

Environmental variables are also tracked in `ENVIRONMENT_VARIABLES` within `src/utils/constants.ts`. Descriptions and example values are provided below:

## Core

- `PRIVATE_KEY` (Required): The private key for the node, required for node operations. Example: `"0x1d751ded5a32226054cd2e71261039b65afb9ee1c746d055dd699b1150a5befc"`
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
- `DASHBOARD`: If `false` the dashboard will not run. If not set or `true` the dashboard will start with the node. Example: `false`
- `RATE_DENY_LIST`: Blocked list of IPs and peer IDs. Example: `"{ \"peers\": [\"16Uiu2HAkuYfgjXoGcSSLSpRPD6XtUgV71t5RqmTmcqdbmrWY9MJo\"], \"ips\": [\"127.0.0.1\"] }"`
- `MAX_REQ_PER_MINUTE`: Number of requests per minute allowed by the same client (IP or Peer id). Example: `30`
- `MAX_CONNECTIONS_PER_MINUTE`: Max number of requests allowed per minute (all clients). Example: `120`
- `MAX_CHECKSUM_LENGTH`: Define the maximum length for a file if checksum is required (Mb). Example: `10`
- `IS_BOOTSTRAP`: Is this node to be used as bootstrap node or not. Default is `false`.
- `AUTHORIZED_PUBLISHERS`: Authorized list of publishers. If present, Node will only index assets published by the accounts in the list. Example: `"[\"0x967da4048cD07aB37855c090aAF366e4ce1b9F48\",\"0x388C818CA8B9251b393131C08a736A67ccB19297\"]"`
- `AUTHORIZED_PUBLISHERS_LIST`: AccessList contract addresses (per chain). If present, Node will only index assets published by the accounts present on the given access lists. Example: `"{ \"8996\": [\"0x967da4048cD07aB37855c090aAF366e4ce1b9F48\",\"0x388C818CA8B9251b393131C08a736A67ccB19297\"] }"`

## Logs

- `LOG_LEVEL`: Define the default log level. Example: `debug`
- `LOG_CONSOLE`: Write logs to the console. Default is `false`, but becomes `true` if neither `LOG_FILES` or `LOG_DB` are set.
- `LOG_FILES`: Write logs to files. Default is `false`
- `LOG_DB`: Write logs to noSQL database. Default is `false`
- `UNSAFE_URLS`: Array or regular expression URLs to be excluded from access.Example: ["^.*(169.254.169.254).*","^.*(127.0.0.1).*"]

## HTTP

- `HTTP_API_PORT`: Port number for the HTTP API. Example: `8000`

## P2P

- `P2P_ENABLE_IPV4`: Enable IPv4 connectivity. Defaults: `True`
- `P2P_ENABLE_IPV6`: Enable IPv6 connectivity. Defaults: `True`
- `P2P_ipV4BindAddress`: Bind address for IPV4. Defaults to `0.0.0.0`. Example: `"0.0.0.0"`
- `P2P_ipV4BindTcpPort`: Port used on IPv4 TCP connections. Defaults to `0` (Use whatever port is free. When running as docker, please set it explicitly). Example: `0`
- `P2P_ipV4BindWsPort`: Port used on IPv4 WS connections. Defaults to `0` (Use whatever port is free. When running as docker, please set it explicitly). Example: `0`
- `P2P_ipV6BindAddress`: Bind address for IPV6. Defaults to `::1`. Example: `"::1"`
- `P2P_ipV6BindTcpPort`: Port used on IPv6 TCP connections. Defaults to `0` (Use whatever port is free. When running as docker, please set it explicitly). Example: `0`
- `P2P_ipV6BindWsPort`: Port used on IPv6 WS connections. Defaults to `0` (Use whatever port is free. When running as docker, please set it explicitly). Example: `0`
- `P2P_ANNOUNCE_ADDRESSES`: List of addresses to announce to the network. Example: `"[\"/ip4/1.2.3.4/tcp/8000\"]"`
- `P2P_ANNOUNCE_PRIVATE`: Announce private IPs. Default: `True`
- `P2P_pubsubPeerDiscoveryInterval`: Interval (in ms) for discovery using pubsub. Defaults to `10000` (three seconds). Example: `10000`
- `P2P_dhtMaxInboundStreams`: Maximum number of DHT inbound streams. Defaults to `500`. Example: `500`
- `P2P_dhtMaxOutboundStreams`: Maximum number of DHT outbound streams. Defaults to `500`. Example: `500`
- `P2P_DHT_FILTER`: Filter address in DHT. 0 = (Default) No filter 1. Filter private ddresses. 2. Filter public addresses
- `P2P_mDNSInterval`: Interval (in ms) for discovery using mDNS. Defaults to `20000` (20 seconds). Example: `20000`
- `P2P_connectionsMaxParallelDials`: Maximum number of parallel dials. Defaults to `150`. Example: `150`
- `P2P_connectionsDialTimeout`: Timeout for dial commands. Defaults to `10000` (10 seconds). Example: `10000`
- `P2P_ENABLE_UPNP`: Enable UPNP gateway discovery. Default: `True`
- `P2P_ENABLE_AUTONAT`: Enable AutoNAT discovery. Default: `True`
- `P2P_ENABLE_CIRCUIT_RELAY_SERVER`: Enable Circuit Relay Server. It will help the network but increase your bandwidth usage. Should be disabled for edge nodes. Default: `True`
- `P2P_CIRCUIT_RELAYS`: Numbers of relay servers. Default: `0`
- `P2P_BOOTSTRAP_NODES` : List of bootstrap nodes. Defults to OPF nodes. Example: ["/dns4/node3.oceanprotocol.com/tcp/9000/p2p/"]
- `P2P_BOOTSTRAP_TIMEOUT` : How long to wait before discovering bootstrap nodes. In ms. Default: 2000 ms
- `P2P_BOOTSTRAP_TAGNAME` : Tag a bootstrap peer with this name before "discovering" it. Default: 'bootstrap'
- `P2P_BOOTSTRAP_TAGVALUE` : The bootstrap peer tag will have this value (default: 50)
- `P2P_BOOTSTRAP_TTL` : Cause the bootstrap peer tag to be removed after this number of ms. Default: 120000 ms
- `P2P_FILTER_ANNOUNCED_ADDRESSES`: CIDR filters to filter announced addresses. Default: ["172.15.0.0/24"] (docker ip range). Example: ["192.168.0.1/27"]
- `P2P_MIN_CONNECTIONS`: The minimum number of connections below which libp2p will start to dial peers from the peer book. Setting this to 0 disables this behaviour. Default: 1
- `P2P_MAX_CONNECTIONS`: The maximum number of connections libp2p is willing to have before it starts pruning connections to reduce resource usage. Default: 300
- `P2P_AUTODIALPEERRETRYTHRESHOLD`: When we've failed to dial a peer, do not autodial them again within this number of ms. Default: 1000 \* 120
- `P2P_AUTODIALCONCURRENCY`: When dialling peers from the peer book to keep the number of open connections, add dials for this many peers to the dial queue at once. Default: 5
- `P2P_MAXPEERADDRSTODIAL`: Maximum number of addresses allowed for a given peer before giving up. Default: 5
- `P2P_AUTODIALINTERVAL`: Auto dial interval (miliseconds). Amount of time between close and open of new peer connection. Default: 5000
- `P2P_ENABLE_NETWORK_STATS`: Enables 'getP2pNetworkStats' http endpoint. Since this contains private informations (like your ip addresses), this is disabled by default

## Policy Server

- `POLICY_SERVER_URL`: URI definition of PolicyServer, if any. See [the policy server documentation for more details](docs/PolicyServer.md).

## Additional Nodes (Test Environments)

- `NODE1_PRIVATE_KEY`: Used on test environments, specifically CI, represents the private key for node 1. Example: `"0xfd5c1ccea015b6d663618850824154a3b3fb2882c46cefb05b9a93fea8c3d215"`
- `NODE2_PRIVATE_KEY`: Used on test environments, specifically CI, represents the private key for node 2. Example: `"0x1263dc73bef43a9da06149c7e598f52025bf4027f1d6c13896b71e81bb9233fb"`
