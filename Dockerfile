FROM node:26.12.1-trixie@sha256:eb37f58646a901dc7727cf448cae36daaefaba79de33b5058dab79aa4c04aefb AS builder
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    build-essential \
    libatomic1 \
    git \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /usr/src/app
COPY package*.json ./
COPY scripts/ ./scripts/
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev


FROM node:26.12.1-trixie@sha256:eb37f58646a901dc7727cf448cae36daaefaba79de33b5058dab79aa4c04aefb AS runner
RUN apt-get update && apt-get install -y --no-install-recommends \
    dumb-init \
    gosu \
    libatomic1 \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    IPFS_GATEWAY='https://ipfs.io/' \
    ARWEAVE_GATEWAY='https://arweave.net/' \
    P2P_ipV4BindTcpPort=9000 \
    P2P_ipV4BindWsPort=9001 \
    P2P_ipV6BindTcpPort=9002 \
    P2P_ipV6BindWsPort=9003 \
    P2P_ipV4BindWssPort=9005 \
    HTTP_API_PORT=8000

EXPOSE 9000 9001 9002 9003 9005 8000

# Docker group membership is handled at runtime in docker-entrypoint.sh by
# inspecting the GID of /var/run/docker.sock, so it works across hosts.

WORKDIR /usr/src/app

COPY --chown=node:node --from=builder /usr/src/app/dist ./dist
COPY --chown=node:node --from=builder /usr/src/app/node_modules ./node_modules
COPY --chown=node:node --from=builder /usr/src/app/schemas ./schemas
# sitecustomize.py the node copies into service containers (src/components/c2d/serviceHfMirror.ts)
COPY --chown=node:node --from=builder /usr/src/app/hfpatch ./hfpatch
COPY --chown=node:node --from=builder /usr/src/app/package.json ./
COPY --chown=node:node --from=builder /usr/src/app/config.json ./

# `databases` holds everything the node must not lose across a restart: the SQLite files
# (nonce, config, C2D jobs, auth tokens) and `databases/p2p-store`, the LevelDatastore that
# backs libp2p. kad-dht's reprovider refreshes this node's provider records from that
# datastore, so if it starts empty the node stops answering for content it still holds, and the
# records expire out of the network without anything noticing. The directory is created and
# handed to the unprivileged `node` user here, and VOLUME declares the mount point so a named
# volume or bind mount can be attached; docker-entrypoint.sh re-applies ownership at runtime
# for the bind-mount case, where the host directory arrives owned by whoever created it.
# A persistent mount here is REQUIRED, not optional - see "Persistent node data" in
# docs/dockerDeployment.md.
RUN mkdir -p databases/p2p-store c2d_storage logs \
    && chown -R node:node databases c2d_storage logs
VOLUME ["/usr/src/app/databases"]

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "--import", "./dist/telemetry/otel.js", "--max-old-space-size=28784", "--trace-warnings", "--experimental-specifier-resolution=node", "dist/index.js"]
