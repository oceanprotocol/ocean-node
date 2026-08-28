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

---

## Persistent node data (required)

The image declares a `VOLUME` at `/usr/src/app/databases`, and **that mount point must be
backed by a persistent volume in production** - a named volume, a bind mount, or the
Kubernetes-equivalent persistent volume claim. The compose file produced by
`ocean-node-quickstart.sh` already does this with the `node-sqlite` named volume; if you write
your own compose file, or run `docker run` by hand, you have to do it yourself:

```shell
$ docker run -d \
    -e PRIVATE_KEY="$PRIVATE_KEY" \
    -v ocean-node-databases:/usr/src/app/databases \
    -p 8000:8000 -p 9000-9003:9000-9003 \
    oceanprotocol/ocean-node:latest
```

This is not just a convenience. `/usr/src/app/databases` holds:

- the SQLite databases - nonce tracking, node config, C2D job records and auth tokens;
- `databases/p2p-store`, the libp2p LevelDB datastore.

The datastore is what makes the node keep answering for the assets it holds. Its own DHT
provider records are written from three places and no others: when the indexer sees a new
metadata event, once at startup, and by kad-dht's own reprovider, which refreshes them from
that datastore. Provider records are valid for 48 hours and the reprovider renews them well
inside that window, but only for the records it can still find on disk. Start the container
without a persistent mount and every restart hands it an empty datastore, so there is nothing
left to renew: the records age out of the network and remote `FindDDO` stops returning a node
that is sitting on the DDO, with nothing in the logs to say so.

Without an explicit mount, docker attaches a fresh **anonymous** volume to the declared mount
point. That survives `docker restart` but not `docker-compose down`, `docker rm`, or
`docker-compose up --force-recreate`, and it is invisible in `docker volume ls` under any name
you would recognise - so it looks like persistence right up to the point where it is not.

Check that a running deployment really has a named mount:

```shell
$ docker inspect -f '{{range .Mounts}}{{.Type}} {{.Name}} -> {{.Destination}}{{"\n"}}{{end}}' ocean-node
volume node-sqlite -> /usr/src/app/databases
```

An empty `.Name` on that line means the mount is anonymous and the data is one
`docker-compose down` away from being gone.

Ownership is handled for you: the image creates the directory owned by the unprivileged `node`
user it runs as, and `docker-entrypoint.sh` re-applies ownership at startup, which is what
makes a bind mount of a host directory work regardless of who created it on the host.

The two development compose files in the repository root, `typesense-compose.yml` and
`elasticsearch-compose.yml`, carry the same mount on an `ocean-node` service behind a compose
profile, so they are only started when asked for:

```shell
$ PRIVATE_KEY=0x... docker-compose -f typesense-compose.yml --profile node up -d
```

Without `--profile node` those files still start only the database, which is what the
"run the node from npm" workflow in the README expects.

---

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
    volumes:
      # required - see "Persistent node data" above
      - node-sqlite:/usr/src/app/databases
      - /var/run/docker.sock:/var/run/docker.sock
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
  node-sqlite:
    driver: local

networks:
  ocean_network:
    driver: bridge
```
