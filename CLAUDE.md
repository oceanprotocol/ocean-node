# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Ocean Node is a unified Node.js service consolidating three core Ocean Protocol components:
- **Provider**: Data access control & payment verification
- **Aquarius**: Metadata/DDO indexing and caching
- **Subgraph**: Blockchain event tracking

Nodes communicate via HTTP API and libp2p P2P network, supporting multi-chain operations (Ethereum, Optimism, Polygon, etc.) for data asset discovery, compute-to-data (C2D), and transaction validation.

## Build & Development Commands

```bash
# Install dependencies and build
npm install
npm run build

# Run the node (requires PRIVATE_KEY in .env)
npm run start

# Lint and format
npm run lint              # ESLint + type-check
npm run lint:fix          # Auto-fix lint issues
npm run format            # Prettier formatting
npm run type-check        # TypeScript type checking only

# Testing
npm run test:unit         # Unit tests only
npm run test:integration  # Integration tests (requires Barge - see below)
npm run test:integration:light  # Integration tests without C2D

# Run specific test file
npm run build-tests && npm run mocha "./dist/test/unit/TESTFILE.test.js"

# Performance tests (requires k6 installed)
npm run test:smoke
npm run test:load
npm run test:stress
```

**Integration test setup**: Start [Barge](https://github.com/oceanprotocol/barge) in a separate terminal:
```bash
git clone https://github.com/oceanprotocol/barge.git && cd barge
git checkout feature/nodes
./start_ocean.sh -with-c2d
```

## Architecture

### Handler-Registry Command Pattern

All P2P and HTTP requests follow a handler-based architecture:

1. **Command arrives** (via P2P or HTTP) → validated → handler resolved from `CoreHandlersRegistry`
2. **Handler execution**: Extends `CommandHandler` (or `AdminCommandHandler`), implements `validate()` and `handle()` methods
3. **Response returned**: Streams `P2PCommandResponse` (JSON or binary)

**Key files**:
- `src/components/core/handler/coreHandlersRegistry.ts` - Handler registry (40+ handlers)
- `src/components/core/handler/handler.ts` - Base handler classes
- `src/utils/constants.ts` - `PROTOCOL_COMMANDS` and `SUPPORTED_PROTOCOL_COMMANDS`

### Adding a New Command Handler

1. Define command type in `src/@types/commands.ts`
2. Create handler class in `src/components/core/handler/`:
   ```typescript
   export class MyHandler extends CommandHandler {
     validate(command: MyCommand): ValidateParams {
       return validateCommandParameters(command, ['required', 'fields'])
     }
     async handle(task: MyCommand): Promise<P2PCommandResponse> {
       // Implementation
     }
   }
   ```
3. Register in `CoreHandlersRegistry` constructor: `this.registerCoreHandler(PROTOCOL_COMMANDS.MY_COMMAND, new MyHandler(node))`
4. Add to `SUPPORTED_PROTOCOL_COMMANDS` in `src/utils/constants.ts`

### OceanNode Singleton

Central coordinator managing all components. Access via `OceanNode.getInstance()`. Provides access to:
- `getDatabase()` - Database connections
- `getP2PNode()` - libp2p networking
- `getIndexer()` - Blockchain event indexer
- `getProvider()` - Payment/access validation
- `getCoreHandlers()` - Handler registry
- `getC2DEngines()` - Compute-to-data engines

### Database Layer

Multiple backends via `DatabaseFactory`:
- **Elasticsearch/Typesense**: DDO metadata, indexer state, orders
- **SQLite**: Nonce tracking, config storage, C2D database

Access via `Database` instance: `db.ddo`, `db.indexer`, `db.order`, `db.c2d`, `db.nonce`

### Node Layers

1. **Network Layer**: libp2p (P2P) & Express (HTTP API)
2. **Components Layer**: Indexer, Provider
3. **Modules Layer**: MPC, TEE, Database, C2D engines

## Key Conventions

### Logging

Use module-specific loggers, never `console.log`:
```typescript
import { CORE_LOGGER, INDEXER_LOGGER, P2P_LOGGER, PROVIDER_LOGGER } from './utils/logging/common.js'
```

### Validation Pattern

Commands validate parameters before execution using `validateCommandParameters()`:
```typescript
validateCommandParameters(command, ['required', 'fields']) // returns ValidateParams
```

### Response Format

All handlers return `P2PCommandResponse`: `{ httpStatus, body?, stream?, error? }`. Stream responses use Node.js Readable for large data.

### TypeScript/ESM Configuration

- Target: ES2022, Module resolution: Node
- Run node with: `node --experimental-specifier-resolution=node dist/index.js`
- Node version: 22 (see `.nvmrc`)

## Configuration

Environment-driven via `.env` or `CONFIG_PATH=/path/to/config.json`:
- **PRIVATE_KEY** (required): Node identity for P2P + crypto operations (include `0x` prefix)
- **DB_URL**: Elasticsearch/Typesense connection
- **RPCS**: JSON mapping network IDs to RPC endpoints
- **OPERATOR_SERVICE_URL**: C2D cluster URLs

See `docs/env.md` for all environment variables.

## Key Files Reference

| File | Purpose |
|------|---------|
| `src/index.ts` | Entry point; Express app setup, component initialization |
| `src/OceanNode.ts` | Singleton coordinator; escrow, auth, rate limiting |
| `src/components/core/handler/coreHandlersRegistry.ts` | Command handler registry |
| `src/components/database/` | Database abstraction & factory |
| `src/components/P2P/` | libp2p networking, P2P command routing |
| `src/components/Indexer/` | Blockchain event crawling, DDO indexing |
| `src/components/Provider/` | Payment validation, access control |
| `src/components/c2d/` | Compute-to-data engines (Docker, Kubernetes) |
| `src/utils/constants.ts` | Protocol commands, environment variable definitions |
| `src/@types/` | Command & data type definitions |

## Testing Conventions

- **Unit tests**: `src/test/unit/` - handler validation, command parsing (no DB required)
- **Integration tests**: `src/test/integration/` - full stack with Docker Compose services
- Use `setupEnvironment()` / `tearDownEnvironment()` in test hooks to preserve env between tests
- Avoid overriding `process.env` directly in tests
