#!/bin/bash

if ! [ -f '.pk.out' ]; then
  echo "Private Key File does not exist."
  read -p "Do you want me to generate one for you? [y/n]: " generate_key_answer
  generate_key_answer=${generate_key_answer:-n}
  echo "Generating key? $generate_key_answer"
  if [ "$generate_key_answer" == 'y' ]; then
    # run the script
    `node ./generatePK.js > /dev/null`
    # read the file contents
    PRIVATE_KEY=`cat .pk.out`
    echo "Generated Private Key: $PRIVATE_KEY"
  else
        read -p "Enter your private key: " PRIVATE_KEY
        echo "Entered private key: $PRIVATE_KEY"
        length=${#PRIVATE_KEY}
        echo "Size is $length"
        if [ $length -lt 64 ]; then
            echo "The provided private Key seems invalid!"
            exit
        fi

   fi
else
    echo "We found a Private Key File."
    read -p "Do you want to use it? [y/n]: " use_file_key
    use_file_key=${use_file_key:-y}
    if [ "$use_file_key" == 'y' ]; then
        PRIVATE_KEY=`cat .pk.out`
        echo "Using Private key: $PRIVATE_KEY"
    else
        read -p "Enter your private key: " PRIVATE_KEY
        echo "Entered private key: $PRIVATE_KEY"
        length=${#PRIVATE_KEY}
        echo "Size is $length"
        if [ $length -lt 64 ]; then
            echo "The provided private Key seems invalid!"
            exit
        fi
    fi
fi

read -p "Enter your node HTTP port: " HTTP_API_PORT
HTTP_API_PORT=${HTTP_API_PORT:-8001}
export HTTP_API_PORT=$HTTP_API_PORT
export P2P_ipV4BindTcpPort=8000
export PRIVATE_KEY=$private_key
export DB_URL=http://localhost:8108/?apiKey=xyz
export IPFS_GATEWAY=https://ipfs.io/
export ARWEAVE_GATEWAY=https://arweave.net/
export OPERATOR_SERVICE_URL=[\"http://localhost:31000/\"]
export ALLOWED_ADMINS=[\"0xC3b17E73671502614485337995dc13d54DE2F0Ad\"]
export RPCS="{ \"8996\": {\"rpc\": \"http://127.0.0.1:8545\", \"chainId\": 8996, \"network\": \"development\", \"chunkSize\": 100}}"
export RPCS="{ \"11155420\":{ \"rpc\":\"https://sepolia.optimism.io\", \"startBlock\": 11916901, \"chainId\": 11155420, \"network\": \"optimism-sepolia\", \"chunkSize\": 100 }}"