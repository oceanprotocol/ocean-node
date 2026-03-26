#!/bin/sh
set -e

# Fix ownership of directories that may be mounted as volumes (owned by root).
# Runs as root, then drops to 'node' user via gosu.
chown -R node:node /usr/src/app/databases /usr/src/app/c2d_storage /usr/src/app/logs 2>/dev/null || true

exec gosu node dumb-init -- "$@"
