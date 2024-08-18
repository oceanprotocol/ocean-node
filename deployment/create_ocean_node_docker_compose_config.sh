#!/usr/bin/env bash

validate_hex() {
  if [[ ! "$1" =~ ^0x[0-9a-fA-F]{64}$ ]]; then
    echo "The private key seems invalid, exiting ..."
    exit 1
  fi
}

validate_address() {
  if [[ ! "$1" =~ ^0x[0-9a-fA-F]{40}$ ]]; then
    echo "Invalid wallet address, exiting!"
    exit 1
  fi
}

validate_port() {
  if [[ ! "$1" =~ ^[0-9]+$ ]] || [ "$1" -le 1024 ] || [ "$1" -ge 65535 ]; then
    echo "Invalid port number, it must be between 1024 and 65535."
    exit 1
  fi
}

read -p "Do you have your private key for running the Ocean Node [ y/n ]: " has_key

if [ "$has_key" == "y" ]; then
  read -p "Enter your private key: " PRIVATE_KEY
  validate_hex "$PRIVATE_KEY"
else
  read -p "Do you want me to create a private key for you [ y/n ]: " create_key
  if [ "$create_key" == "n" ]; then
    echo "Exiting! Private Key is a mandatory variable"
    exit 1
  fi
  
  echo "Generating Private Key, please wait..."
  output=$(docker run --rm oceanprotocol/web3-account-generator)
  PRIVATE_KEY=$(echo "$output" | grep "Private Key:" | awk '{print $3}')
  echo -e "Generated Private Key: \e[1;31m$PRIVATE_KEY\e[0m" 
  validate_hex "$PRIVATE_KEY"
fi

read -p "Please provide the wallet address to be added as Ocean Node admin account: " ALLOWED_ADMINS
validate_address "$ALLOWED_ADMINS"

echo -ne "Provide the HTTP_API_PORT value or accept the default (press Enter) [\e[1;32m8000\e[0m]: "
read HTTP_API_PORT
HTTP_API_PORT=${HTTP_API_PORT:-8000}
validate_port "$HTTP_API_PORT"

echo -ne "Provide the P2P_ipV4BindTcpPort or accept the default (press Enter) [\e[1;32m9000\e[0m]: "
read P2P_ipV4BindTcpPort
P2P_ipV4BindTcpPort=${P2P_ipV4BindTcpPort:-9000}
validate_port "$P2P_ipV4BindTcpPort"

echo -ne "Provide the P2P_ipV4BindWsPort or accept the default (press Enter) [\e[1;32m9001\e[0m]: "
read P2P_ipV4BindWsPort
P2P_ipV4BindWsPort=${P2P_ipV4BindWsPort:-9001}
validate_port "$P2P_ipV4BindWsPort"

echo -ne "Provide the P2P_ipV6BindTcpPort or accept the default (press Enter) [\e[1;32m9002\e[0m]: "
read P2P_ipV6BindTcpPort
P2P_ipV6BindTcpPort=${P2P_ipV6BindTcpPort:-9002}
validate_port "$P2P_ipV6BindTcpPort"

echo -ne "Provide the P2P_ipV6BindWsPort or accept the default (press Enter) [\e[1;32m9003\e[0m]: "
read P2P_ipV6BindWsPort
P2P_ipV6BindWsPort=${P2P_ipV6BindWsPort:-9003}
validate_port "$P2P_ipV6BindWsPort"

cat <<EOF > docker-compose.yml
services:
  ocean-node:
    image: oceanprotocol/ocean-node:latest
    pull_policy: always
    container_name: ocean-node
    restart: on-failure
    ports:
      - "$HTTP_API_PORT:$HTTP_API_PORT"
      - "$P2P_ipV4BindTcpPort:$P2P_ipV4BindTcpPort"
      - "$P2P_ipV4BindWsPort:$P2P_ipV4BindWsPort"
      - "$P2P_ipV6BindTcpPort:$P2P_ipV6BindTcpPort"
      - "$P2P_ipV6BindWsPort:$P2P_ipV6BindWsPort"
    environment:
      PRIVATE_KEY: '$PRIVATE_KEY'
      RPCS: '{"1":{"rpc":"https://ethereum-rpc.publicnode.com","fallbackRPCs":["https://rpc.ankr.com/eth","https://1rpc.io/eth","https://eth.api.onfinality.io/public"],"chainId":1,"network":"mainnet","chunkSize":100},"10":{"rpc":"https://mainnet.optimism.io","fallbackRPCs":["https://optimism-mainnet.public.blastapi.io","https://rpc.ankr.com/optimism","https://optimism-rpc.publicnode.com"],"chainId":10,"network":"optimism","chunkSize":100},"137":{"rpc":"https://polygon-rpc.com/","fallbackRPCs":["https://polygon-mainnet.public.blastapi.io","https://1rpc.io/matic","https://rpc.ankr.com/polygon"],"chainId":137,"network":"polygon","chunkSize":100},"23294":{"rpc":"https://sapphire.oasis.io","fallbackRPCs":["https://1rpc.io/oasis/sapphire"],"chainId":23294,"network":"sapphire","chunkSize":100},"23295":{"rpc":"https://testnet.sapphire.oasis.io","chainId":23295,"network":"sapphire-testnet","chunkSize":100},"11155111":{"rpc":"https://eth-sepolia.public.blastapi.io","fallbackRPCs":["https://1rpc.io/sepolia","https://eth-sepolia.g.alchemy.com/v2/demo"],"chainId":11155111,"network":"sepolia","chunkSize":100},"11155420":{"rpc":"https://sepolia.optimism.io","fallbackRPCs":["https://endpoints.omniatech.io/v1/op/sepolia/public","https://optimism-sepolia.blockpi.network/v1/rpc/public"],"chainId":11155420,"network":"optimism-sepolia","chunkSize":100}}'
      DB_URL: 'http://typesense:8108/?apiKey=xyz'
      IPFS_GATEWAY: 'https://ipfs.io/'
      ARWEAVE_GATEWAY: 'https://arweave.net/'
      LOAD_INITIAL_DDOS: ''
      FEE_TOKENS: ''
      FEE_AMOUNT: ''
      ADDRESS_FILE: ''
      NODE_ENV: ''
      AUTHORIZED_DECRYPTERS: ''
      OPERATOR_SERVICE_URL: ''
      INTERFACES: ''
      ALLOWED_VALIDATORS: ''
      INDEXER_NETWORKS: '[]'
      ALLOWED_ADMINS: '["$ALLOWED_ADMINS"]'
      INDEXER_INTERVAL: ''
      DASHBOARD: 'true'
      RATE_DENY_LIST: ''
      MAX_REQ_PER_SECOND: ''
      MAX_CHECKSUM_LENGTH: ''
      LOG_LEVEL: ''
      HTTP_API_PORT: '$HTTP_API_PORT'
      P2P_ENABLE_IPV4: ''
      P2P_ENABLE_IPV6: ''
      P2P_ipV4BindAddress: ''
      P2P_ipV4BindTcpPort: '$P2P_ipV4BindTcpPort'
      P2P_ipV4BindWsPort: '$P2P_ipV4BindWsPort'
      P2P_ipV6BindAddress: ''
      P2P_ipV6BindTcpPort: '$P2P_ipV6BindTcpPort'
      P2P_ipV6BindWsPort: '$P2P_ipV6BindWsPort'
      P2P_ANNOUNCE_ADDRESSES: ''
      P2P_ANNOUNCE_PRIVATE: ''
      P2P_pubsubPeerDiscoveryInterval: ''
      P2P_dhtMaxInboundStreams: ''
      P2P_dhtMaxOutboundStreams: ''
      P2P_mDNSInterval: ''
      P2P_connectionsMaxParallelDials: ''
      P2P_connectionsDialTimeout: ''
      P2P_ENABLE_UPNP: ''
      P2P_ENABLE_AUTONAT: ''
      P2P_ENABLE_CIRCUIT_RELAY_SERVER: ''
      P2P_ENABLE_CIRCUIT_RELAY_CLIENT: ''
      P2P_BOOTSTRAP_NODES: ''
      P2P_FILTER_ANNOUNCED_ADDRESSES: ''
    networks:
      - ocean_network
    depends_on:
      - typesense

  typesense:
    image: typesense/typesense:26.0
    container_name: typesense
    ports:
      - "8108:8108"
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
EOF

echo -e "\e[1;32mDocker Compose file has been generated successfully.\e[0m"
echo ""
echo -e "\e[1;32mYou are now ready to start your Ocean Node.\e[0m"
echo ""
echo -e "\e[1;32m1)\e[0m If further customization is required, edit the \e[1;32mdocker-compose.yml\e[0m file."
echo -e "For all available configurations, refer to the Environment Variables documentation:"
echo -e "\e[1;34mhttps://github.com/oceanprotocol/ocean-node/blob/main/docs/env.md\e[0m"
echo ""
echo -e "\e[1;32m2)\e[0m Start your Ocean Node by running the command:"
echo -e "\e[1;32mdocker-compose up -d\e[0m"
echo ""
echo -e "\e[1;32m3)\e[0m Allow the following incoming TCP ports through the firewall:"
echo -e "\e[1;32mHTTP API Port: $HTTP_API_PORT\e[0m"
echo -e "\e[1;32mP2P IPv4 TCP Port: $P2P_ipV4BindTcpPort\e[0m"
echo -e "\e[1;32mP2P IPv4 WebSocket Port: $P2P_ipV4BindWsPort\e[0m"
echo -e "\e[1;32mP2P IPv6 TCP Port: $P2P_ipV6BindTcpPort\e[0m"
echo -e "\e[1;32mP2P IPv6 WebSocket Port: $P2P_ipV6BindWsPort\e[0m"
