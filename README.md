# ocean-node

WIP, may not compile.

## 1. Make sure to use nvm

```bash
nvm use
```

## 2. Install deps

```bash
npm i
```

## 3. Build

```bash
npm run build
```

## 4. Open terminal 1 and run a node

```bash
export HTTP_API_PORT=8000
export PRIVATE_KEY=0x.....
export RPCS="{ \"1\":{ \"rpc\":\"https://rpc.eth.gateway.fm\", \"chainId\": 1, \"network\": \"mainet\", \"chunkSize\": 100 }, \"137\": { \"rpc\": \"https://polygon.meowrpc.com\", \"chainId\": 137, \"network\": \"polygon\", \"chunkSize\": 100 }, \"80001\": { \"rpc\": \"https://rpc-mumbai.maticvigil.com\", \"chainId\": 80001, \"network\": \"polygon-mumbai\", \"chunkSize\": 100 }}"
npm run start
```

## 4. Open a 2nd terminal and run another node

```bash
export HTTP_API_PORT=8001
export PRIVATE_KEY=0x.....
export RPCS="{ \"1\": \"https://rpc.eth.gateway.fm\", \"137\": \"https://polygon.meowrpc.com\", \"80001\": \"https://rpc-mumbai.maticvigil.com\" }"
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

Before running tests, please run Typesense docker

```
docker-compose -f typesense-compose.yml -p ocean-node up -d
```

You can then run tests

```
npm run test
```
