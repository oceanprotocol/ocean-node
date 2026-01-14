# Ocean Node - AI Coding Agent Instructions

## Project Overview

**Ocean Node** is a unified Node.js service that consolidates three core Ocean Protocol components:

- **Provider** (data access control & payment verification)
- **Aquarius** (metadata/DDO indexing and caching)
- **Subgraph** (blockchain event tracking)

Nodes communicate via HTTP API and libp2p P2P network, support multi-chain operations (Ethereum, Optimism, Polygon, etc.), and enable data asset discovery, compute-to-data (C2D), and transaction validation.

## Architecture Patterns

### Handler-Registry Command Pattern

All P2P and HTTP requests follow a handler-based architecture:

1. **Command arrives** (via P2P or HTTP) → request validated → handler resolved from `CoreHandlersRegistry`
2. **Handler execution**: Each extends `CommandHandler` or `AdminCommandHandler`, implements `validate()` and `handle()` methods
3. **Response returned**: Streams P2PCommandResponse (JSON or binary) to caller

**Key files**: [src/components/core/handler/coreHandlersRegistry.ts](src/components/core/handler/coreHandlersRegistry.ts), [src/components/core/handler/handler.ts](src/components/core/handler/handler.ts)

Example handler structure:

```typescript
export class FileInfoHandler extends CommandHandler {
  validate(command: FileInfoCommand): ValidateParams {
    return validateCommandParameters(command, ['fileIndex', 'documentId', 'serviceId'])
  }
  async handle(task: FileInfoCommand): Promise<P2PCommandResponse> {
    // Implementation
  }
}
```

**Protocol commands** defined in [src/utils/constants.ts](src/utils/constants.ts): `PROTOCOL_COMMANDS` object with 40+ commands (download, encrypt, compute operations, admin tasks, etc.)

### Database Abstraction Layer

Multiple database backends via `DatabaseFactory` pattern:

- **Elasticsearch**: DDO metadata, indexer state, orders (async)
- **Typesense**: Search-optimized metadata queries
- **SQLite**: Nonce tracking, config storage, c2d Database (local)

Access via singleton `Database` class: `db.ddo`, `db.indexer`, `db.order`, `db.c2d`, `db.nonce`, etc.

### OceanNode Singleton

Central coordinator managing all components. Initialize with configuration and optional database/P2P/Provider/Indexer instances. Accessed via `OceanNode.getInstance()`.

## Critical Workflows

### Adding a New Command Handler

1. Define command type in [src/@types/commands.ts](src/@types/commands.ts)
2. Create handler class extending `CommandHandler` in `src/components/core/handler/`
3. Register in `CoreHandlersRegistry` constructor: `this.registerCoreHandler(PROTOCOL_COMMANDS.MY_COMMAND, new MyHandler(node))`
4. Add to `SUPPORTED_PROTOCOL_COMMANDS` in [src/utils/constants.ts](src/utils/constants.ts)
5. Handlers receive `OceanNode` in constructor for accessing escrow, config, database, P2P network

### Building & Testing

- **Build**: `npm run build` → compiles TypeScript to `./dist/`
- **Tests**: `npm run test` runs unit + integration (requires Docker Compose for Typesense)
- **Dev**: Use `npm run build:tsc` in watch mode, or Node's `--experimental-specifier-resolution=node` for ESM imports

### Configuration

Environment-driven via `.env` or `CONFIG_PATH=/path/to/config.json`:

- **PRIVATE_KEY** (required): Node identity for P2P + crypto operations
- **DB_URL**: Elasticsearch/Typesense connection
- **RPCS**: JSON mapping network IDs to RPC endpoints
- **OPERATOR_SERVICE_URL**: C2D cluster URLs (array of strings)
- See [docs/env.md](docs/env.md) for 40+ environment variables

## Project-Specific Patterns & Conventions

### Module-Specific Loggers

Use module-specific loggers instead of `console.log`. Import from [src/utils/logging/common.ts](src/utils/logging/common.ts):

```typescript
import {
  CORE_LOGGER,
  INDEXER_LOGGER,
  P2P_LOGGER,
  PROVIDER_LOGGER
} from './utils/logging/common.js'
```

Prevents log message mixing; enables module-level filtering/transport config.

### Validation Pattern

Commands validate parameters before execution. Use `validateCommandParameters()` in handlers:

```typescript
validateCommandParameters(command, ['required', 'fields']) // throws ValidateParams response
```

### Rate Limiting & Request Tracking

`BaseHandler.checkRequestData()` tracks per-IP/peer-ID requests within time windows. Respect `MAX_REQ_PER_MINUTE` config.

### DDO/Asset Schema Validation

DDOs validated against SHACL schemas in [schemas/](schemas/) (v1, v3, v5, v7). Indexer enforces validation; check `ValidateDDOHandler` for signature verification.

### Error Response Format

All handlers return `P2PCommandResponse`: `{ httpStatus, body?, stream?, error? }`. Stream responses use Node.js Readable for large data (downloads, logs).

### TypeScript ES Module Configuration

- Target: ES2022
- Module resolution: Node
- Config: [tsconfig.json](tsconfig.json) includes source maps for debugging
- Run node with: `node --experimental-specifier-resolution=node dist/index.js`

## Key Files Quick Reference

| File                                                                                                       | Purpose                                                              |
| ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| [src/index.ts](src/index.ts)                                                                               | Entry point; Express app setup, component initialization             |
| [src/OceanNode.ts](src/OceanNode.ts)                                                                       | Singleton coordinator; escrow, auth, rate limiting                   |
| [src/components/core/handler/coreHandlersRegistry.ts](src/components/core/handler/coreHandlersRegistry.ts) | Command handler registry (40+ handlers)                              |
| [src/components/database/](src/components/database/)                                                       | Database abstraction & factory                                       |
| [src/components/P2P/](src/components/P2P/)                                                                 | libp2p networking, P2P command routing                               |
| [src/components/Indexer/](src/components/Indexer/)                                                         | Blockchain event crawling, DDO indexing                              |
| [src/components/Provider/](src/components/Provider/)                                                       | Payment validation, access control                                   |
| [src/utils/constants.ts](src/utils/constants.ts)                                                           | 40+ protocol commands, network IDs, environment variable definitions |
| [src/@types/](src/@types/)                                                                                 | Command & data type definitions                                      |
| [docs/Arhitecture.md](docs/Arhitecture.md)                                                                 | Detailed architecture (layers, components, modules)                  |

## Testing Approach

- **Unit tests**: [src/test/unit/](src/test/unit/) - handler validation, command parsing (no DB required)
- **Integration tests**: [src/test/integration/](src/test/integration/) - full stack with Docker Compose services
- **Performance tests**: [src/test/performance/](src/test/performance/) - k6 load/stress tests

Run specific suite: `npm run test:unit` | `npm run test:integration` | `npm run mocha "dist/test/unit/**/*.test.js"`

## P2P Communication (libp2p)

### Network Topology & Peer Discovery

- **Transport layers**: TCP, WebSockets, Circuit Relay (NAT traversal)
- **Peer discovery mechanisms**:
  - mDNS (local network discovery)
  - Kademlia DHT (global peer discovery)
  - Bootstrap nodes (static list from config)
- **Core protocols**: Identify (peer metadata), Ping, AutoNAT (public address detection), UPnP (port forwarding)

### Command Flow

1. P2P request arrives on protocol stream
2. `handleProtocolCommands()` in [src/components/P2P/handleProtocolCommands.ts](src/components/P2P/handleProtocolCommands.ts) parses incoming JSON command
3. Rate limiting checks per peer ID and IP address
4. Handler resolved from `CoreHandlersRegistry.getHandler(command.command)`
5. Response streamed back (JSON metadata + optional binary payload for large data)
6. Stream automatically closed by libp2p after transmission

### Rate Limiting

P2P enforces two-tier rate limiting:

- **Per-peer limits**: `MAX_REQ_PER_MINUTE` (default 30) per peer ID
- **Global limits**: `MAX_CONNECTIONS_PER_MINUTE` (default 120) across all peers
- **Deny list**: `RATE_DENY_LIST` can block specific peer IDs or IP addresses

### Key Files

- [src/components/P2P/index.ts](src/components/P2P/index.ts) - libp2p initialization, topology
- [src/components/P2P/handleProtocolCommands.ts](src/components/P2P/handleProtocolCommands.ts) - command routing & rate limiting

## HTTP API

### Request Flow

1. Express route receives HTTP request (JSON or multipart)
2. Route handler maps to corresponding handler class
3. Handler executes same command logic as P2P
4. Response serialized as JSON or streamed binary data

### API Route Categories

- **Provider routes** (`/api/services/`): decrypt, encrypt, download, initialize, nonce - data access & payment
- **Aquarius routes** (`/api/aquarius/`): DDO retrieval, metadata querying, validation, state tracking
- **Compute routes** (`/api/services/compute`): start/stop jobs, get environments, fetch results/logs
- **P2P routes** (`/p2pRoutes`): get peer list, network stats
- **Admin routes** (`/admin/`): fetch/push config, reindex, stop node (requires ALLOWED_ADMINS)
- **Direct command route** (`/directCommand`): low-level handler invocation with raw command objects

### Key Pattern: Handler Reuse

HTTP routes instantiate handlers directly instead of going through P2P:

```typescript
const response = await new ComputeGetEnvironmentsHandler(req.oceanNode).handle(task)
```

This ensures **identical business logic** between P2P and HTTP endpoints.

### Streaming Large Data

Binary responses (encrypted files, logs) use Node.js Readable streams to avoid loading into memory:

```typescript
if (response.stream) {
  res.setHeader('Content-Type', 'application/octet-stream')
  response.stream.pipe(res)
}
```

### Key Files

- [src/components/httpRoutes/index.ts](src/components/httpRoutes/index.ts) - route aggregation
- [src/components/httpRoutes/commands.ts](src/components/httpRoutes/commands.ts) - `/directCommand` handler
- [src/components/httpRoutes/compute.ts](src/components/httpRoutes/compute.ts) - compute endpoints
- [src/components/httpRoutes/validateCommands.ts](src/components/httpRoutes/validateCommands.ts) - request validation

## Compute-to-Data (C2D)

### Architecture

C2D enables running algorithms on datasets without downloading them. The node coordinates with C2D clusters:

1. **Multiple C2D engines**: Support different deployment types (Docker-based, Kubernetes)
2. **Job tracking**: `C2DDatabase` stores job metadata, status, results
3. **Payment validation**: Escrow holds funds until job completes
4. **Result retrieval**: Users can fetch results/logs after completion

### C2D Engine Types

- **Docker**: Local or remote Docker daemon (light-weight, suitable for edge nodes)
- **Kubernetes**: Full Ocean C2D infrastructure (production scaling)

### Workflow Steps

1. **Initialize compute** (`COMPUTE_INITIALIZE`) - validates payment credentials, reserves escrow
2. **Start compute** (`COMPUTE_START` or `FREE_COMPUTE_START`) - submits job to C2D engine
3. **Get status** (`COMPUTE_GET_STATUS`) - polls job progress
4. **Fetch results** (`COMPUTE_GET_RESULT`) - retrieves algorithm output
5. **Stream logs** (`COMPUTE_GET_STREAMABLE_LOGS`) - live job log access
6. **Stop compute** (`COMPUTE_STOP`) - cancels running job, releases escrow (if applicable)

### Configuration

C2D clusters configured via `OPERATOR_SERVICE_URL`:

```json
{
  "c2dClusters": [
    {
      "type": "docker",
      "url": "http://localhost:8050",
      "node": "local-docker-node"
    }
  ]
}
```

### Key Files

- [src/components/c2d/compute_engines.ts](src/components/c2d/compute_engines.ts) - engine coordination
- [src/components/c2d/compute_engine_base.ts](src/components/c2d/compute_engine_base.ts) - base class interface
- [src/components/c2d/compute_engine_docker.ts](src/components/c2d/compute_engine_docker.ts) - Docker implementation
- [src/components/core/compute/](src/components/core/compute/) - compute handlers
- [src/components/database/C2DDatabase.ts](src/components/database/C2DDatabase.ts) - job persistence

## Common Tasks

| Task                  | Command                                                         |
| --------------------- | --------------------------------------------------------------- |
| Check code quality    | `npm run lint`                                                  |
| Format code           | `npm run format`                                                |
| Type check only       | `npm run type-check`                                            |
| Start node locally    | `npm run start` (requires `.env` setup)                         |
| Quick start in Docker | `npm run quickstart` or `bash scripts/ocean-node-quickstart.sh` |
| View logs             | `./scripts/logs.sh` or `npm run logs`                           |

---

**When adding features or fixing bugs**: Verify the handler pattern/architecture applies, use module-specific loggers, follow rate-limit conventions, and ensure integration tests cover new command flows.
