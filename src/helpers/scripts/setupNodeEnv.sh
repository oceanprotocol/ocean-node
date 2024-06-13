#!/bin/bash

#basic check on the length
check_pk() {
   pk=$1
   echo "Entered private key: $pk"
   length=${#pk}
   echo "Size is $length"
   if [ $length -lt 64 ]; then
     echo "The provided private Key seems invalid!"
     exit 1
   fi 
}
#check if .env exists
check_env_file() {
    if ! [ -f '../../../.env' ]; then
        exists_env_file=0
    else
        exists_env_file=1
    fi
}
#create .env from .env.example
create_env_file() {
    if [ -f '../../../.env.example' ]; then
        `cp ../../../.env.example ../../../.env`
        created_env_file=1
    else
        echo "Could not find the example file, aborting!"
        exit 1
    fi
}

if ! [ -f '.pk.out' ]; then
  echo "Private Key File does not exist."
  read -p "Do you want me to generate one for you? [y/n]: " generate_key_answer
  generate_key_answer=${generate_key_answer:-n}
 
  if [ "$generate_key_answer" == 'y' ]; then
    # run the script
    `node ./generatePK.js --save > /dev/null`
    # read the file contents
    PRIVATE_KEY=`cat .pk.out`
    echo "Generated Private Key: $PRIVATE_KEY"
  else
        read -p "Enter your private key: " PRIVATE_KEY
        echo "Entered private key: $PRIVATE_KEY"
        check_pk $PRIVATE_KEY
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
        check_pk $PRIVATE_KEY
    fi
fi

check_env_file
#if does not exists, create it from template or ask input
if [ $exists_env_file -eq 0 ]; then
    echo "Initial .env file not detected!"
    read -p "Do you want me to create one from the template? [y/n]: " create_env_file
    create_env_file=${create_env_file:-y}
    echo "Creating env file?: $create_env_file"
    if [ "$create_env_file" == 'y' ]; then
        create_env_file
        if [ $created_env_file -eq 1 ]; then
            echo "------------------------------------------------------------------------------"
            echo "Successfully created .env file. Please update it before starting the node!"
            echo "Once you're done with your changes, run 'source .env' (on your ocean node root folder)," 
            echo "before building/starting the node, in order to apply the environment changes."
            echo "------------------------------------------------------------------------------"
        fi
    else 
        echo "Creating .env file aborted!"
        created_env_file=0
    fi
fi
echo "Done!"




