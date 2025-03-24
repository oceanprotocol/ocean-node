#!/bin/bash

DEFAULT_DOCKER_ENVIRONMENTS='[{"socketPath":"/var/run/docker.sock","resources":[{"id":"disk","total":1000000000}],"storageExpiry":604800,"maxJobDuration":36000,"fees":{"1":[{"feeToken":"0x123","prices":[{"id":"cpu","price":1}]}]},"free":{"maxJobDuration":360000,"maxJobs":3,"resources":[{"id":"cpu","max":1},{"id":"ram","max":1000000000},{"id":"disk","max":1000000000}]}}]'

check_prerequisites() {
    if [ ! -f "docker-compose.yml" ]; then
        echo "Error: docker-compose.yml not found in current directory"
        exit 1
    fi
}

configure_c2d() {
    if grep -q "DOCKER_COMPUTE_ENVIRONMENTS:" docker-compose.yml; then
        echo "DOCKER_COMPUTE_ENVIRONMENTS: configuration already exists"
    else
        echo "Adding Docker Compute Environment configuration..."
        read -p "Do you want to run docker C2D jobs on your Ocean Node [ y/n ]: " run_c2d_jobs
        
        if [ "$run_c2d_jobs" == "y" ]; then
            add_c2d_configuration
        else
            echo "Skipping C2D configuration"
        fi
    fi
}

add_c2d_configuration() {
    echo "########################################################"
    echo "### Docker Engine Compute Environments Configuration ###"
    echo "########################################################"
    echo "Check 'ComputeEnvironment' definition for more details on the format"
    echo "_____________________________________________________"
    echo ""
    
    local docker_environments="$DEFAULT_DOCKER_ENVIRONMENTS"
    read -p "Do you want to add a specific docker environment configuration? (Hint: You can enter multiple in JSON format) [ y/n ]: " c2d_env
    
    if [ "$c2d_env" == "y" ]; then
        read -p "Enter the array of docker environment(s): " user_input
        if [ ! -z "$user_input" ]; then
            docker_environments="$user_input"
        fi
    else
        echo "Setting default DOCKER_COMPUTE_ENVIRONMENTS configuration"
    fi

    update_docker_compose "$docker_environments"
}

update_docker_compose() {
    local docker_environments="$1"
    sed -i '/environment:/,/^[^ ]/ {
        /^[^ ]/i\      DOCKER_COMPUTE_ENVIRONMENTS: '"'$docker_environments'"'
    }' docker-compose.yml

    if ! grep -q "/var/run/docker.sock:/var/run/docker.sock" docker-compose.yml; then
        sed -i '/restart: on-failure/a\    volumes:\n      - /var/run/docker.sock:/var/run/docker.sock' docker-compose.yml
    fi
    
    echo "Added C2D configuration and Docker socket mount to docker-compose.yml"    
}

show_completion_message() {
    echo -e "\n\e[1;32mUpdate completed successfully!\e[0m"
    echo "Your docker-compose.yml has been updated with new configurations"
    echo -e "To apply the changes, run: \e[1;32mdocker-compose up -d\e[0m"
}

main() {
    check_prerequisites
    configure_c2d
}

main