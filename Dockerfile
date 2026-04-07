FROM node:22.15.0-bookworm@sha256:a1f1274dadd49738bcd4cf552af43354bb781a7e9e3bc984cfeedc55aba2ddd8 AS builder
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


FROM node:22.15.0-bookworm-slim@sha256:557e52a0fcb928ee113df7e1fb5d4f60c1341dbda53f55e3d815ca10807efdce AS runner
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
COPY --chown=node:node --from=builder /usr/src/app/package.json ./
COPY --chown=node:node --from=builder /usr/src/app/config.json ./

RUN mkdir -p databases c2d_storage logs

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "--max-old-space-size=28784", "--trace-warnings", "--experimental-specifier-resolution=node", "dist/index.js"]
