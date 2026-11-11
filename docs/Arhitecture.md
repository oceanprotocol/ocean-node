# ![](https://img.shields.io/badge/status-living%20doc-blue.svg?style=flat-square) Ocean Node Architecture Overview

**Author(s)**:
- [Alex Coseru](https://github.com/alexcos20)

**Maintainer(s)**:
- Ocean Protocol core team

* * *

**Abstract**

This document describes the Ocean Node architecture: its layers, components, modules,
and how a request flows through the system. Ocean Node is the all-in-one backend for the
Ocean Protocol stack — a single process that replaces three legacy components:
**Provider** (data access / encryption / compute), **Aquarius** (metadata cache), and the
**subgraph** (on-chain event indexing).

This is not an introduction to Ocean Protocol concepts. For that, start with the
[Ocean docs](https://docs.oceanprotocol.com/). The text below assumes familiarity with
Ocean terminology (DDOs, data NFTs, datatokens, C2D, fees).

> **Note on the filename.** The file is intentionally named `Arhitecture.md` for backward
> compatibility with existing links; the content uses the correct spelling throughout.

# Table of Contents
- [1. Architecture Overview](#1-architecture-overview)
- [2. Request & Command Flow](#2-request--command-flow)
- [3. Components](#3-components)
- [4. Nodes & Network Model](#4-nodes--network-model)
- [5. Compute-to-Data (C2D)](#5-compute-to-data-c2d)
- [6. Related Documentation](#6-related-documentation)

---

# 1. Architecture Overview

The node stack is divided into three layers:

- **Network layer** — the two front doors: an Express **HTTP API** and a **libp2p** P2P
  interface. Both normalize an incoming request into a single `Command` object.
- **Components layer** — the long-lived services wired together by the `OceanNode`
  singleton: Indexer, Provider, C2D engines, Database, P2P, Auth, KeyManager,
  BlockchainRegistry, Escrow, PersistentStorage, PolicyServer.
- **Handlers (modules) layer** — the concrete command handlers under
  `src/components/core/` that execute the actual work.

The key architectural idea: **every capability is a command handler**, reachable
identically over HTTP `/directCommand`, over P2P, and (for most) via a dedicated REST route.

```mermaid
flowchart TB
    subgraph NET["Network layer — front doors"]
        HTTP["HTTP API (Express)<br/>POST /directCommand + REST routes"]
        P2P["libp2p<br/>Ocean protocol stream"]
    end

    subgraph DISPATCH["Dispatch"]
        ON["OceanNode singleton<br/>handleDirectProtocolCommand()"]
        REG["CoreHandlersRegistry<br/>command → handler"]
    end

    subgraph COMP["Components layer"]
        IDX["Indexer"]
        PROV["Provider"]
        C2D["C2D engines"]
        DB["Database"]
        AUTH["Auth"]
        KM["KeyManager"]
        BR["BlockchainRegistry"]
        ESC["Escrow"]
        PS["PersistentStorage"]
        POL["PolicyServer"]
    end

    HTTP --> ON
    P2P --> ON
    ON --> REG
    REG --> IDX & PROV & C2D & AUTH & ESC & PS & POL
    PROV --> DB
    IDX --> DB
    C2D --> ESC
    ON --> KM
    ON --> BR
    classDef layer fill:#e8f0fe,stroke:#4066b0,color:#13284b;
    class NET,DISPATCH,COMP layer;
```

**Design features**

- Node identity is derived from a single `PRIVATE_KEY`: it seeds the libp2p peerId, the EVM
  signer, and the encryption keys ([libp2p supports ECDSA key pairs](https://github.com/libp2p/specs/blob/master/peer-ids/peer-ids.md#ecdsa)).
- Each component can be enabled/disabled at startup (e.g. run with `INTERFACES=["HTTP"]`
  only).
- C2D: only the Docker engine (`C2DEngineDocker`) is implemented. OPF_K8 clusters configured
  via `OPERATOR_SERVICE_URL` are accepted into the config (added to `c2dClusters`), but no
  engine is instantiated for them.
- URL/metadata protection: the node encrypts URLs on publish and only ever streams the file
  contents back to the consumer, never the URL itself. (The node operator is trusted: the
  node decrypts the URL and fetches the file server-side, so the operator can see it.)

---

# 2. Request & Command Flow

There are multiple front doors but one common primitive: every path resolves a handler from
the `CoreHandlersRegistry` and calls `handler.handle(task)`. The paths differ in how they get
there. HTTP `POST /directCommand` goes through `OceanNode.handleDirectProtocolCommand()`,
which JSON-parses the command, looks up the handler by `task.command`, and calls it. P2P
inbound (`handleProtocolCommands`) and the ergonomic REST routes (e.g. `compute.ts`) skip that
wrapper — they look up or instantiate the handler and call `handle(task)` directly. In every
case the handler first runs `verifyParamsAndRateLimits()` (shared rate limiting against
`OceanNode.requestMap`), then executes and streams the response back.

```mermaid
sequenceDiagram
    actor Client
    participant HTTP as HTTP API
    participant P2P as libp2p
    participant ON as OceanNode
    participant REG as CoreHandlersRegistry
    participant H as Command handler
    participant DB as Database / chain

    alt Local command (HTTP)
        Client->>HTTP: POST /directCommand { command, ... }
        HTTP->>ON: handleDirectProtocolCommand(msg)
    else Remote target peer
        Client->>HTTP: POST /directCommand { node: <peerId> }
        HTTP->>P2P: sendTo(peer, msg, multiAddrs)
        P2P->>ON: dispatch on remote node
    else P2P inbound
        Client->>P2P: Ocean protocol stream (length-prefixed frame)
        P2P->>REG: getHandler(task.command) (skips handleDirectProtocolCommand)
    end

    ON->>REG: getHandler(task.command)
    REG-->>ON: handler instance
    ON->>H: handle(task)
    H->>H: verifyParamsAndRateLimits(task): rate-limit + param checks
    H->>DB: read/write (DDO, orders, chain calls)
    DB-->>H: result
    H-->>Client: streamed response (binary or text)
```

**Forwarding.** Cross-node forwarding on a local miss is not general dispatch behaviour — it
is specific to the `findDDO` command. `FindDdoHandler` checks the local DB and, if the DDO is
missing and P2P is enabled, queries the network (`p2pNode.sendTo(...)`) and relays the answer
back. (Example: Alice asks Node A for DDO `#123` via `findDDO`; Node A checks its local DB,
and if missing, queries the network and returns the DDO from a peer that has it.) Other
commands, including `getDDO`, simply return a 404 on a local miss. Separately, `/directCommand`
can forward a whole command to a specific peer when the request names a target `node`.

**To add a new command:** add the name to `PROTOCOL_COMMANDS` + `SUPPORTED_PROTOCOL_COMMANDS`
(`src/utils/constants.ts`), create a handler under `src/components/core/`, register it in the
`CoreHandlersRegistry` constructor, add param validation, and optionally add a REST route in
`src/components/httpRoutes/`.

---

# 3. Components

```mermaid
flowchart LR
    ON["OceanNode<br/>(singleton)"]

    ON --> IDX["Indexer<br/>multi-chain event cache"]
    ON --> PROV["Provider<br/>data access / encrypt"]
    ON --> C2D["C2D engines<br/>Docker engine (OPF_K8 not implemented)"]
    ON --> ESC["Escrow<br/>payment settlement"]
    ON --> AUTH["Auth<br/>JWT tokens"]
    ON --> KM["KeyManager<br/>node key provider"]
    ON --> BR["BlockchainRegistry<br/>per-chain signers"]
    ON --> PS["PersistentStorage<br/>local filesystem (localfs)"]
    ON --> POL["PolicyServer<br/>external access policy"]
    ON --> P2P["OceanP2P<br/>libp2p node"]

    subgraph DBLAYER["Database"]
        META["Metadata indices<br/>Elasticsearch"]
        STATE["Node state indices<br/>Elasticsearch<br/>nonce · config · C2D jobs · auth tokens"]
    end
    ON --> DBLAYER
    IDX --> META
    PROV --> META
    C2D --> STATE
    AUTH --> STATE
```

### 3.1 Indexer
An off-chain, multi-chain metadata & chain-events cache (the V4 Aquarius + subgraph
equivalent). Single-threaded, non-blocking: one `ChainIndexer` per configured chain runs
concurrently on the event loop (**no worker threads**); event **processors** handle specific
events.

- Monitors `MetadataCreated` / `MetadataUpdated` / `MetadataState` and stores/validates DDOs
  against multiple SHACL schemas; provides proof for valid DDOs.
- Monitors datatoken contracts and stores orders (`OrderStarted` / `OrderReused`).
- Monitors Escrow events (Auth, Lock, ReLock, Claimed, Canceled, Deposit, Withdraw) and exchange /
  dispenser / access-list lifecycle events.
- Supports queries for all of the above, version-based + admin-triggered reindexing, and a
  purgatory. Communicates via module-level `EventEmitter`s.

### 3.2 Provider
Deliberately thin — the real behavior lives in the core handlers and REST routes. It:
- checks on-chain buyer permissions and payments;
- encrypts URLs/metadata on publish and decrypts on download or compute start;
- streams data to consumers and **never exposes the URL to the consumer** (the node operator,
  which decrypts and fetches it server-side, is trusted);
- connects to the C2D engines for compute services.

### 3.3 Database
**Elasticsearch** is the only database and is required (`DB_URL`, `DB_USERNAME`,
`DB_PASSWORD`). It holds DDOs, indexer state, logs, orders, ddoState, access lists and escrow
events, and the node state indices `nonce`, `node_config`, `auth_tokens`, `buckets`,
`node_metrics_samples`, `node_metrics_hourly`, `c2d_jobs`, `service_jobs`, `docker_images`
and `service_locks`. There is no mode that runs without it.

### 3.4 Supporting components
- **Auth** — JWT-based auth-token issuance/validation (`JWT_SECRET`) as an alternative to
  per-request signatures.
- **KeyManager** — provider abstraction over the node key (today `RawPrivateKeyProvider` from
  `PRIVATE_KEY`; designed to add KMS providers later).
- **BlockchainRegistry** — per-chain `Blockchain` instances giving handlers RPC
  providers/signers keyed by `chainId`.
- **Escrow** — on-chain settlement for paid compute and services (not orders/downloads).
- **PersistentStorage** — local filesystem (`localfs`) buckets for C2D outputs and user
  buckets, configured via `PERSISTENT_STORAGE` (the S3 backend is a stub).
- **PolicyServer** — passthrough integration to an external policy server (`POLICY_SERVER_URL`)
  for access decisions.

---

# 4. Nodes & Network Model

Nodes receive requests over HTTP or over libp2p from another node; both are merged into a
common `Command` object and routed to the right handler. For `findDDO`, a node queries peers
when the DDO is missing from its local database; `/directCommand` can also forward a command
to an explicitly targeted peer.

The libp2p implementation supports core protocols (ping, identify, kad-DHT for peering,
circuit-relay v2 for connectivity), peer discovery via both **mDNS** and **Kademlia DHT**,
plus AutoNAT, UPnP, dcutr, and auto-TLS. There is no pubsub/gossipsub topic: nodes talk to
each other over a custom request/response stream protocol (`/ocean/nodes/1.0.0`, registered
with `libp2p.handle`) dialed per peer, and locate DDOs through the Kademlia DHT. A LevelDB
datastore persists P2P state at `./databases/p2p-store`.

```mermaid
flowchart LR
    subgraph OceanNetwork["Ocean Nodes (libp2p /ocean/nodes/1.0.0)"]
        A["Node A"]
        B["Node B"]
        C["Node C"]
    end
    Alice(["Client / Alice"]) -->|"POST /directCommand (DDO #123)"| A
    A -->|"local DB miss → query network"| B
    B -->|"has DDO #123"| A
    A -->|"streamed DDO"| Alice
    A <-->|"kad-DHT · mDNS · circuit-relay"| C
    B <--> C
```

---

# 5. Compute-to-Data (C2D)

C2D runs algorithms next to the data without exposing the raw files. `C2DEngines` builds
engines from `config.c2dClusters`; the implemented engine is `C2DEngineDocker`, which
orchestrates jobs over the host Docker socket. Resource matching
(`serviceResourceMatching.ts`) maps requested cpu/ram/disk/gpu against environment pools
(dual gate: per-env ceiling + engine-wide pool; GPUs tracked globally). Paid compute settles
through the **Escrow** component; free compute (`freeStartCompute`) skips settlement.

```mermaid
sequenceDiagram
    actor Consumer
    participant Node as Ocean Node (C2D)
    participant Esc as Escrow
    participant Docker as Docker engine

    Consumer->>Node: initializeCompute (env, assets, resources)
    Node-->>Consumer: price + requirements
    alt Paid
        Consumer->>Node: startCompute (+ payment)
        Node->>Esc: lock funds
    else Free
        Consumer->>Node: freeStartCompute
    end
    Node->>Docker: provision volumes + run algorithm job
    loop Until finished
        Consumer->>Node: getComputeStatus
        Node-->>Consumer: status
        Consumer->>Node: getComputeStreamableLogs
    end
    Docker-->>Node: job finished → results
    Node->>Esc: settle / claim (paid)
    Consumer->>Node: getComputeResult
    Node-->>Consumer: streamed result
    opt
        Consumer->>Node: stopCompute
    end
```

See [compute.md](compute.md) for configuration (resources, GPUs, constraints, pricing) and
[services.md](services.md) for the related Service-on-Demand lifecycle.

---

# 6. Related Documentation

| Topic | Doc |
|---|---|
| HTTP API reference | [API.md](API.md) + the Postman collection |
| Environment variables (authoritative) | [env.md](env.md) |
| Compute-to-Data | [compute.md](compute.md) |
| Service-on-Demand | [services.md](services.md) |
| Databases | [database.md](database.md) |
| Persistent storage | [persistentStorage.md](persistentStorage.md) · [Storage.md](Storage.md) |
| Key management | [KeyManager.md](KeyManager.md) |
| Policy server | [PolicyServer.md](PolicyServer.md) |
| Networking / P2P | [networking.md](networking.md) |
| Observability | [telemetry.md](telemetry.md) · [Logs.md](Logs.md) |
| Publishing | [Publishing.md](Publishing.md) |
| Deployment | [dockerDeployment.md](dockerDeployment.md) |
| Testing | [testing.md](testing.md) |
