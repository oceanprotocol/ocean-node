# ocean-node

WIP, may not compile.

## Running Locally

### 1. Make sure to use nvm (or make sure you're using the same node version specified on .nvmrc)

```bash
nvm use
```

### 2. Install deps

```bash
npm i
```

### 3. Build

```bash
npm run build
```

### 4. Download barge and run services

In a separate terminal, clone barge repo, checkout `feature/nodes` branch and start it.

```bash
git clone https://github.com/oceanprotocol/barge.git
cd barge
git checkout feature/nodes
./start_ocean.sh
```

### 5. Open terminal 1 and set the environmental variables

A full list of all environmental variables is available in [env.md](./env.md)

The only required/mandatory setting to run a node (very basic configuration) is the PRIVATE_KEY. The node does not start without it.
All the others are either optional or they have defaults. However, it is recommended that you set some of them, otherwise your node will not be able to perform most of the available features.

There are 2 options for setting the initial configuration

## Option 1 -> Run the helper script "helpers/scripts/setupNodeEnv.sh"

This script will help you to generate a private key (if you don't have one already) and some basic configuration under a (also generated) `.env` file. Once you have answered the basic questions, you will have a `.env` under your root folder, with some basic settings.
You can further edit the file to add additional/more advanced settings. Once you're ready to start your node, do the following before:

```bash
source .env
```

This will export all the configurations present in the `.env` file to your local environment. From now on, you can use this file as a reference.

## Option 2 -> Export the necessary variables manually from the terminal

Set env values:

```bash
export HTTP_API_PORT=8000
export PRIVATE_KEY="0x1d751ded5a32226054cd2e71261039b65afb9ee1c746d055dd699b1150a5befc"
export RPCS="{ \"1\":{ \"rpc\":\"https://rpc.eth.gateway.fm\", \"chainId\": 1, \"network\": \"mainet\", \"chunkSize\": 100 }, \"137\": { \"rpc\": \"https://polygon.meowrpc.com\", \"chainId\": 137, \"network\": \"polygon\", \"chunkSize\": 100 }, \"80001\": { \"rpc\": \"https://rpc-mumbai.maticvigil.com\", \"chainId\": 80001, \"network\": \"polygon-mumbai\", \"chunkSize\": 100 }}"
```

Network interfaces supported by the node ('http' and/or 'p2p'). By default, if not specified otherwise, both are supported. Case insensitive.

```bash
export INTERFACES=[\"HTTP\",\"P2P\"]
```

You need to define a database URL if you want to run a database as part of your node. This is required for the tests to pass.

```bash
export DB_URL="http://localhost:8108/?apiKey=xyz"
```

For downloading the file from IPFS or ARWEAVE, please export the following env variables;

```bash
export IPFS_GATEWAY='https://ipfs.io/'
export ARWEAVE_GATEWAY='https://arweave.net/'
```

For configuring allowed validators for verifying an asset signature before indexing, please set the following environment variable (array of 1 or multiple addresses):

```bash
export ALLOWED_VALIDATORS=[\"0x123\",\"0x456\"]
```

For configuring a C2D (Compute to Data) cluster(s), please set the following environment variable (array of 1 or multiple cluster URLS) and node URI that C2D points to, in order fetch the datasets & algorithms:

```bash
export OPERATOR_SERVICE_URL=[\"http://example.c2d.cluster1.com\",\"http://example.cd2.cluster2.com\"]
export C2D_NODE_URI='http://127.0.0.1:8081' #for e.g.
```

For configuring the Indexer crawling interval in miliseconds (default, if not set, is 30 secs)

```bash
export INDEXER_INTERVAL=10000
```

To configure which networks the Indexer will be crawling (optional; if not set, the Indexer will index all networks defined in the RPCS environment variable):

```bash
export INDEXER_NETWORKS="[1, 137]"
```

For purgatory checks, please export the following env variables;

```bash
export ASSET_PURGATORY_URL=\"https://raw.githubusercontent.com/oceanprotocol/list-purgatory/main/list-assets.json\"
export ACCOUNT_PURGATORY_URL=\"https://raw.githubusercontent.com/oceanprotocol/list-purgatory/main/list-accounts.json\"
```

For configuring the ocean node fees, please export the following environment variables;

```bash
export FEE_TOKENS="{ \"1\": \"0x967da4048cD07aB37855c090aAF366e4ce1b9F48\", \"137\": \"0x282d8efCe846A88B159800bd4130ad77443Fa1A1\", \"80001\": \"0xd8992Ed72C445c35Cb4A2be468568Ed1079357c8\", \"56\": \"0xDCe07662CA8EbC241316a15B611c89711414Dd1a\" }"
export FEE_AMOUNT="{ \"amount\": 1, \"unit\": \"MB\" }"
```

Where FEE_TOKENS is a map (chainID => Token address) and FEE_AMOUNT is the fees amount (unit of fee token).
The 'unit' parameter is not used at the moment, but allows to specify an specific unit of size (MB, KB, GB, etc). Default is MB.

### 6. Run the node

Then start the node:

```bash
npm run start
```

To run a second node, open a new terminal and follow these steps again. Now with the two nodes running, you should see the two nodes discovery/connecting/disconnecting with each other.

Load postman collection from docs and play

## Docker:

First, build the image:

```bash
docker build -t 'ocean-node:mybuild' .
```

Then run it:

```bash
docker run -e PRIVATE_KEY=0x123 ocean-node:mybuild
```

## Structure:

- Everything hovers around components:
  - database: will have connection to typesense/es and will implement basic operations. This is used by all other components
  - indexer: upcoming indexer feature
  - provider: will have core provider functionality
  - httpRoutes: exposes http endpoints
  - P2P: has P2P functionality. will have to extend handleBroadcasts and handleProtocolCommands, rest is pretty much done

## Environment Variables

For advanced uses, various aspects of `ocean-node` can further be configured through [environment
variables](docs/environment-variables.md).

## Run tests

### Unit tests

```bash
npm run test:unit
```

## Integration tests

Now, back in your nodes terminal, you can run the tests

```bash
npm run test:integration
```

If you started barge without c2d components you can run a lighter version of integration tests that do not run the compute to data tests.

```bash
npm run test:integration:light
```

## Unit and integration .environments

Whenever possible, we should avoid overriding .env variables, as it might affect local configuration and other tests
Avoid doing things like:

```bash
process.env.PRIVATE_KEY = '0xc594c6e5def4bab63ac29ee...'
```

If we really need to change/override existing .env config:
use:

```bash
setupEnvironment() / tearDownEnvironment()
```

instead (on before() and after() hooks respectively),
Any config changes will not be permanent and the environment is preserved between tests

## Performance tests

There are 3 different scenarios that can be run; `smoke` tests, `load` tests, and `stress` tests.
Each one of those scenarios puts the ocean node into different traffic/request pressure conditions.

In order to start the suite, you need to have a running node instance first and then target the node on the tests.
Furthermore, you need to have previously installed grafana k6 tools on your machine: [https://grafana.com/docs/k6/latest/set-up/install-k6/](https://grafana.com/docs/k6/latest/set-up/install-k6/).
You can use `TARGET_URL` env variable to specify the target URL for the tests (by default runs against the local node, if any)

To run them, use one of the following options;

```bash
npm run test:smoke
npm run test:load
npm run test:stress
```

The 1st option performs a more "lightweight" approach, with fewer requests and less virtual users involved.
The 2nd and the 3rd options put the node into greater pressure for longer periods of time, also making more requests and simulating more usage
Additionally, you can also execute another test that will instruct the k6 script to keep the request rate under the node `RATE LIMIT` verifications
By default (can be customized) the ocean node allows a MAX of 3 requests per second, from the same originating address/ip. Anything above that is denied.
So if you want to avoid the rate limitations and still perform a battery of HTTP requests, you can set `RATE_LIMIT` env var.
The value of this variable should be lower than the value definied on the node itself (same env var name on the node instance)
To run this rate limited tests do;

```bash
npm run test:request:rate
```

At the end of the test suite, you can check the generated HTML report `html-report.html` for more insigths.
Additionally, while the tests are running you can open
a browser page at `http://127.0.0.1:5665/` and see a live report

For a more detailed view of all the options available and the type of requests executed check the script: [./src/test/performance/util.js](./src/test/performance/util.js)

## Additional tests / helper scripts

There are a couple of helper scripts to help test additional functionality and components integration. These can be found under 'src/helpers/scripts'
To run them, do either:

```
npm run client
```

(Purpose: for downloadURL flow. It requires at least 2 nodes properly configured and running)

OR

```
npm run check-nonce
```

(Purpose: for checking nonce tracking flow. This last one requires DB up and running)

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

## CI Envs

A full list of all environmental variables is available in [env.md](./env.md)

For now, we have three private keys defined (NODE1_PRIVATE_KEY, NODE2_PRIVATE_KEY,NODE3_PRIVATE_KEY). They are using the 7th, 8th and 9th accounts of barge:

- (7) 0x1d751ded5a32226054cd2e71261039b65afb9ee1c746d055dd699b1150a5befc
- (8) 0xfd5c1ccea015b6d663618850824154a3b3fb2882c46cefb05b9a93fea8c3d215
- (9) 0x1263dc73bef43a9da06149c7e598f52025bf4027f1d6c13896b71e81bb9233fb

## Dashboard

The dashboard is built by default with the Ocean Node. Set the environmental variables and then run the following commands from the root of the project:

```
npm run build
npm run start
```

The dashboard will be made available at: `http://localhost:8000/dashboard/`

## Networking in cloud environments or DMZ

In order for your node to join the network, the others nodes needs to be able to connect to it.
All options can be controlled using [environment
variables](env.md#p2p)

To quickly start your node, you can keep all of the default values,but most likely it will hurt performance. If you want a customised approach, here are the full steps:

- decide what IP version to use (IPV4 or/and IPv6). You should use both if available.
- decide if you want to filter private ips (if you run multiple nodes in a LAN or cloud environment, leave them on)
- if you already have an external ip configured on your machine, you are good to go.
- if you have a private ip, but an UPNP gateway, you should be fine as well.
- if you have a private ip and you can forward external ports from your gateway, use P2P_ANNOUNCE_ADDRESSES and let other nodes know your external IP/port.
- if you cannot forward ports on your gateway, the only choice is to use a circuit relay server (then all traffic will go through that node and it will proxy)

In order to check connectivity, you can do the following:

### On your node, check and observe how your node sees itself:

```bash
curl http://localhost:8000/getP2pPeer?peerId=16Uiu2HAkwWe6BFQXZWg6zE9X7ExynvXEe9BRTR5Wn3udNs7JpUDx
```

and observe the addresses section:

```json
{
  "addresses": [
    { "multiaddr": "/ip4/127.0.0.1/tcp/34227", "isCertified": false },
    { "multiaddr": "/ip4/127.0.0.1/tcp/36913/ws", "isCertified": false },
    { "multiaddr": "/ip4/172.15.0.1/tcp/34227", "isCertified": false },
    { "multiaddr": "/ip4/172.15.0.1/tcp/36913/ws", "isCertified": false },
    { "multiaddr": "/ip4/172.26.53.25/tcp/34227", "isCertified": false },
    { "multiaddr": "/ip4/172.26.53.25/tcp/36913/ws", "isCertified": false },
    { "multiaddr": "/ip6/::1/tcp/41157", "isCertified": false }
  ],
  "protocols": [
    "/floodsub/1.0.0",
    "/ipfs/id/1.0.0",
    "/ipfs/id/push/1.0.0",
    "/ipfs/ping/1.0.0",
    "/libp2p/autonat/1.0.0",
    "/libp2p/circuit/relay/0.2.0/hop",
    "/libp2p/circuit/relay/0.2.0/stop",
    "/libp2p/dcutr",
    "/meshsub/1.0.0",
    "/meshsub/1.1.0",
    "/ocean/nodes/1.0.0",
    "/ocean/nodes/1.0.0/kad/1.0.0",
    "/ocean/nodes/1.0.0/lan/kad/1.0.0"
  ],
  "metadata": {},
  "tags": {},
  "id": "16Uiu2HAkwWe6BFQXZWg6zE9X7ExynvXEe9BRTR5Wn3udNs7JpUDx",
  "publicKey": "08021221021efd24150c233d689ade0f9f467aa6a5a2969a5f52d70c85caac8681925093e3"
}
```

Are any of those IPs reachable from other nodes?

### To observe how your node is seen by others, start your node, wait a bit and then ask another node to give you details about you:

```bash
 curl http://node2.oceanprotocol.com:8000/getP2pPeer?peerId=16Uiu2HAk
wWe6BFQXZWg6zE9X7ExynvXEe9BRTR5Wn3udNs7JpUDx
```
