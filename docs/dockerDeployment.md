# Docker Deployment Guide

This guide is intended to provide quick steps for starting an **Ocean Node** using Docker Engine and Docker Compose plugin.

Note: For installing each of these prerequisites, a good starting point is the official documentation: [Install Docker Engine](https://docs.docker.com/engine/install/) and [Overview of installing Docker Compose](https://docs.docker.com/compose/install/)

Before starting, confirm that the [system requirements](https://github.com/oceanprotocol/ocean-node?tab=readme-ov-file#system-requirements) are met.

a) download the script `ocean-node-quickstart.sh` from the scripts directory

b) run the script

```shell
bash scripts/ocean-node-quickstart.sh
```

c) provide the necessary information interactively (example)

```shell
Do you have your private key for running the Ocean Node [ y/n ]: n
Do you want me to create a private key for you [ y/n ]: y
Generating Private Key, please wait...
Generated Private Key: << redacted >>
Please provide the wallet address to be added as Ocean Node admin account: << redacted >>
Provide the HTTP_API_PORT value or accept the default (press Enter) [8000]:
Provide the P2P_ipV4BindTcpPort or accept the default (press Enter) [9000]:
Provide the P2P_ipV4BindWsPort or accept the default (press Enter) [9001]:
Provide the P2P_ipV6BindTcpPort or accept the default (press Enter) [9002]:
Provide the P2P_ipV6BindWsPort or accept the default (press Enter) [9003]:
Provide the public IPv4/IPv6 address or FQDN where this node will be accessible: << redacted >>
Docker Compose file has been generated successfully.

You are now ready to start your Ocean Node.

1) If further customization is required, edit the docker-compose.yml file.
For all available configurations, refer to the Environment Variables documentation:
https://github.com/oceanprotocol/ocean-node/blob/main/docs/env.md

2) Start your Ocean Node by running the command:
docker-compose up -d

3) Allow the following incoming TCP ports through the firewall:
HTTP API Port: 8000
P2P IPv4 TCP Port: 9000
P2P IPv4 WebSocket Port: 9001
P2P IPv6 TCP Port: 9002
P2P IPv6 WebSocket Port: 9003
```

d) start your Ocean Node

```shell
$ docker-compose up -d
```

e) confirm that docker containers are running

```shell
$ docker ps
CONTAINER ID   IMAGE                             COMMAND                  CREATED          STATUS          PORTS                                                                                                      NAMES
188bf1eec4c1   oceanprotocol/ocean-node:latest   "npm run start"          11 seconds ago   Up 10 seconds   0.0.0.0:8000->8000/tcp, :::8000->8000/tcp, 0.0.0.0:9000-9003->9000-9003/tcp, :::9000-9003->9000-9003/tcp   ocean-node
858a59502302   typesense/typesense:26.0          "/opt/typesense-serv…"   17 seconds ago   Up 10 seconds   0.0.0.0:8108->8108/tcp, :::8108->8108/tcp                                                                  typesense
```

## Upgrade Ocean Node

Ocean Node container image is updated regularly. To upgrade to the latest version, run the following script. Required updated will be notified through our communication channels.

```shell
$ ./scripts/ocean-node-update.sh
```

If script is not executed you can change permissions and execute it.

```shell
$ chmod +x scripts/ocean-node-update.sh
$ ./scripts/ocean-node-update.sh
```




Additional notes:

- the docker compose file generated will have the following format. For all available configurations, refer to the [Environment Variables](https://github.com/oceanprotocol/ocean-node/blob/main/docs/env.md) documentation

```yaml
services:
  ocean-node:
    image: oceanprotocol/ocean-node:latest
    pull_policy: always
    container_name: ocean-node
    restart: on-failure
    ports:
      - '8000:8000'
      - '9000:9000'
      - '9001:9001'
      - '9002:9002'
      - '9003:9003'
    environment:
      PRIVATE_KEY: '<<redacted>>'
      RPCS: '{"1":{"rpc":"https://ethereum-rpc.publicnode.com","fallbackRPCs":["https://rpc.ankr.com/eth","https://1rpc.io/eth","https://eth.api.onfinality.io/public"],"chainId":1,"network":"mainnet","chunkSize":100},"10":{"rpc":"https://mainnet.optimism.io","fallbackRPCs":["https://optimism-mainnet.public.blastapi.io","https://rpc.ankr.com/optimism","https://optimism-rpc.publicnode.com"],"chainId":10,"network":"optimism","chunkSize":100},"137":{"rpc":"https://polygon-rpc.com/","fallbackRPCs":["https://polygon-mainnet.public.blastapi.io","https://1rpc.io/matic","https://rpc.ankr.com/polygon"],"chainId":137,"network":"polygon","chunkSize":100},"23294":{"rpc":"https://sapphire.oasis.io","fallbackRPCs":["https://1rpc.io/oasis/sapphire"],"chainId":23294,"network":"sapphire","chunkSize":100},"23295":{"rpc":"https://testnet.sapphire.oasis.io","chainId":23295,"network":"sapphire-testnet","chunkSize":100},"11155111":{"rpc":"https://eth-sepolia.public.blastapi.io","fallbackRPCs":["https://1rpc.io/sepolia","https://eth-sepolia.g.alchemy.com/v2/demo"],"chainId":11155111,"network":"sepolia","chunkSize":100},"11155420":{"rpc":"https://sepolia.optimism.io","fallbackRPCs":["https://endpoints.omniatech.io/v1/op/sepolia/public","https://optimism-sepolia.blockpi.network/v1/rpc/public"],"chainId":11155420,"network":"optimism-sepolia","chunkSize":100}}'
      DB_URL: 'http://typesense:8108/?apiKey=xyz'
      IPFS_GATEWAY: 'https://ipfs.io/'
      ARWEAVE_GATEWAY: 'https://arweave.net/'
      #      LOAD_INITIAL_DDOS: ''
      #      FEE_TOKENS: ''
      #      FEE_AMOUNT: ''
      #      ADDRESS_FILE: ''
      #      NODE_ENV: ''
      #      AUTHORIZED_DECRYPTERS: ''
      #      AUTHORIZED_DECRYPTERS_LIST: ''
      #      OPERATOR_SERVICE_URL: ''
      INTERFACES: '["HTTP","P2P"]'
      #      ALLOWED_VALIDATORS: ''
      #      INDEXER_NETWORKS: '[]'
      ALLOWED_ADMINS: '["<<redacted>>"]'
      #      INDEXER_INTERVAL: ''
      DASHBOARD: 'true'
      #      RATE_DENY_LIST: ''
      #      MAX_REQ_PER_MINUTE: ''
      #      MAX_CHECKSUM_LENGTH: ''
      #      LOG_LEVEL: ''
      HTTP_API_PORT: '8000'
      P2P_ENABLE_IPV4: 'true'
      P2P_ENABLE_IPV6: 'false'
      P2P_ipV4BindAddress: '0.0.0.0'
      P2P_ipV4BindTcpPort: '9000'
      P2P_ipV4BindWsPort: '9001'
      P2P_ipV6BindAddress: '::'
      P2P_ipV6BindTcpPort: '9002'
      P2P_ipV6BindWsPort: '9003'
      P2P_ANNOUNCE_ADDRESSES: '["/dns4/<<redacted>>/tcp/9000/p2p/", "/dns4/<<redacted>>/ws/tcp/9001", "/dns6/<<redacted>>/tcp/9002/p2p/", "/dns6/<<redacted>>/ws/tcp/9003"]'
    #      P2P_ANNOUNCE_PRIVATE: ''
    #      P2P_pubsubPeerDiscoveryInterval: ''
    #      P2P_dhtMaxInboundStreams: ''
    #      P2P_dhtMaxOutboundStreams: ''
    #      P2P_mDNSInterval: ''
    #      P2P_connectionsMaxParallelDials: ''
    #      P2P_connectionsDialTimeout: ''
    #      P2P_ENABLE_UPNP: ''
    #      P2P_ENABLE_AUTONAT: ''
    #      P2P_ENABLE_CIRCUIT_RELAY_SERVER: ''
    #      P2P_ENABLE_CIRCUIT_RELAY_CLIENT: ''
    #      P2P_BOOTSTRAP_NODES: ''
    #      P2P_FILTER_ANNOUNCED_ADDRESSES: ''
    networks:
      - ocean_network
    depends_on:
      - typesense

  typesense:
    image: typesense/typesense:26.0
    container_name: typesense
    ports:
      - '8108:8108'
    networks:
      - ocean_network
    volumes:
      - typesense-data:/data
    command: '--data-dir /data --api-key=xyz'

volumes:
  typesense-data:
    driver: local

networks:
  ocean_network:
    driver: bridge
```
