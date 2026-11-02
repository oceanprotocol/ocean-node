#!/bin/bash

DEFAULT_DOCKER_ENVIRONMENTS='[{"socketPath":"/var/run/docker.sock","resources":[{"id":"disk","total":10}],"storageExpiry":604800,"maxJobDuration":36000,"minJobDuration":60,"fees":{"1":[{"feeToken":"0x123","prices":[{"id":"cpu","price":1}]}]},"free":{"maxJobDuration":360000,"minJobDuration":60,"maxJobs":3,"resources":[{"id":"cpu","max":1},{"id":"ram","max":1},{"id":"disk","max":1}]}}]'

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

# Persist the node's log files on the host (./logs), so they survive container recreation.
# Runs on every update, independently of the C2D step.
add_logs_mount() {
    if grep -q "./logs:/usr/src/app/logs" docker-compose.yml; then
        echo "Logs mount already present in docker-compose.yml"
        return
    fi
    local tmp
    tmp=$(mktemp) || return 1
    # POSIX awk (works with GNU and BSD): add the mount to the ocean-node service's volumes,
    # creating the volumes key if the service has none. Comment and blank lines never end the
    # service (the quickstart writes "#      KEY: ''" lines inside environment), they are held
    # back and printed after whatever comes next, so a new volumes block lands before them
    awk '
        function add_block() { print "    volumes:"; print "      - ./logs:/usr/src/app/logs"; done = 1 }
        function flush() { printf "%s", held; held = "" }
        /^  ocean-node:/ { in_node = 1; print; next }
        in_node && (/^[ \t]*#/ || /^[ \t]*$/) { held = held $0 "\n"; next }
        in_node && (/^[^ ]/ || /^  [^ ]/) { if (!done) add_block(); in_node = 0 }
        in_node && /^    volumes:/ && !done { flush(); print; print "      - ./logs:/usr/src/app/logs"; done = 1; next }
        { flush(); print }
        END { if (in_node && !done) add_block(); flush() }
    ' docker-compose.yml > "$tmp" && cat "$tmp" > docker-compose.yml
    rm -f "$tmp"
    if grep -q "./logs:/usr/src/app/logs" docker-compose.yml; then
        mkdir -p logs
        echo "Added logs mount (./logs:/usr/src/app/logs) to docker-compose.yml"
    else
        echo "Could not add the logs mount automatically; add '- ./logs:/usr/src/app/logs' under the ocean-node volumes"
    fi
}

show_completion_message() {
    echo -e "\n\e[1;32mUpdate completed successfully!\e[0m"
    echo "Your docker-compose.yml has been updated with new configurations"
    echo -e "To apply the changes, run: \e[1;32mdocker-compose up -d\e[0m"
}

main() {
    check_prerequisites
    configure_c2d
    add_logs_mount
}

main