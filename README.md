# ocean-node

WIP, may not compile.

## Running Locally

### 1. Make sure to use nvm

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

### 5. Open terminal 1 and run a node

```bash
export HTTP_API_PORT=8000
export PRIVATE_KEY=0x.....
export RPCS="{ \"1\":{ \"rpc\":\"https://rpc.eth.gateway.fm\", \"chainId\": 1, \"network\": \"mainet\", \"chunkSize\": 100 }, \"137\": { \"rpc\": \"https://polygon.meowrpc.com\", \"chainId\": 137, \"network\": \"polygon\", \"chunkSize\": 100 }, \"80001\": { \"rpc\": \"https://rpc-mumbai.maticvigil.com\", \"chainId\": 80001, \"network\": \"polygon-mumbai\", \"chunkSize\": 100 }}"
```

For downloading the file from IPFS or ARWEAVE, please export the following env variables;

```bash
export IPFS_GATEWAY='https://ipfs.io/'
export ARWEAVE_GATEWAY='https://arweave.net/'
```

Then start the node:

```bash
npm run start
```

### 5. Open a 2nd terminal and run another node

```bash
export HTTP_API_PORT=8001
export PRIVATE_KEY=0x.....
export RPCS="{ \"1\": \"https://rpc.eth.gateway.fm\", \"137\": \"https://polygon.meowrpc.com\", \"80001\": \"https://rpc-mumbai.maticvigil.com\" }"
```

For downloading the file from IPFS or ARWEAVE, please export the following env variables;

```bash
export IPFS_GATEWAY=''
export ARWEAVE_GATEWAY=''
```

For configuring the ocean node fees, please export the following environment variables;

```bash
export FEE_TOKENS="{ \"1\": \"0x967da4048cD07aB37855c090aAF366e4ce1b9F48\", \"137\": \"0x282d8efCe846A88B159800bd4130ad77443Fa1A1\", \"80001\": \"0xd8992Ed72C445c35Cb4A2be468568Ed1079357c8\", \"56\": \"0xDCe07662CA8EbC241316a15B611c89711414Dd1a\" }"
export FEE_AMOUNT="{ \"amount\": 1, \"unit\": \"MB\" }"
```

Where FEE_TOKENS is a map (chainID => Token address) and FEE_AMOUNT is the fees amount (unit of fee token).
The 'unit' parameter is not used at the moment, but allows to specify an specific unit of size (MB, KB, GB, etc). Default is MB.

Then start the node:

```bash
npm run start
```

Now, you should see the nodes discovery/connecting/disconnecting

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

For now, we have three private keys defined (NODE1_PRIVATE_KEY, NODE2_PRIVATE_KEY,NODE3_PRIVATE_KEY). They are using the 10th,11th and 12rd accounts of barge:

- (10) 0xee59A16d95042e1B252d4598e2e503837a52eCb1
- (11) 0x320608cEB9B40fC5a77596CCad2E0B35659fbb2C
- (12) 0x675003EF9a381Edb5bA2A954eD4b15037C602A2d
