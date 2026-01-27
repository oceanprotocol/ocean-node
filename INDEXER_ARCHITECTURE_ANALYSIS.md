# Ocean Node Indexer - Architecture Analysis & Refactoring Proposal

**Date:** January 14, 2026  
**Purpose:** Architecture review and refactoring direction for the Ocean Node Indexer component

---

## 1. CURRENT ARCHITECTURE OVERVIEW

### 1.1 High-Level Components

The Indexer system consists of the following main components:

```
OceanIndexer (Main Coordinator)
    ├── Worker Threads (crawlerThread.ts) - One per supported chain
    │   ├── Block Crawler
    │   ├── Event Retrieval
    │   └── Reindex Queue Manager
    ├── Processor (processor.ts) - Event processing orchestrator
    │   └── Event Processors (processors/*.ts) - Specific event handlers
    └── Database Layer
        ├── Indexer State (last indexed block per chain)
        ├── DDO Storage (asset metadata)
        ├── Order Storage
        └── State Tracking (ddoState)
```

### 1.2 Component Responsibilities

#### **OceanIndexer** (`index.ts`)

- Main coordinator class
- Manages worker threads (one per blockchain network)
- Handles job queue for admin commands (reindex operations)
- Event emitter for DDO and crawling events
- Version management and reindexing triggers

#### **CrawlerThread** (`crawlerThread.ts`)

- Runs in separate Worker Thread per chain
- Infinite loop polling blockchain for new blocks
- Retrieves logs/events from block ranges
- Manages reindex queue (per transaction)
- Updates last indexed block in database

#### **Processor** (`processor.ts`)

- Orchestrates event processing
- Routes events to specific processors
- Handles validator checks (metadata validators, access lists)
- Manages event filtering

#### **Event Processors** (`processors/*.ts`)

- Specific handlers for each event type:
  - MetadataEventProcessor (METADATA_CREATED, METADATA_UPDATED)
  - MetadataStateEventProcessor (METADATA_STATE)
  - OrderStartedEventProcessor
  - OrderReusedEventProcessor
  - Dispenser processors (Created, Activated, Deactivated)
  - Exchange processors (Created, Activated, Deactivated, RateChanged)

---

## 2. HOW BLOCK PARSING WORKS

### 2.1 Block Crawling Flow

```
┌─────────────────────────────────────────────────────────────┐
│ 1. INITIALIZATION (per chain)                               │
│    - Get deployment block from contract addresses           │
│    - Get last indexed block from database                   │
│    - Start block = max(deploymentBlock, lastIndexedBlock)   │
└─────────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────────┐
│ 2. MAIN LOOP (infinite while true)                          │
│    - Get current network height                             │
│    - Calculate blocks to process (min of chunkSize and      │
│      remaining blocks)                                       │
│    - If networkHeight > startBlock: process chunk           │
│    - Else: sleep for interval (default 30s)                 │
└─────────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────────┐
│ 3. EVENT RETRIEVAL (retrieveChunkEvents)                    │
│    - provider.getLogs({                                      │
│        fromBlock: lastIndexedBlock + 1,                      │
│        toBlock: lastIndexedBlock + chunkSize,                │
│        topics: [EVENT_HASHES]  // All supported events       │
│      })                                                      │
│    - Returns array of Log objects                            │
└─────────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────────┐
│ 4. PROCESS BLOCKS (processBlocks)                           │
│    - Call processChunkLogs(logs, signer, provider, chainId) │
│    - Update last indexed block in database                  │
│    - Emit events for newly indexed assets                   │
└─────────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────────┐
│ 5. ADAPTIVE CHUNK SIZING                                    │
│    - On error: chunkSize = floor(chunkSize / 2)            │
│    - After 3 successful calls: revert to original chunkSize │
│    - Minimum chunkSize = 1                                  │
└─────────────────────────────────────────────────────────────┘
```

### 2.2 Key Implementation Details

**Location:** `crawlerThread.ts` - `processNetworkData()`

```typescript
// Main crawling loop characteristics:
- Infinite loop with lockProccessing flag
- Dynamic chunk sizing (adaptive to RPC failures)
- Retry mechanism with configurable interval
- Reindex queue processing after each chunk
- One-shot CRAWLING_STARTED event emission
```

**Event Retrieval:** `utils.ts` - `retrieveChunkEvents()`

- Uses ethers `provider.getLogs()` with topic filters
- Filters by all known Ocean Protocol event hashes
- Single RPC call per chunk
- Throws error on failure (caught by crawler for retry)

---

## 3. HOW EVENT STORAGE WORKS

### 3.1 Event Processing Pipeline

```
Raw Log (ethers.Log)
    ↓
┌──────────────────────────────────────┐
│ 1. EVENT IDENTIFICATION              │
│    - Match log.topics[0] with        │
│      EVENT_HASHES lookup table       │
│    - Route to appropriate processor  │
└──────────────────────────────────────┘
    ↓
┌──────────────────────────────────────┐
│ 2. VALIDATION LAYER                  │
│    - Check if NFT deployed by        │
│      Ocean Factory                    │
│    - Validate metadata proofs        │
│    - Check allowedValidators list    │
│    - Check access list memberships   │
│    - Check authorized publishers     │
└──────────────────────────────────────┘
    ↓
┌──────────────────────────────────────┐
│ 3. EVENT-SPECIFIC PROCESSING         │
│    - Decode event data from receipt  │
│    - For Metadata events:             │
│      • Decrypt/decompress DDO        │
│      • Validate DDO hash             │
│      • Check purgatory status        │
│      • Fetch pricing info            │
│      • Check policy server           │
│    - For Order events:                │
│      • Update order count stats      │
│      • Create order record           │
│    - For Pricing events:              │
│      • Update pricing arrays         │
└──────────────────────────────────────┘
    ↓
┌──────────────────────────────────────┐
│ 4. DATABASE PERSISTENCE              │
│    - DDO Database (Elasticsearch/    │
│      Typesense)                       │
│    - DDO State (validation tracking) │
│    - Order Database                   │
│    - Indexer State (last block)      │
└──────────────────────────────────────┘
```

### 3.2 Storage Schemas

**Indexer State:**

```typescript
{
  id: chainId (string),
  lastIndexedBlock: number
}
```

**DDO Storage:**

- Full DDO document stored (as per Ocean Protocol DDO spec)
- Enhanced with `indexedMetadata`:
  ```typescript
  {
    nft: { state, address, name, symbol, owner, created, tokenURI },
    event: { txid, from, contract, block, datetime },
    stats: [{
      datatokenAddress, name, symbol, serviceId,
      orders: number,
      prices: [{ type, price, contract, token, exchangeId? }]
    }],
    purgatory: { state: boolean }
  }
  ```

**DDO State Tracking:**

```typescript
{
  chainId: number,
  did: string,
  nft: string,
  txId: string,
  valid: boolean,
  error: string  // if validation failed
}
```

**Order Storage:**

```typescript
{
  type: 'startOrder' | 'reuseOrder',
  timestamp: Date,
  consumer: address,
  payer: address,
  datatokenAddress: address,
  nftAddress: address,
  did: string,
  startOrderId: string
}
```

---

## 4. PAIN POINTS & ISSUES

### 4.1 Architecture Complexity

**Issue:** Mixed concerns and tight coupling

- `crawlerThread.ts` handles:
  - Block crawling logic
  - Network communication
  - Database updates
  - Message passing
  - Reindex queue management
  - Error handling and retry logic

**Impact:** Hard to test, debug, and modify individual components

---

### 4.2 Worker Thread Architecture

**Issue:** Complex inter-thread communication

- Parent-child message passing using `parentPort.postMessage()`
- Shared state management through message queues
- Two separate queues: `INDEXING_QUEUE` (parent) and `REINDEX_QUEUE` (worker)
- Race conditions possible with `lockProccessing` flag

**Code smell:**

```typescript
// In crawlerThread.ts
parentPort.on('message', (message) => {
  if (message.method === INDEXER_MESSAGES.START_CRAWLING) { ... }
  else if (message.method === INDEXER_MESSAGES.REINDEX_TX) { ... }
  else if (message.method === INDEXER_MESSAGES.REINDEX_CHAIN) { ... }
  else if (message.method === INDEXER_MESSAGES.STOP_CRAWLING) { ... }
})
```

**Impact:**

- Hard to reason about state
- Difficult to add new features
- Testing requires mocking Worker Threads

---

### 4.3 Error Handling & Recovery

**Issue:** Multiple retry mechanisms at different levels

1. Crawler level: `retryCrawlerWithDelay()` with max 10 retries
2. Chunk retrieval: adaptive chunk sizing on error
3. Block processing: sleep and retry on error
4. Individual RPC calls: `withRetrial()` helper with 5 retries

**Problems:**

- No centralized error tracking
- Unclear recovery state after multiple failures
- Potential for infinite loops or deadlocks
- No circuit breaker pattern

---

### 4.4 Event Processing Complexity

**Issue:** Monolithic `processChunkLogs()` function

- 180+ lines in single function
- Nested validation logic for metadata events
- Multiple external contract calls during validation
- Synchronous processing (one event at a time)

**Code complexity example:**

```typescript
// From processor.ts lines 79-162
if (event.type === EVENTS.METADATA_CREATED || ...) {
  if (checkMetadataValidated) {
    const txReceipt = await provider.getTransactionReceipt(...)
    const metadataProofs = fetchEventFromTransaction(...)
    if (!metadataProofs) { continue }

    const validators = metadataProofs.map(...)
    const allowed = allowedValidators.filter(...)
    if (!allowed.length) { continue }

    if (allowedValidatorsList && validators.length > 0) {
      isAllowed = false
      for (const accessListAddress of allowedValidatorsList[chain]) {
        const accessListContract = new ethers.Contract(...)
        for (const metaproofValidator of validators) {
          const balance = await accessListContract.balanceOf(...)
          // ... more nested logic
        }
      }
      if (!isAllowed) { continue }
    }
  }
}
```

**Impact:**

- Hard to read and maintain
- Performance bottleneck (serial processing)
- Difficult to add new validation rules
- Error in one validation affects all events

---

### 4.5 Metadata Decryption Complexity

**Issue:** `decryptDDO()` method in BaseProcessor (400+ lines)

- Handles HTTP, P2P, and local decryption
- Complex nonce management
- Signature verification inline
- Multiple error paths
- Retry logic embedded

**Impact:**

- Single Responsibility Principle violated
- Hard to test different decryption strategies
- Error messages unclear about failure point

---

### 4.6 Database Abstraction Issues

**Issue:** Direct database calls throughout processors

```typescript
const { ddo: ddoDatabase, ddoState, order: orderDatabase } = await getDatabase()
```

**Problems:**

- Tight coupling to database implementation
- Transaction management unclear
- No batch operations
- No caching strategy
- Multiple database calls per event

---

### 4.7 State Management

**Issue:** Global mutable state

```typescript
// In index.ts
let INDEXING_QUEUE: ReindexTask[] = []
const JOBS_QUEUE: JobStatus[] = []
const runningThreads: Map<number, boolean> = new Map()

// In crawlerThread.ts
let REINDEX_BLOCK: number = null
const REINDEX_QUEUE: ReindexTask[] = []
let stoppedCrawling: boolean = false
let startedCrawling: boolean = false
```

**Impact:**

- Hard to test
- Race conditions
- Unclear ownership
- Memory leaks potential

---

### 4.8 Lack of Observability

**Issue:** Limited monitoring and metrics

- No performance metrics (events/sec, blocks/sec)
- No latency tracking
- No failure rate monitoring
- Logger used but no structured metrics
- Hard to debug production issues

---

### 4.9 Testing Challenges

**Issue:** Integration test heavy, unit tests sparse

- Worker threads hard to unit test
- Database dependencies in all tests
- Long-running integration tests
- No mocking strategy for blockchain

---

### 4.10 Configuration & Deployment

**Issue:** Environment-dependent behavior

- RPC URLs in environment variables
- Chunk sizes configurable but defaults unclear
- Interval timing hardcoded in multiple places
- No configuration validation

---

## 5. REFACTORING PROPOSAL - HIGH-LEVEL ARCHITECTURE

### 5.1 Design Principles

1. **Separation of Concerns**: Each component has one clear responsibility
2. **Dependency Inversion**: Depend on abstractions, not implementations
3. **Testability**: Every component unit testable in isolation
4. **Observability**: Built-in metrics and monitoring
5. **Resilience**: Explicit error handling with circuit breakers
6. **Maintainability**: Clear code structure, documented patterns

---

### 5.2 Proposed Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        IndexerOrchestrator                       │
│  - Coordinates all indexing operations                          │
│  - Manages lifecycle of chain indexers                          │
│  - Handles configuration and health checks                       │
└─────────────────────────────────────────────────────────────────┘
                              │
        ┌─────────────────────┼─────────────────────┐
        ↓                     ↓                     ↓
┌──────────────┐      ┌──────────────┐     ┌──────────────┐
│ChainIndexer 1│      │ChainIndexer 2│     │ChainIndexer N│
│  (per chain) │      │  (per chain) │ ... │  (per chain) │
└──────────────┘      └──────────────┘     └──────────────┘
        │
        ├──> BlockScanner (fetches block ranges)
        │         │
        │         └──> RPC Client (with retry & fallback)
        │
        ├──> EventExtractor (filters & decodes events)
        │
        ├──> ValidationPipeline
        │         ├──> FactoryValidator
        │         ├──> MetadataValidator
        │         ├──> PublisherValidator
        │         └──> PolicyValidator
        │
        ├──> EventProcessor
        │         ├──> MetadataProcessor
        │         ├──> OrderProcessor
        │         └──> PricingProcessor
        │
        └──> StateManager
                  ├──> ProgressTracker (last indexed block)
                  ├──> EventStore (processed events)
                  └──> ReindexQueue
```

---

### 5.3 Component Details

#### **5.3.1 IndexerOrchestrator**

**Responsibility:** Top-level coordinator

```typescript
class IndexerOrchestrator {
  private chainIndexers: Map<number, ChainIndexer>
  private config: IndexerConfig
  private eventBus: EventBus
  private metrics: MetricsCollector

  async start(): Promise<void>
  async stop(): Promise<void>
  async reindexChain(chainId: number, fromBlock?: number): Promise<void>
  async reindexTransaction(chainId: number, txHash: string): Promise<void>
  getStatus(): IndexerStatus
}
```

**Benefits:**

- Single entry point
- Clear lifecycle management
- Easy to add new chains
- Health check support

---

#### **5.3.2 ChainIndexer**

**Responsibility:** Manages indexing for a single blockchain

```typescript
class ChainIndexer {
  private chainId: number
  private scanner: BlockScanner
  private extractor: EventExtractor
  private pipeline: ValidationPipeline
  private processor: EventProcessor
  private stateManager: StateManager
  private running: boolean

  async start(): Promise<void>
  async stop(): Promise<void>
  async processBlockRange(from: number, to: number): Promise<ProcessingResult>
}
```

**Benefits:**

- Self-contained per chain
- No worker threads needed (use async/await)
- Easy to test
- Clear dependencies

---

#### **5.3.3 BlockScanner**

**Responsibility:** Fetch blocks and logs from RPC

```typescript
interface BlockScanner {
  getLatestBlock(): Promise<number>
  getLogs(fromBlock: number, toBlock: number, topics: string[]): Promise<Log[]>
}

class EthersBlockScanner implements BlockScanner {
  private rpcClient: ResilientRpcClient

  // Implementation with retry and fallback
}

class ResilientRpcClient {
  private providers: JsonRpcProvider[]
  private circuitBreaker: CircuitBreaker
  private metrics: MetricsCollector

  async execute<T>(fn: (provider: JsonRpcProvider) => Promise<T>): Promise<T>
}
```

**Benefits:**

- Encapsulates RPC communication
- Retry/fallback logic in one place
- Easy to mock for testing
- Circuit breaker prevents cascade failures

---

#### **5.3.4 EventExtractor**

**Responsibility:** Decode and categorize events

```typescript
class EventExtractor {
  private eventRegistry: EventRegistry

  extractEvents(logs: Log[]): CategorizedEvents
  decodeEvent(log: Log): DecodedEvent
}

interface CategorizedEvents {
  metadata: MetadataEvent[]
  orders: OrderEvent[]
  pricing: PricingEvent[]
  unknown: Log[]
}
```

**Benefits:**

- Single responsibility
- Stateless and pure
- Easy to test
- Clear input/output

---

#### **5.3.5 ValidationPipeline**

**Responsibility:** Chain of validators for events

```typescript
interface Validator {
  validate(event: DecodedEvent, context: ValidationContext): Promise<ValidationResult>
}

class ValidationPipeline {
  private validators: Validator[]

  async validate(event: DecodedEvent): Promise<ValidationResult>
  addValidator(validator: Validator): void
}

// Specific validators
class FactoryValidator implements Validator
class MetadataProofValidator implements Validator
class PublisherValidator implements Validator
class AccessListValidator implements Validator
class PolicyServerValidator implements Validator
```

**Benefits:**

- Chain of Responsibility pattern
- Each validator is independent
- Easy to add/remove validators
- Parallel validation possible
- Clear failure points

---

#### **5.3.6 EventProcessor**

**Responsibility:** Transform validated events into domain models

```typescript
interface EventHandler<T extends DecodedEvent> {
  handle(event: T): Promise<DomainEntity>
}

class EventProcessor {
  private handlers: Map<EventType, EventHandler>

  async process(event: DecodedEvent): Promise<DomainEntity>
}

// Specific handlers
class MetadataCreatedHandler implements EventHandler<MetadataEvent>
class OrderStartedHandler implements EventHandler<OrderEvent>
class DispenserActivatedHandler implements EventHandler<PricingEvent>
```

**Benefits:**

- Strategy pattern for different event types
- Stateless handlers
- Easy to test
- Clear transformations

---

#### **5.3.7 StateManager**

**Responsibility:** Manage persistence and state

```typescript
interface StateManager {
  getLastIndexedBlock(chainId: number): Promise<number>
  setLastIndexedBlock(chainId: number, block: number): Promise<void>

  saveDDO(ddo: DDO): Promise<void>
  saveOrder(order: Order): Promise<void>
  updatePricing(pricing: PricingUpdate): Promise<void>

  // Batch operations
  saveBatch(entities: DomainEntity[]): Promise<void>
}

class TransactionalStateManager implements StateManager {
  private ddoRepository: DDORepository
  private orderRepository: OrderRepository
  private progressRepository: ProgressRepository

  async transaction<T>(fn: (repos: Repositories) => Promise<T>): Promise<T>
}
```

**Benefits:**

- Repository pattern
- Transaction support
- Batch operations for performance
- Easy to swap implementations
- Mockable for tests

---

### 5.4 Data Flow Example

**Processing a Metadata Created Event:**

```
1. ChainIndexer.processBlockRange(1000, 1010)
   ↓
2. BlockScanner.getLogs(1000, 1010, [...topics])
   → Returns: [Log, Log, Log, ...]
   ↓
3. EventExtractor.extractEvents(logs)
   → Returns: CategorizedEvents { metadata: [event1], orders: [], ... }
   ↓
4. For each metadata event:
   ValidationPipeline.validate(event)
   ├─> FactoryValidator.validate()
   ├─> MetadataProofValidator.validate()
   ├─> PublisherValidator.validate()
   └─> PolicyServerValidator.validate()
   → Returns: ValidationResult { valid: true, ... }
   ↓
5. EventProcessor.process(event)
   → MetadataCreatedHandler.handle(event)
   ├─> Decrypt DDO
   ├─> Fetch pricing info
   └─> Build DDO entity
   → Returns: DDO
   ↓
6. StateManager.saveDDO(ddo)
   → Persisted to database
   ↓
7. EventBus.emit('ddo.created', ddo)
   → Notify listeners
```

---

## 6. MIGRATION STRATEGY

### 6.1 Phase 1: Foundation (Week 1-2)

**Goals:**

- Introduce new abstractions without breaking existing code
- Add comprehensive tests

**Tasks:**

1. Create `ResilientRpcClient` wrapper
2. Implement `BlockScanner` interface
3. Add metrics collection infrastructure
4. Write unit tests for new components

**Deliverables:**

- `ResilientRpcClient` with circuit breaker
- `BlockScanner` implementation
- Test coverage > 80%

---

### 6.2 Phase 2: Validation Extraction (Week 3-4)

**Goals:**

- Extract validation logic into pipeline
- Reduce complexity of processor.ts

**Tasks:**

1. Create `Validator` interface
2. Implement individual validators
3. Build `ValidationPipeline`
4. Refactor `processChunkLogs()` to use pipeline

**Deliverables:**

- 5+ validator implementations
- Validation pipeline with tests
- Reduced complexity in processor.ts

---

### 6.3 Phase 3: Event Processing (Week 5-6)

**Goals:**

- Separate event handling from validation
- Introduce domain models

**Tasks:**

1. Create `EventHandler` interface
2. Implement handlers for each event type
3. Introduce domain entities (separate from database models)
4. Refactor processors to use handlers

**Deliverables:**

- Event handler implementations
- Domain model layer
- Clearer separation of concerns

---

### 6.4 Phase 4: State Management (Week 7-8)

**Goals:**

- Decouple from database implementation
- Add transaction support

**Tasks:**

1. Create repository interfaces
2. Implement transactional state manager
3. Add batch operation support
4. Migrate database calls to repositories

**Deliverables:**

- Repository layer
- Transaction support
- Batch operations
- Performance improvements

---

### 6.5 Phase 5: Remove Worker Threads (Week 9-10)

**Goals:**

- Simplify architecture
- Remove inter-thread communication

**Tasks:**

1. Implement `ChainIndexer` class
2. Replace worker threads with async loops
3. Migrate message passing to direct method calls
4. Update job queue management

**Deliverables:**

- No worker threads
- Simplified code
- Better error handling
- Improved testability

---

### 6.6 Phase 6: Observability & Monitoring (Week 11-12)

**Goals:**

- Add comprehensive monitoring
- Improve debugging capabilities

**Tasks:**

1. Add structured logging
2. Implement metrics collection
3. Add health check endpoints
4. Create monitoring dashboards

**Deliverables:**

- Prometheus metrics
- Grafana dashboards
- Health check API
- Debug tooling

---

## 7. IMMEDIATE WINS (Quick Improvements)

These can be implemented independently before full refactoring:

### 7.1 Extract DDO Decryption Service

**Current:** 400+ line method in BaseProcessor  
**Proposed:** Separate `DdoDecryptionService` class

**Benefits:**

- Testable in isolation
- Reusable
- Clear interface

**Effort:** 1-2 days

---

### 7.2 Add Batch Database Operations

**Current:** One database call per event  
**Proposed:** Batch save operations

```typescript
// Instead of:
for (const event of events) {
  await database.save(event)
}

// Do:
await database.saveBatch(events)
```

**Benefits:**

- 10-50x performance improvement
- Reduced database load

**Effort:** 2-3 days

---

### 7.3 Extract Validation Logic

**Current:** Nested if statements in processChunkLogs  
**Proposed:** Separate validation functions

```typescript
class EventValidation {
  validateFactory(event): boolean
  validateMetadataProof(event): boolean
  validatePublisher(event): boolean
  validateAccessList(event): boolean
}
```

**Benefits:**

- Readable code
- Testable validations
- Reusable

**Effort:** 2-3 days

---

### 7.4 Add Circuit Breaker for RPC

**Current:** Simple retry logic  
**Proposed:** Circuit breaker pattern

**Benefits:**

- Prevent cascade failures
- Faster failure detection
- Better error messages

**Effort:** 1-2 days

---

### 7.5 Add Metrics Collection

**Current:** Only logs  
**Proposed:** Prometheus metrics

```typescript
metrics.indexer_blocks_processed_total.inc()
metrics.indexer_events_processed_total.inc({ type: 'metadata' })
metrics.indexer_processing_duration_seconds.observe(duration)
metrics.indexer_rpc_errors_total.inc({ provider: 'infura' })
```

**Benefits:**

- Production visibility
- Performance tracking
- Alerting capability

**Effort:** 2-3 days

---

## 8. TESTING STRATEGY

### 8.1 Unit Tests

**Target:** 80%+ coverage

**Focus areas:**

- Validators (each should be 100% covered)
- Event handlers (pure functions, easy to test)
- Extractors and decoders
- Utility functions

**Tools:**

- Mocha/Chai (already in use)
- Sinon for mocking
- Test fixtures for events

---

### 8.2 Integration Tests

**Target:** Critical paths covered

**Focus areas:**

- End-to-end event processing
- Database operations
- Reindex operations
- Multi-chain scenarios

**Tools:**

- Docker containers for databases
- Hardhat for blockchain mocking
- Test fixtures

---

### 8.3 Performance Tests

**Target:** Benchmarks established

**Metrics:**

- Events processed per second
- Memory usage over time
- RPC call latency
- Database query performance

**Tools:**

- k6 or Artillery
- Memory profiling
- Custom benchmarking scripts

---

## 9. ALTERNATIVES CONSIDERED

### 9.1 Keep Worker Threads

**Pros:**

- No need to refactor thread management
- True parallelism

**Cons:**

- Complex state management
- Hard to debug
- Testing challenges

**Decision:** Remove threads (async/await sufficient)

---

### 9.2 Event Sourcing

**Pros:**

- Complete audit trail
- Replay capability
- Temporal queries

**Cons:**

- Significant complexity increase
- Storage overhead
- Query performance concerns

**Decision:** Not recommended (too much complexity for benefits)

---

### 9.3 Message Queue (Kafka/RabbitMQ)

**Pros:**

- Decoupled components
- Built-in retry/DLQ
- Scalability

**Cons:**

- Additional infrastructure
- Operational complexity
- Overkill for current scale

**Decision:** Revisit when scaling beyond 10+ chains

---

### 9.4 GraphQL Subscriptions

**Pros:**

- Real-time updates to clients
- Flexible queries

**Cons:**

- Not needed for current use case
- Additional complexity

**Decision:** Out of scope for indexer refactor

---

## 10. SUCCESS METRICS

### 10.1 Code Quality

- **Cyclomatic Complexity:** Reduce from avg 15 to < 5
- **Lines per Function:** < 50 lines
- **Test Coverage:** > 80%
- **Type Safety:** 100% typed (no `any`)

### 10.2 Performance

- **Throughput:** 2x improvement in events/sec
- **Latency:** < 100ms per event
- **Memory:** Stable (no leaks)
- **RPC Calls:** Reduce by 30% (batch operations)

### 10.3 Reliability

- **Uptime:** > 99.9%
- **Failed Events:** < 0.1%
- **Recovery Time:** < 5 minutes after RPC failure
- **Reindex Success Rate:** > 99%

### 10.4 Maintainability

- **Onboarding Time:** < 2 days for new dev
- **Bug Fix Time:** Avg < 4 hours
- **Feature Addition Time:** Avg < 1 week
- **Production Incidents:** < 1 per month

---

## 11. RISKS & MITIGATION

### 11.1 Risk: Breaking Changes

**Mitigation:**

- Incremental refactoring (Strangler Fig pattern)
- Comprehensive test suite
- Feature flags for new code paths
- Parallel running (old + new) during transition

### 11.2 Risk: Performance Regression

**Mitigation:**

- Benchmark before refactoring
- Performance tests in CI
- Load testing before deployment
- Gradual rollout

### 11.3 Risk: Data Loss During Migration

**Mitigation:**

- Database backups before changes
- Reindex capability
- Validation checks
- Dry-run mode

### 11.4 Risk: Schedule Overrun

**Mitigation:**

- Phased approach with clear milestones
- Regular progress reviews
- Scope adjustment flexibility
- Priority on immediate wins

---

## 12. OPEN QUESTIONS FOR DISCUSSION

1. **Worker Threads:** Do we need true parallelism or is async/await sufficient?

2. **Database Choice:** Should we standardize on one (Elasticsearch vs Typesense) or keep both?

3. **Event Prioritization:** Should critical events (metadata) be prioritized over pricing events?

4. **Reindex Strategy:** Should reindexing be a separate service/process?

5. **Monitoring:** What metrics are most important for production monitoring?

6. **Backward Compatibility:** How long should we support old API/database schemas?

7. **Multi-Region:** Do we need to support indexer deployment in multiple regions?

8. **Event Replay:** Do we need ability to replay historical events?

---

## 13. CONCLUSION & NEXT STEPS

### Current State Summary

The Ocean Node Indexer is functional but suffers from:

- High complexity (worker threads, mixed concerns)
- Limited observability
- Difficult to test and maintain
- Performance bottlenecks (serial processing, many RPC calls)

### Proposed State

After refactoring:

- Clear component boundaries
- No worker threads (async/await)
- Comprehensive testing
- Built-in monitoring
- 2x performance improvement
- Easy to extend and maintain

### Recommended Next Steps

1. **This Meeting (Today):**

   - Review and discuss this document
   - Agree on high-level direction
   - Prioritize immediate wins vs full refactor
   - Assign owners for investigation tasks

2. **Next Week:**

   - Detailed design for Phase 1 components
   - Create ADRs (Architecture Decision Records)
   - Set up performance benchmarks
   - Begin implementation of immediate wins

3. **Ongoing:**
   - Weekly architecture sync
   - Code reviews focused on quality
   - Regular performance testing
   - Documentation updates

---

## APPENDIX A: Key Files Reference

```
src/components/Indexer/
├── index.ts                 - OceanIndexer main class (490 lines)
├── crawlerThread.ts        - Worker thread implementation (380 lines)
├── processor.ts            - Event processing orchestrator (207 lines)
├── utils.ts                - Utility functions (454 lines)
├── purgatory.ts           - Purgatory checking
├── version.ts             - Version management
└── processors/
    ├── BaseProcessor.ts              - Abstract base (442 lines)
    ├── MetadataEventProcessor.ts     - Metadata handling (403 lines)
    ├── MetadataStateEventProcessor.ts
    ├── OrderStartedEventProcessor.ts
    ├── OrderReusedEventProcessor.ts
    ├── DispenserActivatedEventProcessor.ts
    ├── DispenserCreatedEventProcessor.ts
    ├── DispenserDeactivatedEventProcessor.ts
    ├── ExchangeActivatedEventProcessor.ts
    ├── ExchangeCreatedEventProcessor.ts
    ├── ExchangeDeactivatedEventProcessor.ts
    └── ExchangeRateChangedEventProcessor.ts
```

---

## APPENDIX B: Glossary

- **DDO:** Decentralized Data Object - Ocean Protocol asset metadata
- **NFT:** Non-Fungible Token - ERC721 contract representing data asset
- **Datatoken:** ERC20 token for accessing data
- **Dispenser:** Contract for free datatoken distribution
- **FRE:** Fixed Rate Exchange - Contract for datatoken pricing
- **Purgatory:** Blocklist for banned assets/accounts
- **MetadataProof:** Validation signature from authorized validators

---

**Document Version:** 1.0  
**Last Updated:** January 14, 2026  
**Authors:** Architecture Team  
**Status:** Draft for Discussion
