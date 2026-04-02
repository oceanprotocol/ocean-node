#!/bin/sh
set -e

# Fix ownership of directories that may be mounted as volumes (owned by root).
# Runs as root, then drops to 'node' user via gosu.
chown -R node:node /usr/src/app/databases /usr/src/app/c2d_storage /usr/src/app/logs 2>/dev/null || true

# Add node user to the docker group matching the host's /var/run/docker.sock GID,
# so compute jobs can access the socket regardless of the host's docker GID.
if [ -S /var/run/docker.sock ]; then
    SOCK_GID=$(stat -c '%g' /var/run/docker.sock)
    if ! getent group "$SOCK_GID" > /dev/null 2>&1; then
        groupadd -g "$SOCK_GID" dockerhost 2>/dev/null || true
    fi
    DOCKER_GROUP=$(getent group "$SOCK_GID" | cut -d: -f1)
    usermod -aG "$DOCKER_GROUP" node
fi

exec gosu node dumb-init -- "$@"
