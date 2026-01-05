#!/bin/bash


current_dir=`pwd`
scripts_directory='helpers/scripts'
echo "#########################################################"
echo "Running scripts for initial Ocean Node configuration"
echo "#########################################################"

#where are we running this from?
is_root_dir=1
if [[ $current_dir =~ $scripts_directory ]]; then  
  is_root_dir=0
fi

#did we generate a pk?
created_pk_file=0

pk_file='.pk.out'
wallet_file='.wallet.out'
#assume we are running on scripts directory
# these are the "target" paths
env_file_path='../../../.env'
template_file_path='../../../.env.example'
generated_files_path='../../../'

#current directory is ocean node directory?
if [ $is_root_dir -eq 1 ]; then
    env_file_path='.env'
    template_file_path='.env.example'
    generated_files_path=''
fi
#allow script to be run from multiple paths (root or inside scripts directory)
wallet_file_path=$generated_files_path$wallet_file
pk_file_path+=$generated_files_path$pk_file


#configure database
configure_database() {
    echo "------------------------ Configure Database ----------------------------------"
    read -p "Database URL? [ http://localhost:8108/?apiKey=xyz ]: " DB_URL
    DB_URL=${DB_URL:-http://localhost:8108/?apiKey=xyz}
    REPLACE_STR="DB_URL=$DB_URL"
    if [ "$(uname)" == "Darwin" ]; then
        sed -i '' -e 's;DB_URL=;'$REPLACE_STR';' "$env_file_path"
    else
        sed -i -e 's;DB_URL=;'$REPLACE_STR';' "$env_file_path"
    fi
    echo "DB_URL final configuration: $REPLACE_STR"
    echo "------------------------------------------------------------------------------"
}
#configure a basic RPC setting
configure_rpc() {
    echo "------------------------ Configure RPC ---------------------------------------"
    echo "This basic setup only allows configuration of 1 network, but you can configure multiple RPCS, if needed."
    echo "For a detailed list of chain names, ids and rpcs, you can check: 'https://chainlist.org/'"
    echo "------------------------------------------------------------------------------"
    read -p "Chain name? [ optimism-sepolia ]: " chain_name
    chain_name=${chain_name:-optimism-sepolia}
    read -p "Chain id? [ 11155420 ]: " chain_id
    chain_id=${chain_id:-11155420}
    read -p "Chain RPC Url? [ https://sepolia.optimism.io ]: " chain_rpc
    chain_rpc=${chain_rpc:-https://sepolia.optimism.io}
    read -p "Chunk size (number of block to process at once)? [ 100 ]: " chunk_size
    chunk_size=${chunk_size:-100}
    echo "Provided values: (you can always edit and add more details directly on '$env_file_path')"
    echo "Chain name: $chain_name"
    echo "Chain id: $chain_id"
    echo "Chain RPC: $chain_rpc"
    echo "Chunk size: $chunk_size"
    RPCS="{ \"$chain_id\":{ \"rpc\":\"$chain_rpc\", \"chainId\": $chain_id, \"network\": \"$chain_name\", \"chunkSize\": $chunk_size }}"
    echo "RPCS final configuration: $RPCS"
    RPCS_QUOTED=${RPCS//\"/\\\"}
    REPLACE_STR="RPCS='$RPCS_QUOTED'"
    if [ "$(uname)" == "Darwin" ]; then
        sed -i '' -e "s;RPCS=;$REPLACE_STR;" "$env_file_path"
    else
        sed -i -e "s;RPCS=;$REPLACE_STR;" "$env_file_path"
    fi
    echo "------------------------------------------------------------------------------"
}
#basic check on the pk length
check_pk() {
   pk=$1
   length=${#pk}
   echo "Pk size is $length"
   #66 with 0x prefix
   if [ $length -lt 64 ]; then
     echo "The provided private Key seems invalid!"
     exit 1
   fi 
}
#another basic check on the address
check_wallet() {
   wallet=$1
   length=${#wallet}
   echo "Wallet size is $length"
   #42 with 0x prefix
   if [ $length -lt 40 ]; then
     echo "The provided wallet address seems invalid!"
     exit 1
   fi 
}
#check if .env exists
check_env_file() {
    
    if ! [ -f $env_file_path ]; then
        exists_env_file=0
    else
        exists_env_file=1
    fi
}

ofuscate_private_key() {
    pk=$1
    length=${#pk}
    PRIVATE_KEY_CUT=${pk:length-50:50}
    OFUSCATED_PRIVATE_KEY="${pk/$PRIVATE_KEY_CUT/*********}"
}
#create .env from .env.example
create_env_file_from_template() {
    if [ -f $template_file_path ]; then
        `cp $template_file_path $env_file_path`
        created_env_file=1
    else
        echo "Could not find the example file, aborting!"
        exit 1
    fi
}

setup_private_key() {
    if [ "$(uname)" == "Darwin" ]; then
        sed -i '' -e 's/REPLACE_ME/'$PRIVATE_KEY'/' "$env_file_path"
    else
        sed -i -e 's/REPLACE_ME/'$PRIVATE_KEY'/' "$env_file_path"
    fi
}

setup_node_admin_wallet() {
    
    REPLACE_STR="ALLOWED_ADMINS='[\"$ADMIN_WALLET\"]'"
    if [ "$(uname)" == "Darwin" ]; then
        sed -i '' -e 's;ALLOWED_ADMINS=;'$REPLACE_STR';' "$env_file_path"
    else
        sed -i -e 's;ALLOWED_ADMINS=;'$REPLACE_STR';' "$env_file_path"
    fi
}

#check if the private key file exists
if ! [ -f $pk_file_path ]; then
  echo "Private Key File does not exist."
  read -p "Do you want me to generate one for you? [ y/n ]: " generate_key_answer
  generate_key_answer=${generate_key_answer:-n}
 
  if [ "$generate_key_answer" == 'y' ]; then
    # run the script
    if [ $is_root_dir -eq 1 ]; then
        #run from the root directory
        `node ./src/$scripts_directory/generatePK.js --save > /dev/null`
    else
        #run from the scripts directory
        `node ./generatePK.js --save > /dev/null`
        pk_file_path=$pk_file
    fi
    
    # read the file contents
    PRIVATE_KEY=`cat $pk_file_path`
    ofuscate_private_key $PRIVATE_KEY
    echo "Generated Private Key: $OFUSCATED_PRIVATE_KEY"
    created_pk_file=1
    
  else
        read -p "Enter your private key: " PRIVATE_KEY
        ofuscate_private_key $PRIVATE_KEY
        echo "Entered private key: $OFUSCATED_PRIVATE_KEY"
        check_pk $PRIVATE_KEY
   fi
else
    echo "We found a Private Key File."
    read -p "Do you want to use it? [ y/n ]: " use_file_key
    use_file_key=${use_file_key:-y}
    if [ "$use_file_key" == 'y' ]; then
        PRIVATE_KEY=`cat $pk_file_path`
        ofuscate_private_key $PRIVATE_KEY
        echo "Using Private key: $OFUSCATED_PRIVATE_KEY"
        created_pk_file=1
    else
        read -p "Enter your private key: " PRIVATE_KEY
        ofuscate_private_key $PRIVATE_KEY
        echo "Entered private key: $OFUSCATED_PRIVATE_KEY"
        check_pk $PRIVATE_KEY
    fi
fi

check_env_file
#if does not exists, create it from template or ask input
if [ $exists_env_file -eq 0 ]; then
    echo "Initial .env file not detected!"
    read -p "Do you want me to create one from the template? [ y/n ]: " create_env_file
    create_env_file=${create_env_file:-y}
    echo "Creating env file?: $create_env_file"
    if [ "$create_env_file" == 'y' ]; then
        create_env_file_from_template
        if [ $created_env_file -eq 1 ]; then
            echo "------------------------------------------------------------------------------"
            echo "Successfully created an .env file. We will now try to setup a basic configuration on it."
            echo "If you need extra customizations, please update it before starting the node!"
            echo "Once you're done with your changes, run 'source .env' (on your ocean node root folder)," 
            echo "before starting the node, in order to apply the environment changes."
            echo "------------------------------------------------------------------------------"
            #configure the pk key on the .env file
            setup_private_key
            #Use wallet address from file? only if we just created it
            read -p "Enter your admin wallet address: " ADMIN_WALLET
            check_wallet $ADMIN_WALLET
            setup_node_admin_wallet
            
        fi
    else ``
        echo "Creating .env file aborted!"
        created_env_file=0
        exit 1
    fi
else
    echo "Initial .env file already detected!"
    echo "Please remove it first, if you want to use this script as initial setup (otherwise values might be overriden)."
    exit 1
fi

read -p "Do you want to run a database on your node? [ y/n ]: " run_database
run_database=${run_database:-n}
if [ "$run_database" == 'y' ]; then
    configure_database
fi

read -p "Do you want to index a network on your node? [ y/n ]: " run_indexer
run_indexer=${run_indexer:-n}
if [ "$run_indexer" == 'y' ]; then
    configure_rpc
fi

# Check if user wants to enable compute functionality
read -p "Do you want to enable compute functionality on your node? [ y/n ]: " enable_compute
enable_compute=${enable_compute:-y}
if [ "$enable_compute" == 'y' ]; then
    echo ""
    echo "✅ Setting default Docker compute environment configuration"
    echo "   This enables compute-to-data functionality with standard resource limits:"
    echo "   • Docker socket path: /var/run/docker.sock"
    echo "   • Storage expiry: 7 days (604800 seconds)"
    echo "   • Max job duration: 10 hours (36000 seconds)"
    echo "   • Free compute resources: 1 CPU, 1GB RAM, 1GB disk"
    echo "   • Maximum free jobs: 3 concurrent jobs"
    echo ""
    echo "   You can customize this in your .env file for production use."
    echo ""
    
    DOCKER_COMPUTE_ENV="[{\"socketPath\":\"/var/run/docker.sock\",\"resources\":[{\"id\":\"disk\",\"total\":10}],\"storageExpiry\":604800,\"maxJobDuration\":36000,\"minJobDuration\":60,\"fees\":{\"1\":[{\"feeToken\":\"0x123\",\"prices\":[{\"id\":\"cpu\",\"price\":1}]}]},\"free\":{\"maxJobDuration\":360000,\"minJobDuration\":60,\"maxJobs\":3,\"resources\":[{\"id\":\"cpu\",\"max\":1},{\"id\":\"ram\",\"max\":1},{\"id\":\"disk\",\"max\":1}]}}]"
    
    REPLACE_STR="DOCKER_COMPUTE_ENVIRONMENTS='$DOCKER_COMPUTE_ENV'"
    if [ "$(uname)" == "Darwin" ]; then
        sed -i '' -e "s;DOCKER_COMPUTE_ENVIRONMENTS=;$REPLACE_STR;" "$env_file_path"
    else
        sed -i -e "s;DOCKER_COMPUTE_ENVIRONMENTS=;$REPLACE_STR;" "$env_file_path"
    fi
    echo "Compute environment successfully configured!"
fi
echo "------------------------------------------------------------------------------"

if [ $created_pk_file -eq 1 ]; then
    read -p "Do you want me to delete the generated $pk_file file? (your key is already saved): [ y/n ]" delete_pk_file
    delete_pk_file=${delete_pk_file:-n}
    if [ "$delete_pk_file" == 'y' ]; then
        # set proper paths for deletion
        pk_file_path=$pk_file
        wallet_file_path=$wallet_file
        #remove pk one
        `rm -f $pk_file_path`
        #also remove the wallet one if present
        `rm -f $wallet_file_path`
    fi
fi

echo "All Done!"




