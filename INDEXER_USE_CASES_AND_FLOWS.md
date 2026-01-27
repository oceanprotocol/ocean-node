# Ocean Node Indexer - Event Monitoring & Error Handling

## Table of Contents

1. [Overview](#overview)
2. [🔴 PROPOSED IMPROVEMENTS (Post-Meeting Changes)](#-proposed-improvements-post-meeting-changes)
3. [Event Monitoring Architecture](#event-monitoring-architecture)
4. [Event Processing Pipeline](#event-processing-pipeline)
5. [Detailed Event Handling](#detailed-event-handling)
6. [Error Handling & Retry Mechanisms](#error-handling--retry-mechanisms)
7. [Failure Scenarios & Recovery](#failure-scenarios--recovery)

---

## 🔴 PROPOSED IMPROVEMENTS (Post-Meeting Changes)

> **Status:** Draft proposals from Jan 27, 2026 meeting  
> **Goal:** Improve reliability, decoupling, and error handling

### 1. 🎯 EVENT-LEVEL RETRY MECHANISM WITH QUEUES

**Current Issue:** Retry logic is deeply embedded in event processing steps (e.g., inside DDO decryption)

**Proposed Change:**

- **Move retry logic to event level** (not deep inside processing steps)
- **Implement queue-based retry system** for all 12 event types
- **Decouple retry from specific operations** (e.g., decrypt, p2p, HTTP)

**Implementation:**

```
┌─────────────────────────────────────────────────────────────┐
│                    EVENT PROCESSING QUEUE                    │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  Event Detected → Add to Queue                               │
│       ↓                                                      │
│  Queue Processor (async workers)                             │
│       ↓                                                      │
│  Process Event                                               │
│       ├─ Success → Mark complete, update DB                  │
│       └─ Failure → Add to Retry Queue with backoff           │
│                                                              │
│  Retry Queue (exponential backoff):                          │
│    - Retry 1: ~10 seconds                                    │
│    - Retry 2: ~1 minute                                      │
│    - Retry 3: ~10 minutes                                    │
│    - Retry 4: ~1 hour                                        │
│    - Retry 5: ~1 week (final attempt)                        │
│                                                              │
│  Benefits:                                                   │
│    ✓ Non-blocking (doesn't halt indexer)                    │
│    ✓ Works for ALL error types (HTTP, P2P, RPC, DB)         │
│    ✓ Configurable per event type                            │
│    ✓ Visible retry state in monitoring                      │
└─────────────────────────────────────────────────────────────┘
```

**Applies to:** All event processors, especially METADATA_CREATED/UPDATED (DDO decryption)

---

### 2. 🗄️ NEW DATABASE INDEX: `ddo_logs`

**Current Issue:**

- `ddoState` only tracks metadata events
- Order and pricing events have no error tracking
- No unified view of all DDO-related events

**Proposed Change:**

- Create new DB index: **`ddo_logs`**
- Store **all events** related to a DID (metadata, orders, pricing)
- Similar structure to `ddoState` but broader scope

**Schema:**

```typescript
interface DdoLog {
  did: string // Indexed
  chainId: number // Indexed
  eventType: string // METADATA_CREATED, ORDER_STARTED, etc.
  eventHash: string // Event signature hash
  txHash: string // Transaction hash
  blockNumber: number // Block number
  timestamp: number // Event timestamp
  status: 'success' | 'failed' | 'retrying'
  error?: string // Error message if failed
  retryCount: number // Number of retry attempts
  lastRetry?: number // Timestamp of last retry
  metadata?: Record<string, any> // Event-specific data
}
```

**Benefits:**

- Single source of truth for all DDO events
- Easier debugging (see all events for a DID)
- Track pricing/order event errors (not just metadata)
- Audit trail for compliance

---

### 3. 🔄 REPLACE EventEmitter WITH QUEUES

**Current Issue:**

- Using `EventEmitter` for communication
- Synchronous, blocking behavior
- No retry/replay capability
- Difficult to test

**Proposed Change:**

- Replace `EventEmitter` with **persistent queue system**
- Use queue for:
  - ✓ Newly indexed assets (instead of `eventEmitter.emit()`)
  - ✓ Reindex requests (block & transaction level)
  - ✓ Admin commands

**Queue Types:**

```
1. EVENT_PROCESSING_QUEUE (primary)
   - New events from blockchain
   - Priority: FIFO with retry backoff

2. REINDEX_QUEUE (existing, enhance)
   - Block-level reindex
   - Transaction-level reindex
   - Priority: Admin requests > Auto-retry

3. ORDER_QUEUE (new)
   - Store orders even if DDO not found
   - Process when DDO becomes available
```

**Benefits:**

- Testable (can inject mock queue)
- Observable (queue depth, retry counts)
- Resilient (survives crashes)
- Decoupled (no tight coupling between components)

---

### 4. 📦 HANDLE MISSING DDO IN ORDER/PRICING EVENTS

**Current Issue:**

- If DDO not found → skip order/pricing event
- Lost data if DDO indexed later

**Proposed Change:**

**For ORDER_STARTED/ORDER_REUSED:**

```
IF DDO not found:
  1. Create order record anyway (don't skip step 6)
  2. Store in database with status: 'orphaned'
  3. Add DDO processing to watch queue
  4. Skip only: step 5 (update count), step 7 (update DDO)
  5. When DDO indexed → process orphaned orders
```

**For PRICING EVENTS (Dispenser/Exchange):**

```
IF DDO not found:
  1. Check if DDO is in processing queue
  2. If yes → add pricing event to queue (process after DDO)
  3. If no → log to ddo_logs with error state
  4. Store pricing event data for future reconciliation
```

**Benefits:**

- No data loss
- Can reconcile later
- Better observability

---

### 5. 🚫 MOVE RETRY LOGIC TO ChainIndexer (Block Only That Chain)

**Current Issue:**

- Crawler startup retry in `OceanIndexer`
- Failure blocks **entire node** (all chains)

**Proposed Change:**

- Move `retryCrawlerWithDelay()` → **ChainIndexer**
- Each chain fails independently
- Other chains continue indexing

**Implementation:**

```typescript
// ChainIndexer.ts
async start() {
  let retries = 0
  const maxRetries = 10

  while (retries < maxRetries) {
    try {
      await this.initializeConnection() // RPC + DB
      await this.indexLoop()
      break
    } catch (error) {
      retries++
      const delay = Math.min(retries * 3000, 30000)
      INDEXER_LOGGER.error(
        `Chain ${this.blockchain.chainId} failed, retry ${retries}/${maxRetries} in ${delay}ms`
      )
      await sleep(delay)
    }
  }

  if (retries === maxRetries) {
    this.eventEmitter.emit('chain_failed', {
      chainId: this.blockchain.chainId,
      error: 'Max retries exceeded'
    })
  }
}
```

**Benefits:**

- Resilient multi-chain indexing
- One bad RPC doesn't kill everything
- Easier debugging (per-chain logs)

---

### 6. 📍 BLOCK RETRY QUEUE IMPROVEMENTS

**Current Issue:**

- Failed block retried, but `lastIndexedBlock` not updated
- Same block retried indefinitely
- No expiry/max retry limit

**Proposed Change:**

```
When block added to retry queue:
  1. Update lastIndexedBlock (move forward)
  2. Add block to retry queue with metadata:
     - blockNumber
     - retryCount (starts at 0)
     - maxRetries (default: 5)
     - lastError
     - expiryDate (when to give up)
  3. Process retry queue separately (exponential backoff)
  4. If maxRetries exceeded → log to failed_blocks table
```

**Retry Queue Schema:**

```typescript
interface BlockRetryTask {
  chainId: number
  blockNumber: number
  retryCount: number
  maxRetries: number
  lastError: string
  lastRetryAt: number
  expiryDate: number // Timestamp when to stop retrying
  events: string[] // Event hashes to reprocess
}
```

**Benefits:**

- Indexer moves forward (doesn't get stuck)
- Failed blocks retried in background
- Clear failure tracking

---

### 7. 🌐 REMOVE ECONNREFUSED-ONLY CONDITION

**Current Issue:**

- Retry only on `ECONNREFUSED` error
- Other errors (timeout, 500, p2p failures) not retried

**Proposed Change:**

- With event-level retry, **retry ALL error types**:
  - ✓ RPC errors (timeout, 500, 429 rate limit)
  - ✓ HTTP errors (decrypt service down)
  - ✓ P2P errors (peer unreachable)
  - ✓ Database errors (temp unavailable)
  - ✓ Validation errors (maybe retryable)

**Implementation:**

```typescript
// Classify errors
enum ErrorType {
  RETRYABLE_RPC = 'retryable_rpc',
  RETRYABLE_HTTP = 'retryable_http',
  RETRYABLE_P2P = 'retryable_p2p',
  RETRYABLE_DB = 'retryable_db',
  NON_RETRYABLE = 'non_retryable'
}

function classifyError(error: Error): ErrorType {
  if (error.code === 'ECONNREFUSED') return ErrorType.RETRYABLE_RPC
  if (error.code === 'ETIMEDOUT') return ErrorType.RETRYABLE_RPC
  if (error.message.includes('429')) return ErrorType.RETRYABLE_RPC
  if (error.message.includes('P2P')) return ErrorType.RETRYABLE_P2P
  if (error.message.includes('decrypt')) return ErrorType.RETRYABLE_HTTP
  if (error.message.includes('factory')) return ErrorType.NON_RETRYABLE
  return ErrorType.RETRYABLE_RPC // Default to retryable
}
```

---

### 8. ✅ UPDATE TESTS

**Required Test Updates:**

- Remove tests checking `EventEmitter` behavior
- Add tests for queue-based processing
- Add tests for retry with exponential backoff
- Add tests for orphaned orders
- Add tests for per-chain failure isolation
- Add tests for `ddo_logs` index
- Add tests for block retry with expiry

---

### Summary Table

| #   | Change                                        | Current Pain                      | Benefit                              | Effort | Priority    |
| --- | --------------------------------------------- | --------------------------------- | ------------------------------------ | ------ | ----------- |
| 1   | Event-level retry + queues                    | Retry logic scattered, blocking   | Unified, non-blocking, testable      | High   | 🔴 Critical |
| 2   | `ddo_logs` DB index                           | No order/pricing error tracking   | Full audit trail, debugging          | Medium | 🟡 High     |
| 3   | Replace EventEmitter with queues              | Blocking, not testable, no replay | Observable, resilient, testable      | High   | 🔴 Critical |
| 4   | Handle missing DDO (orphaned orders)          | Lost orders/pricing data          | No data loss, reconciliation         | Medium | 🟡 High     |
| 5   | Per-chain startup retry (ChainIndexer)        | One failure kills entire node     | Isolated failures, resilient         | Low    | 🔴 Critical |
| 6   | Block retry queue with expiry                 | Indexer stuck on bad blocks       | Progress continues, background retry | Medium | 🟡 High     |
| 7   | Retry ALL error types (not just ECONNREFUSED) | P2P/timeout/429 not retried       | Comprehensive error handling         | Low    | 🟡 High     |
| 8   | Update tests                                  | Tests assume old architecture     | Tests match new architecture         | Medium | 🟢 Medium   |

---

### Migration Roadmap

#### Phase 1: Foundation (Weeks 1-2) 🔴 Critical

**Goal:** Establish queue infrastructure and database schema

**Tasks:**

1. Create database tables:

   - `event_queue` (new events)
   - `event_retry_queue` (failed events)
   - `ddo_logs` (all DDO-related events)
   - `block_retry_queue` (failed blocks)
   - `failed_blocks` (permanent failures)
   - `dead_letter_queue` (max retries exceeded)

2. Implement queue system:

   - `EventQueue` class (persistent queue)
   - `EventQueueProcessor` class (worker pool)
   - `EventRetryProcessor` class (background retries)

3. Add error classification:
   - `ErrorType` enum
   - `classifyError()` function
   - `isRetryable()` logic

**Deliverables:**

- Database migrations
- Queue infrastructure code
- Unit tests for queue operations

---

#### Phase 2: Per-Chain Isolation (Week 3) 🔴 Critical

**Goal:** Prevent one bad chain from killing entire node

**Tasks:**

1. Move `retryCrawlerWithDelay()` from `OceanIndexer` → `ChainIndexer.start()`
2. Add per-chain retry counters
3. Emit `chain_startup_failed` event (don't crash node)
4. Update `OceanIndexer.startThread()` to handle chain failures gracefully

**Deliverables:**

- Updated `ChainIndexer.start()` with retry logic
- Tests for chain isolation
- Monitoring for failed chains

---

#### Phase 3: Event-Level Retry (Weeks 4-5) 🔴 Critical

**Goal:** Replace embedded retry with queue-based system

**Tasks:**

1. Update all 12 event processors:

   - Remove `withRetrial()` calls
   - Remove ECONNREFUSED checks
   - Just process, let queue handle retries

2. Update `ChainIndexer.indexLoop()`:

   - Replace `eventEmitter.emit()` → `eventQueue.enqueue()`
   - Process events via `EventQueueProcessor`

3. Implement exponential backoff:

   - 10s → 1min → 10min → 1hr → 1 week

4. Log all events to `ddo_logs`:
   - Success, failure, retrying states
   - Track retryCount, error messages

**Deliverables:**

- Refactored event processors (12 files)
- Queue-based event processing
- Tests for retry logic

---

#### Phase 4: Block Retry Queue (Week 6) 🟡 High

**Goal:** Indexer continues even with failed blocks

**Tasks:**

1. Implement `addBlockToRetryQueue()`
2. Update `indexLoop()` error handling:
   - Add failed block to queue
   - Still update `lastIndexedBlock` (move forward!)
3. Implement `processBlockRetryQueue()` (background loop)
4. Add expiry logic (maxRetries, expiryDate)
5. Move permanent failures to `failed_blocks` table

**Deliverables:**

- Block retry queue processor
- Background retry loop
- Tests for block retry

---

#### Phase 5: Handle Missing DDO (Week 7) 🟡 High

**Goal:** No data loss for orphaned orders/pricing

**Tasks:**

1. Update ORDER_STARTED/ORDER_REUSED:

   - Create order record even if DDO not found
   - Store as 'orphaned' status
   - Add to watch queue

2. Update pricing events (Dispenser/Exchange):

   - Check if DDO in processing queue
   - If yes → add pricing event to queue
   - If no → log to `ddo_logs` with error

3. Implement reconciliation job:
   - Periodically check for orphaned orders
   - Process when DDO becomes available

**Deliverables:**

- Orphaned order handling
- Pricing event queue logic
- Reconciliation job

---

#### Phase 6: Testing & Monitoring (Week 8) 🟢 Medium

**Goal:** Comprehensive tests and observability

**Tasks:**

1. Update existing tests:

   - Remove EventEmitter assertions
   - Add queue-based assertions

2. Add integration tests:

   - Full retry flow (10s → 1 week)
   - Chain isolation (one chain fails)
   - Block retry queue
   - Orphaned orders

3. Add monitoring dashboard:

   - Queue depth (event, retry, block)
   - Retry counts by error type
   - Dead letter queue size
   - Per-chain health

4. Add alerting:
   - Dead letter queue growing
   - Chain startup failures
   - High retry queue depth

**Deliverables:**

- Full test suite
- Monitoring dashboard
- Alerting rules

---

### Expected Outcomes

**Reliability:**

- ✅ No single point of failure (per-chain isolation)
- ✅ Graceful degradation (some chains fail, others continue)
- ✅ No data loss (orphaned orders, retry queue)
- ✅ Progress continues (failed blocks don't block indexer)

**Observability:**

- ✅ Full audit trail (`ddo_logs` for all events)
- ✅ Visible retry state (queue depths, retry counts)
- ✅ Clear failure tracking (dead letter queue, failed_blocks)
- ✅ Per-chain health monitoring

**Maintainability:**

- ✅ Unified retry logic (no scattered code)
- ✅ Testable (queues can be mocked)
- ✅ Configurable (retry counts, backoffs)
- ✅ Decoupled (event processors just process)

**Performance:**

- ✅ Non-blocking (retries don't halt indexer)
- ✅ Concurrent processing (worker pool)
- ✅ Exponential backoff (reduces RPC load)

---

## Overview

The Ocean Node Indexer continuously monitors blockchain networks for Ocean Protocol events and processes them in real-time.

**Current Architecture:**

- One `ChainIndexer` instance per blockchain network
- Async/await architecture (no worker threads)
- Event-driven communication via `EventEmitter`
- Processes 12 different event types
- Adaptive error handling with multiple retry layers

**Key Components:**

- **ChainIndexer** - Per-chain indexer running async indexing loop
- **Event Processors** - Handle specific blockchain event types (12 processors)
- **Validation Pipeline** - Multi-layer validation (factory, metadata, publishers)
- **Database Layer** - Persistence (Elasticsearch/Typesense)

---

## Event Monitoring Architecture

### Continuous Monitoring Process

**Location:** `ChainIndexer.ts` - `indexLoop()`

```
┌─────────────────────────────────────────────────────────────────┐
│                    CONTINUOUS MONITORING LOOP                    │
│                                                                  │
│  async indexLoop() {                                             │
│    while (!stopSignal) {                                         │
│      1. Get last indexed block from DB                           │
│      2. Get current network height from RPC                      │
│      3. Calculate chunk size (adaptive: 1-1000 blocks)          │
│      4. Retrieve events: provider.getLogs(fromBlock, toBlock)   │
│      5. Process events through pipeline                          │
│      6. Update last indexed block in DB                          │
│      7. Emit events to downstream consumers                      │
│      8. Sleep for interval (default: 30 seconds)                 │
│      9. Process reindex queue (if any)                           │
│    }                                                              │
│  }                                                                │
└─────────────────────────────────────────────────────────────────┘
```

### Event Discovery Mechanism

**Step-by-Step Process:**

```
1. Get Network State
   ├─> lastIndexedBlock = await db.indexer.retrieve(chainId)
   ├─> networkHeight = await provider.getBlockNumber()
   └─> startBlock = max(lastIndexedBlock, deploymentBlock)

2. Calculate Chunk to Process
   ├─> remainingBlocks = networkHeight - startBlock
   ├─> blocksToProcess = min(chunkSize, remainingBlocks)
   └─> Adaptive chunkSize (halves on error, recovers after 3 successes)

3. Retrieve Events from Blockchain
   └─> provider.getLogs({
         fromBlock: lastIndexedBlock + 1,
         toBlock: lastIndexedBlock + blocksToProcess,
         topics: [OCEAN_EVENT_TOPIC_HASHES]  // Filter by event signatures
       })
       Returns: Log[] (raw blockchain event logs)

4. Route Events to Processors
   └─> processChunkLogs(logs, signer, provider, chainId)
```

### Event Topic Filtering

The indexer listens for these Ocean Protocol event signatures:

```typescript
EVENT_HASHES = {
  // Metadata Events
  '0x5463569d...': METADATA_CREATED
  '0x127c3f87...': METADATA_UPDATED
  '0x1f432bc9...': METADATA_STATE

  // Order Events
  '0xa0e0424c...': ORDER_STARTED
  '0x6e0dd743...': ORDER_REUSED

  // Dispenser Events
  '0xdcda18b5...': DISPENSER_CREATED
  '0x6e0cf36d...': DISPENSER_ACTIVATED
  '0x53ae36d4...': DISPENSER_DEACTIVATED

  // Exchange Events
  '0xdcda18b5...': EXCHANGE_CREATED
  '0x6e0cf36d...': EXCHANGE_ACTIVATED
  '0x53ae36d4...': EXCHANGE_DEACTIVATED
  '0x7b3b3f0f...': EXCHANGE_RATE_CHANGED
}
```

**Monitoring Frequency:**

- Checks for new blocks every 30 seconds (configurable via `INDEXER_INTERVAL`)
- Processes up to `chunkSize` blocks per iteration (default: 100-1000)
- Adaptive: reduces chunk size on RPC errors, recovers after successes

---

## Event Processing Pipeline

### Overall Flow

```
Raw Blockchain Logs
    ↓
┌─────────────────────────────────────────────────────────────┐
│ 1. EVENT IDENTIFICATION                                      │
│    - Extract topic[0] (event signature hash)                │
│    - Look up in EVENT_HASHES mapping                        │
│    - Check if Ocean Protocol event                          │
└─────────────────────────────────────────────────────────────┘
    ↓
┌─────────────────────────────────────────────────────────────┐
│ 2. VALIDATION (for metadata events)                         │
│    - Get transaction receipt                                │
│    - Extract MetadataValidated events                       │
│    - Check allowedValidators list                           │
│    - Check access list memberships (balanceOf calls)        │
│    - If validation fails → skip event, continue to next     │
└─────────────────────────────────────────────────────────────┘
    ↓
┌─────────────────────────────────────────────────────────────┐
│ 3. ROUTE TO PROCESSOR                                        │
│    - Get cached processor instance (per eventType + chain)  │
│    - Call processor.processEvent()                          │
└─────────────────────────────────────────────────────────────┘
    ↓
┌─────────────────────────────────────────────────────────────┐
│ 4. EVENT-SPECIFIC PROCESSING                                │
│    - Factory validation (NFT deployed by Ocean)             │
│    - Decode event data from receipt                         │
│    - Decrypt/decompress DDO (if metadata event)             │
│    - Fetch additional on-chain data (NFT info, pricing)     │
│    - Build domain model with enriched metadata              │
└─────────────────────────────────────────────────────────────┘
    ↓
┌─────────────────────────────────────────────────────────────┐
│ 5. DATABASE PERSISTENCE                                      │
│    - Create or update DDO                                   │
│    - Update DDO state (validation tracking)                 │
│    - Create order records (if order event)                  │
└─────────────────────────────────────────────────────────────┘
    ↓
┌─────────────────────────────────────────────────────────────┐
│ 6. EVENT EMISSION                                            │
│    - ChainIndexer emits to INDEXER_CRAWLING_EVENT_EMITTER  │
│    - OceanIndexer re-emits to INDEXER_DDO_EVENT_EMITTER    │
│    - Downstream consumers notified (API, cache, webhooks)   │
└─────────────────────────────────────────────────────────────┘
```

### Location References

**Event Monitoring:** `ChainIndexer.ts` - `indexLoop()`  
**Event Identification:** `processor.ts` - `processChunkLogs()`  
**Event Routing:** `processor.ts` - `getEventProcessor()`  
**Event Processing:** `processors/*.ts` - `processEvent()`

---

## Detailed Event Handling

### 1. METADATA_CREATED Event

**Trigger:** New data asset published on-chain

**Processor:** `MetadataEventProcessor.ts`

**On-Chain Data:**

- `owner` - Publisher address
- `flags` - Encryption/compression flags (bit 2 = encrypted)
- `metadata` - Encrypted/compressed DDO
- `metadataHash` - SHA256 hash of DDO
- `validateTime` - Timestamp

**Processing Steps:**

```
1. FACTORY VALIDATION
   └─> wasNFTDeployedByOurFactory(chainId, signer, nftAddress)
       ├─> Instantiate ERC721Factory contract
       ├─> Loop through all NFTs from factory
       └─> If not deployed by Ocean → REJECT, skip event

2. DECODE EVENT DATA
   └─> getEventData(provider, txHash, ERC721Template.abi)
       ├─> Fetch transaction receipt
       ├─> Find log matching event hash
       ├─> Parse with contract ABI
       └─> Extract: owner, flags, metadata, metadataHash

3. DDO DECRYPTION (Complex: 400+ lines, 3 strategies)
   └─> decryptDDO(decryptorURL, flag, owner, nftAddress, chainId, txId, metadataHash, metadata)
       │
       ├─> IF ENCRYPTED (flag & 2 != 0):
       │   ├─> Get nonce from provider/timestamp
       │   ├─> Build signature:
       │   │   - message = txId + ethAddress + chainId + nonce
       │   │   - hash = solidityPackedKeccak256(message)
       │   │   - signature = wallet.signMessage(hash)
       │   ├─> HTTP: POST /api/services/decrypt
       │   │   - Payload: { transactionId, chainId, signature, nonce }
       │   │   - Timeout: 30 seconds
       │   │   - Retry: up to 5 times (withRetrial)
       │   │
       │   │   ⚠️  PROPOSED CHANGE:
       │   │   └─> Use exponential backoff (10s → 1min → 10min → 1hr → 1 week)
       │   │       └─> Non-blocking retry using queue mechanism
       │   │
       │   ├─> P2P: p2pNode.sendTo(decryptorURL, message)
       │   │
       │   │   ⚠️  PROPOSED CHANGE:
       │   │   └─> Add retry mechanism for P2P connections
       │   │
       │   ├─> Local: node.getCoreHandlers().handle(decryptDDOTask)
       │   └─> Validate response hash matches metadataHash
       │
       ⚠️  PROPOSED ARCHITECTURAL CHANGE:
       │   └─> Move retry to EVENT LEVEL (decouple from decrypt)
       │   └─> Always update ddo_logs (success or error)
       │   └─> For retried DDOs: Get order count from DB (not from old DDO)
       │
       └─> IF COMPRESSED (flag & 2 == 0):
           └─> Parse directly: JSON.parse(toUtf8String(getBytes(metadata)))

4. VALIDATE DDO ID
   └─> Check ddo.id === makeDid(nftAddress, chainId)
       └─> If mismatch → REJECT, update ddoState with error

5. CHECK AUTHORIZED PUBLISHERS (if configured)
   └─> Check if owner in authorizedPublishers list
       └─> If not → REJECT, update ddoState with error

6. FETCH NFT INFORMATION (multiple RPC calls)
   └─> getNFTInfo(nftAddress, signer, owner, timestamp)
       ├─> nftContract.getMetaData() → state
       ├─> nftContract.getId() → token ID
       ├─> nftContract.tokenURI(id) → URI
       ├─> nftContract.name() → name
       ├─> nftContract.symbol() → symbol
       └─> Return: { state, address, name, symbol, owner, created, tokenURI }

7. FETCH TOKEN INFORMATION (per datatoken)
   └─> For each service in DDO:
       ├─> datatokenContract.name()
       ├─> datatokenContract.symbol()
       └─> Collect: { address, name, symbol, serviceId }

8. FETCH PRICING INFORMATION (multiple RPC calls)
   └─> For each datatoken:
       ├─> Check dispenser: dispenserContract.status(datatoken)
       ├─> Check exchange: exchangeContract.getAllExchanges()
       └─> Build prices array: [{ type, price, contract, token }]

9. CHECK PURGATORY STATUS
   └─> Purgatory.check(nftAddress, chainId, account)
       └─> Return: { state: boolean }

10. BUILD INDEXED METADATA
    └─> Construct enriched metadata:
        ├─> nft: { state, address, name, symbol, owner, created, tokenURI }
        ├─> event: { txid, from, contract, block, datetime }
        ├─> stats: [{ datatokenAddress, name, symbol, orders: 0, prices: [...] }]
        └─> purgatory: { state }

11. STORE IN DATABASE
    └─> ddoDatabase.create(ddo)
        ddoState.create(chainId, did, nftAddress, txId, valid=true)

12. EMIT EVENT
    └─> eventEmitter.emit(METADATA_CREATED, { chainId, data: ddo })
```

**RPC Calls:** ~10-20 (receipt, factory, NFT info, token info, pricing)

**⚠️ PROPOSED IMPROVEMENTS:**

```
┌─────────────────────────────────────────────────────────────┐
│ METADATA_CREATED/UPDATED IMPROVEMENTS                       │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│ 1. Replace EventEmitter with Queue System                   │
│    - Use persistent queue instead of eventEmitter.emit()    │
│    - Better for testing and observability                   │
│                                                              │
│ 2. Event-Level Retry (not deep in decryption)               │
│    - Queue-based retry with exponential backoff             │
│    - Non-blocking (doesn't halt indexer)                    │
│    - Works for ALL error types (HTTP, P2P, RPC, DB)         │
│                                                              │
│ 3. Always Update ddo_logs Index                             │
│    - Log success and failures                               │
│    - Track: eventHash, txHash, blockNumber, retryCount      │
│                                                              │
│ 4. For Retried DDOs                                         │
│    - Recalculate order count from DB (not from old DDO)     │
│    - Query: SELECT COUNT(*) FROM orders WHERE did = ?       │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

---

### 2. METADATA_UPDATED Event

**Trigger:** Asset metadata is updated on-chain

**Processor:** `MetadataEventProcessor.ts` (same as METADATA_CREATED)

**Processing:** **Similar to METADATA_CREATED** with these differences:

```
1-10. Same validation and processing as METADATA_CREATED

11. RETRIEVE EXISTING DDO
    └─> existingDdo = ddoDatabase.retrieve(did)

12. MERGE DDO DATA
    └─> Merge new metadata with existing:
        ├─> Update: metadata, services, credentials
        ├─> Preserve: existing order counts, pricing
        ├─> Merge: pricing arrays (add new, keep existing)
        └─> Update: indexedMetadata.event (new tx, block, datetime)

13. UPDATE DATABASE
    └─> ddoDatabase.update(mergedDdo)
        ddoState.update(chainId, did, nftAddress, txId, valid=true)

14. EMIT EVENT
    └─> eventEmitter.emit(METADATA_UPDATED, { chainId, data: ddo })
```

**Key Difference:** Uses `update()` instead of `create()`, merges with existing data

**RPC Calls:** ~10-20

**⚠️ PROPOSED IMPROVEMENTS:** Same as METADATA_CREATED (see above)

---

### 3. METADATA_STATE Event

**Trigger:** Asset state changes (Active → Revoked/Deprecated or vice versa)

**Processor:** `MetadataStateEventProcessor.ts`

**On-Chain Data:**

- `metadataState` - New state value (0=Active, 1=End of Life, 2=Deprecated, 3=Revoked, etc.)

**Processing Steps:**

```
1. DECODE EVENT DATA
   └─> Extract: metadataState (integer)

2. BUILD DID
   └─> did = makeDid(nftAddress, chainId)

3. RETRIEVE EXISTING DDO
   └─> ddo = ddoDatabase.retrieve(did)
       └─> If not found → log and skip

4. CHECK STATE CHANGE
   └─> Compare old state vs new state

       IF old=Active AND new=Revoked/Deprecated:
       ├─> DDO becomes non-visible
       ├─> Create short DDO (minimal version):
       │   └─> { id, version: 'deprecated', chainId, nftAddress,
       │         indexedMetadata: { nft: { state } } }
       └─> Store short DDO

       ELSE:
       └─> Update nft.state in existing DDO

5. UPDATE DATABASE
   └─> ddoDatabase.update(ddo)

6. EMIT EVENT
   └─> eventEmitter.emit(METADATA_STATE, { chainId, data: ddo })
```

**Special Behavior:** When asset is revoked/deprecated, stores minimal DDO for potential future restoration

**RPC Calls:** 1-2 (receipt, decode)

---

### 4. ORDER_STARTED Event

**Trigger:** Someone purchases/starts access to a data asset

**Processor:** `OrderStartedEventProcessor.ts`

**On-Chain Data:**

- `consumer` - Buyer address
- `payer` - Payment source address
- `amount` - Amount paid
- `serviceId` - Service index
- `timestamp` - Order time

**Processing Steps:**

```
1. DECODE EVENT DATA
   └─> Extract: consumer, payer, amount, serviceIndex, timestamp

2. FIND NFT ADDRESS
   └─> datatokenContract = getDtContract(signer, event.address)
       nftAddress = datatokenContract.getERC721Address()

3. BUILD DID
   └─> did = makeDid(nftAddress, chainId)

4. RETRIEVE DDO
   └─> ddo = ddoDatabase.retrieve(did)
       └─> If not found → log error, skip
           ⚠️  PROPOSED: Don't skip! Go to step 6 (create order), skip only 5 & 7
           - Store order as 'orphaned' in DB
           - Process when DDO becomes available __> go to 6 create order store and skip only step 5, 7

5. UPDATE ORDER COUNT
   └─> Find service in ddo.indexedMetadata.stats by datatokenAddress
       └─> Increment stat.orders += 1

6. CREATE ORDER RECORD
   └─> orderDatabase.create({
         type: 'startOrder',
         timestamp,
         consumer,
         payer,
         datatokenAddress: event.address,
         nftAddress,
         did,
         startOrderId: txHash
       })

7. UPDATE DDO
   └─> ddoDatabase.update(ddo)

8. EMIT EVENT
   └─> eventEmitter.emit(ORDER_STARTED, { chainId, data: ddo })
       ⚠️  PROPOSED: Replace EventEmitter with queue-based system
```

**RPC Calls:** 1-2 (get NFT address, receipt)

**⚠️ PROPOSED IMPROVEMENTS:**

- Store orders even if DDO not found (orphaned orders)
- Log to `ddo_logs` index (not just ddoState)
- Add to ORDER_QUEUE for later processing

---

### 5. ORDER_REUSED Event

**Trigger:** Someone reuses an existing order for repeated access

**Processor:** `OrderReusedEventProcessor.ts`

**On-Chain Data:**

- `startOrderId` - Reference to original order
- `payer` - Payment source (may differ from original)
- `timestamp` - Reuse time

**Processing:** **Similar to ORDER_STARTED** with these differences:

```
1. DECODE EVENT DATA
   └─> Extract: startOrderId, payer, timestamp

2-5. Same as ORDER_STARTED (find NFT, get DDO, update count)

6. RETRIEVE START ORDER
   └─> startOrder = orderDatabase.retrieve(startOrderId)
       └─> Need original order for consumer address

7. CREATE REUSE ORDER RECORD
   └─> orderDatabase.create({
         type: 'reuseOrder',
         timestamp,
         consumer: startOrder.consumer,  // From original order
         payer,  // May be different
         datatokenAddress: event.address,
         nftAddress,
         did,
         startOrderId  // Reference to original order
       })

8-9. Same as ORDER_STARTED (update DDO, emit event)
     ⚠️  PROPOSED: Same improvements as ORDER_STARTED
```

**Key Difference:** Links to original order, may have different payer

**RPC Calls:** 1-2

---

### 6. DISPENSER_CREATED Event

**Trigger:** New dispenser (free token distribution) is created

**Processor:** `DispenserCreatedEventProcessor.ts`

**On-Chain Data:**

- `datatokenAddress` - Datatoken being dispensed
- `owner` - Dispenser owner
- `maxBalance` - Max tokens per user
- `maxTokens` - Max total tokens

**Processing Steps:**

```
1. DECODE EVENT DATA
   └─> Extract: datatokenAddress, owner, maxBalance, maxTokens

2. VALIDATE DISPENSER CONTRACT
   └─> isValidDispenserContract(event.address, chainId)
       └─> Check if dispenser is approved by Router
       └─> If not → log warning, skip
           ⚠️  PROPOSED: Don't just skip!
           - Log to `ddo_logs` index with error state
           - Store: eventHash, txHash, blockNumber
           - Create unified error handler for pricing events
           - Keep all errors related to a DID in one place, --> add somethning similar to ddo state but for pricing errors and a handler
                                       └─> maybe some logs and add all errors related to a did in a place keep one handler
                                       └─> store in the logs the event hash and tx hash and block number

3. FIND NFT ADDRESS
   └─> datatokenContract.getERC721Address()

4. RETRIEVE DDO
   └─> ddo = ddoDatabase.retrieve(did)
   └─> if not found -> check queue for ddo if found add to queue as well else skip applicable to all events

5. ADD DISPENSER TO PRICING
   └─> Find service by datatokenAddress
       └─> If dispenser doesn't exist in prices:
           └─> prices.push({
                 type: 'dispenser',
                 price: '0',  // Free
                 contract: event.address,
                 token: datatokenAddress
               })

6. UPDATE DDO
   └─> ddoDatabase.update(ddo)

7. EMIT EVENT
   └─> eventEmitter.emit(DISPENSER_CREATED, { chainId, data: ddo })
       ⚠️  PROPOSED: Replace EventEmitter with queue-based system
```

**RPC Calls:** 2-3 (receipt, validation, NFT address)

**⚠️ PROPOSED IMPROVEMENTS:** (applies to all pricing events)

- Log all events to `ddo_logs` index
- Handle missing DDO with queue mechanism
- Unified error handler for pricing events

---

### 7. DISPENSER_ACTIVATED Event

**Trigger:** Dispenser is activated (enables token distribution)

**Processor:** `DispenserActivatedEventProcessor.ts`

**Processing:** **Similar to DISPENSER_CREATED**

```
1-5. Same validation and processing as DISPENSER_CREATED

Key Addition:
- Checks if dispenser already exists before adding
- If already exists → skip (no duplicate entries)
```

**RPC Calls:** 2-3

---

### 8. DISPENSER_DEACTIVATED Event

**Trigger:** Dispenser is deactivated (disables token distribution)

**Processor:** `DispenserDeactivatedEventProcessor.ts`

**On-Chain Data:**

- `datatokenAddress` - Datatoken address

**Processing:**

```
1. DECODE EVENT DATA
   └─> Extract: datatokenAddress

2. VALIDATE & RETRIEVE DDO
   └─> Same as DISPENSER_CREATED

3. REMOVE DISPENSER FROM PRICING
   └─> Find service by datatokenAddress
       └─> Find dispenser entry by contract address
           └─> prices = prices.filter(p => p.contract !== event.address)

4. UPDATE DDO
   └─> ddoDatabase.update(ddo)

5. EMIT EVENT
   └─> eventEmitter.emit(DISPENSER_DEACTIVATED, { chainId, data: ddo })
```

**Key Difference:** Removes dispenser entry instead of adding

**RPC Calls:** 2-3

---

### 9. EXCHANGE_CREATED Event

**Trigger:** New fixed-rate exchange is created for a datatoken

**Processor:** `ExchangeCreatedEventProcessor.ts`

**On-Chain Data:**

- `exchangeId` - Unique exchange identifier
- `datatokenAddress` - Datatoken being sold
- `baseToken` - Payment token (e.g., USDC, DAI)
- `rate` - Exchange rate

**Processing Steps:**

```
1. DECODE EVENT DATA
   └─> Extract: exchangeId, datatokenAddress, baseToken, rate

2. VALIDATE EXCHANGE CONTRACT
   └─> isValidFreContract(event.address, chainId)
       └─> Check if exchange is approved by Router
       └─> If not → log error, skip

3. FIND NFT ADDRESS
   └─> datatokenContract.getERC721Address()

4. RETRIEVE DDO
   └─> ddo = ddoDatabase.retrieve(did)

5. ADD EXCHANGE TO PRICING
   └─> Find service by datatokenAddress
       └─> If exchange doesn't exist in prices:
           └─> prices.push({
                 type: 'exchange',
                 price: rate,
                 contract: event.address,
                 token: baseToken,
                 exchangeId
               })

6. UPDATE DDO
   └─> ddoDatabase.update(ddo)

7. EMIT EVENT
   └─> eventEmitter.emit(EXCHANGE_CREATED, { chainId, data: ddo })
```

**RPC Calls:** 2-3

---

### 10. EXCHANGE_ACTIVATED Event

**Trigger:** Fixed-rate exchange is activated

**Processor:** `ExchangeActivatedEventProcessor.ts`

**Processing:** **Similar to EXCHANGE_CREATED**

```
1-5. Same validation and processing as EXCHANGE_CREATED

Key Addition:
- Checks if exchange already exists before adding
- If already exists → skip (no duplicate entries)
```

**RPC Calls:** 2-3

---

### 11. EXCHANGE_DEACTIVATED Event

**Trigger:** Fixed-rate exchange is deactivated

**Processor:** `ExchangeDeactivatedEventProcessor.ts`

**On-Chain Data:**

- `exchangeId` - Exchange identifier

**Processing:**

```
1. DECODE EVENT DATA
   └─> Extract: exchangeId

2. GET EXCHANGE DETAILS
   └─> freContract.getExchange(exchangeId)
       └─> Extract: datatokenAddress

3. VALIDATE & RETRIEVE DDO
   └─> Same as EXCHANGE_CREATED

4. REMOVE EXCHANGE FROM PRICING
   └─> Find service by datatokenAddress
       └─> Find exchange entry by exchangeId
           └─> prices = prices.filter(p => p.exchangeId !== exchangeId)

5. UPDATE DDO
   └─> ddoDatabase.update(ddo)

6. EMIT EVENT
   └─> eventEmitter.emit(EXCHANGE_DEACTIVATED, { chainId, data: ddo })
```

**Key Difference:** Removes exchange entry instead of adding

**RPC Calls:** 2-3

---

### 12. EXCHANGE_RATE_CHANGED Event

**Trigger:** Exchange rate is updated for a fixed-rate exchange

**Processor:** `ExchangeRateChangedEventProcessor.ts`

**On-Chain Data:**

- `exchangeId` - Exchange identifier
- `newRate` - Updated exchange rate

**Processing Steps:**

```
1. VALIDATE EXCHANGE CONTRACT
   └─> isValidFreContract(event.address, chainId)

2. DECODE EVENT DATA
   └─> Extract: exchangeId, newRate

3. GET EXCHANGE DETAILS
   └─> freContract.getExchange(exchangeId)
       └─> Extract: datatokenAddress

4. RETRIEVE DDO
   └─> ddo = ddoDatabase.retrieve(did)

5. UPDATE EXCHANGE RATE
   └─> Find service by datatokenAddress
       └─> Find exchange entry by exchangeId
           └─> price.price = newRate  // Update in-place

6. UPDATE DDO
   └─> ddoDatabase.update(ddo)

7. EMIT EVENT
   └─> eventEmitter.emit(EXCHANGE_RATE_CHANGED, { chainId, data: ddo })
```

**Key Difference:** Updates existing price instead of add/remove

**RPC Calls:** 2-3

---

### Event Processing Summary

**Metadata Events (3):**

- METADATA_CREATED: Full validation + decryption + enrichment (~10-20 RPC calls)
- METADATA_UPDATED: Same as CREATED but merges with existing (~10-20 RPC calls)
- METADATA_STATE: Lightweight state update (~1-2 RPC calls)

**Order Events (2):**

- ORDER_STARTED: Update order count + create record (~1-2 RPC calls)
- ORDER_REUSED: Similar to STARTED, links to original order (~1-2 RPC calls)

**Dispenser Events (3):**

- DISPENSER_CREATED: Add pricing entry (~2-3 RPC calls)
- DISPENSER_ACTIVATED: Similar to CREATED (~2-3 RPC calls)
- DISPENSER_DEACTIVATED: Remove pricing entry (~2-3 RPC calls)

**Exchange Events (4):**

- EXCHANGE_CREATED: Add pricing entry (~2-3 RPC calls)
- EXCHANGE_ACTIVATED: Similar to CREATED (~2-3 RPC calls)
- EXCHANGE_DEACTIVATED: Remove pricing entry (~2-3 RPC calls)
- EXCHANGE_RATE_CHANGED: Update existing price (~2-3 RPC calls)

---

## Error Handling & Retry Mechanisms

### Overview: 4 Retry Layers (Current)

The indexer has 4 different retry mechanisms at different levels:

```
┌──────────────────────────────────────────────────────────────┐
│ LAYER 1: Crawler Startup Retry                               │
│ Location: OceanIndexer - retryCrawlerWithDelay()            │
│ Scope: Initial RPC/DB connection                             │
│ Max Retries: 10                                               │
│ Interval: max(fallbackRPCs.length * 3000, 5000) ms          │
│ Strategy: Recursive retry with fallback RPCs                 │
│ Checks: Network ready + DB reachable                         │
│                                                              │
│ ⚠️  ISSUE: Failure blocks ENTIRE NODE (all chains)           │
└──────────────────────────────────────────────────────────────┘
                          ↓
┌──────────────────────────────────────────────────────────────┐
│ LAYER 2: Adaptive Chunk Sizing                               │
│ Location: ChainIndexer - indexLoop()                         │
│ Scope: RPC getLogs() failures                                │
│ Max Retries: Infinite (until success or stop)                │
│ Strategy: Halve chunk size on error (min: 1 block)          │
│ Recovery: Revert to original after 3 successes              │
└──────────────────────────────────────────────────────────────┘
                          ↓
┌──────────────────────────────────────────────────────────────┐
│ LAYER 3: Block Processing Retry                              │
│ Location: ChainIndexer - indexLoop() catch block            │
│ Scope: Event processing errors                               │
│ Max Retries: Infinite                                         │
│ Strategy: Don't update lastBlock, retry same chunk           │
│ Backoff: Sleep for interval (30s) before retry              │
│                                                              │
│ ⚠️  ISSUE: Indexer stuck on failed block, no progress        │
└──────────────────────────────────────────────────────────────┘
                          ↓
┌──────────────────────────────────────────────────────────────┐
│ LAYER 4: Individual RPC Retry                                │
│ Location: BaseProcessor - withRetrial()                     │
│ Scope: DDO decryption HTTP calls                             │
│ Max Retries: 5                                                │
│ Strategy: Exponential backoff                                │
│ Conditions: Only retry on ECONNREFUSED                       │
│                                                              │
│ ⚠️  ISSUE: Only HTTP, not P2P/other errors, blocking         │
└──────────────────────────────────────────────────────────────┘
```

---

### 🔴 PROPOSED: New Retry Architecture

```
┌──────────────────────────────────────────────────────────────┐
│ LAYER 1: Per-Chain Startup Retry (MOVED TO ChainIndexer)    │
│ Location: ChainIndexer - start()                             │
│ Scope: Initial RPC/DB connection PER CHAIN                   │
│ Max Retries: 10                                               │
│ Interval: Progressive (3s, 6s, 9s, ... 30s max)             │
│ Strategy: Each chain retries independently                   │
│                                                              │
│ ✅ BENEFIT: One bad RPC doesn't kill entire node             │
│ ✅ BENEFIT: Other chains continue indexing                    │
└──────────────────────────────────────────────────────────────┘
                          ↓
┌──────────────────────────────────────────────────────────────┐
│ LAYER 2: Adaptive Chunk Sizing (UNCHANGED)                   │
│ Location: ChainIndexer - indexLoop()                         │
│ Scope: RPC getLogs() failures                                │
│ Max Retries: Infinite (until success or stop)                │
│ Strategy: Halve chunk size on error (min: 1 block)          │
│ Recovery: Revert to original after 3 successes              │
└──────────────────────────────────────────────────────────────┘
                          ↓
┌──────────────────────────────────────────────────────────────┐
│ LAYER 3: Block Retry Queue (ENHANCED)                        │
│ Location: ChainIndexer - processBlockRetryQueue()           │
│ Scope: Failed blocks                                         │
│ Max Retries: 5 per block                                      │
│ Strategy:                                                    │
│   1. Failed block → add to retry queue                       │
│   2. UPDATE lastIndexedBlock (move forward!)                 │
│   3. Add expiry: maxRetries & expiryDate                     │
│   4. Process retry queue separately (background)             │
│   5. Exponential backoff per block                           │
│                                                              │
│ ✅ BENEFIT: Indexer doesn't get stuck                         │
│ ✅ BENEFIT: Failed blocks retried in background               │
│ ✅ BENEFIT: Clear failure tracking (failed_blocks table)      │
└──────────────────────────────────────────────────────────────┘
                          ↓
┌──────────────────────────────────────────────────────────────┐
│ LAYER 4: Event-Level Retry Queue (NEW!)                      │
│ Location: EventQueueProcessor (new component)               │
│ Scope: ALL event processing errors                           │
│ Max Retries: 5 per event                                      │
│ Strategy: Queue-based with exponential backoff               │
│   - Retry 1: ~10 seconds                                     │
│   - Retry 2: ~1 minute                                       │
│   - Retry 3: ~10 minutes                                     │
│   - Retry 4: ~1 hour                                         │
│   - Retry 5: ~1 week (final)                                 │
│                                                              │
│ Retry ALL error types:                                       │
│   ✅ HTTP errors (decrypt service)                            │
│   ✅ P2P errors (peer unreachable)                            │
│   ✅ RPC errors (timeout, 500, 429)                           │
│   ✅ DB errors (temp unavailable)                             │
│   ✅ Validation errors (if retryable)                         │
│                                                              │
│ ✅ BENEFIT: Non-blocking, unified retry logic                 │
│ ✅ BENEFIT: Removes ECONNREFUSED-only condition               │
│ ✅ BENEFIT: Decoupled from processing logic                   │
└──────────────────────────────────────────────────────────────┘
```

### Layer 1: Startup Retry

#### Current Implementation

**Purpose:** Ensure RPC and DB are reachable before starting indexer

**Location:** `OceanIndexer.retryCrawlerWithDelay()`

**Code Flow:**

```typescript
async retryCrawlerWithDelay(blockchain: Blockchain, interval = 5000) {
  const retryInterval = Math.max(blockchain.getKnownRPCs().length * 3000, interval)

  // Try to connect
  const result = await startCrawler(blockchain)
  const dbActive = this.getDatabase()

  // Check DB reachable
  if (!dbActive || !(await isReachableConnection(dbActive.getConfig().url))) {
    INDEXER_LOGGER.error(`Giving up start crawling. DB is not online!`)
    return false
  }

  if (result) {
    INDEXER_LOGGER.info('Blockchain connection successfully established!')
    return true
  } else {
    numCrawlAttempts++
    if (numCrawlAttempts <= MAX_CRAWL_RETRIES) {
      await sleep(retryInterval)
      return this.retryCrawlerWithDelay(blockchain, retryInterval)  // Recursive
    } else {
      INDEXER_LOGGER.error(`Giving up after ${MAX_CRAWL_RETRIES} retries.`)
      return false
    }
  }
}
```

**Behavior:**

- Recursive retry up to 10 times
- Increasing interval based on number of fallback RPCs
- Checks both RPC and DB connectivity
- Tries fallback RPCs if available

**⚠️ ISSUE:** If one chain fails, **entire node stops** (all chains blocked)

---

#### 🔴 PROPOSED: Move to ChainIndexer

**New Location:** `ChainIndexer.start()`

**Benefits:**

- ✅ Per-chain isolation (one bad chain doesn't kill others)
- ✅ Independent retry counters per chain
- ✅ Better error visibility (which chain failed)
- ✅ Graceful degradation (continue with working chains)

**Proposed Code:**

```typescript
// ChainIndexer.ts
export class ChainIndexer {
  private maxStartupRetries = 10
  private startupRetryCount = 0

  async start(): Promise<boolean> {
    while (this.startupRetryCount < this.maxStartupRetries) {
      try {
        // Initialize RPC connection
        await this.initializeRpcConnection()

        // Check DB connectivity
        const dbActive = await this.checkDatabaseConnection()
        if (!dbActive) {
          throw new Error('Database not reachable')
        }

        // Start indexing loop
        INDEXER_LOGGER.info(`Chain ${this.blockchain.chainId} started successfully`)
        await this.indexLoop()
        return true
      } catch (error) {
        this.startupRetryCount++
        const delay = Math.min(this.startupRetryCount * 3000, 30000)

        INDEXER_LOGGER.error(
          `Chain ${this.blockchain.chainId} startup failed ` +
            `(attempt ${this.startupRetryCount}/${this.maxStartupRetries}), ` +
            `retry in ${delay}ms: ${error.message}`
        )

        if (this.startupRetryCount < this.maxStartupRetries) {
          await sleep(delay)
          // Try next fallback RPC if available
          this.rotateToNextRpc()
        }
      }
    }

    // Max retries exceeded
    INDEXER_LOGGER.error(
      `Chain ${this.blockchain.chainId} failed after ${this.maxStartupRetries} retries`
    )
    this.eventEmitter.emit('chain_startup_failed', {
      chainId: this.blockchain.chainId,
      error: 'Max startup retries exceeded'
    })
    return false
  }
}
```

**Migration Steps:**

1. Move retry logic from `OceanIndexer` → `ChainIndexer`
2. Update `OceanIndexer.startThread()` to handle per-chain failures
3. Add monitoring for failed chains
4. Update tests to verify chain isolation

---

### Layer 2: Adaptive Chunk Sizing

**Purpose:** Handle RPC rate limits and transient failures

**Code Flow:**

```typescript
// In indexLoop()
let chunkSize = rpcDetails.chunkSize || 1
let successfulRetrievalCount = 0

while (!stopSignal) {
  try {
    chunkEvents = await retrieveChunkEvents(
      signer,
      provider,
      chainId,
      startBlock,
      blocksToProcess
    )
    successfulRetrievalCount++
  } catch (error) {
    // ERROR: Reduce chunk size
    INDEXER_LOGGER.warn(`RPC error: ${error.message}`)
    chunkSize = Math.floor(chunkSize / 2) < 1 ? 1 : Math.floor(chunkSize / 2)
    successfulRetrievalCount = 0
    INDEXER_LOGGER.info(`Reduced chunk size to ${chunkSize}`)
  }

  // SUCCESS: Recover after 3 successes
  if (successfulRetrievalCount >= 3 && chunkSize < rpcDetails.chunkSize) {
    chunkSize = rpcDetails.chunkSize
    successfulRetrievalCount = 0
    INDEXER_LOGGER.info(`Reverted chunk size to ${chunkSize}`)
  }
}
```

**Behavior:**

- On RPC error: halve chunk size (minimum 1 block)
- After 3 consecutive successes: restore original chunk size
- No max retries (continues until successful or stopped)
- Self-healing mechanism

---

### Layer 3: Block Processing Retry

**Purpose:** Handle event processing errors without losing progress

**Code Flow:**

```typescript
// In indexLoop()
try {
  processedBlocks = await processBlocks(
    chunkEvents,
    signer,
    provider,
    chainId,
    startBlock,
    blocksToProcess
  )

  // UPDATE last indexed block on success
  currentBlock = await updateLastIndexedBlockNumber(
    processedBlocks.lastBlock,
    lastIndexedBlock
  )

  emitNewlyIndexedAssets(processedBlocks.foundEvents)
} catch (error) {
  // ERROR: Don't update last block
  INDEXER_LOGGER.error(`Processing failed: ${error.message}`)
  successfulRetrievalCount = 0

  // Wait before retrying same chunk
  await sleep(interval) // 30 seconds

  // Next iteration will retry same chunk (lastBlock not updated)
}
```

**Behavior:**

- On processing error: last indexed block NOT updated
- Next iteration retries the same block range
- Sleep interval before retry (30s default)
- No max retries (infinite until successful)
- Preserves data integrity (no gaps in indexed blocks)

**Critical:** This ensures no events are lost even if processing fails

**⚠️ ISSUE:** Indexer gets **stuck** on a failed block, no progress

---

#### 🔴 PROPOSED: Block Retry Queue with Expiry

**Key Changes:**

1. **Update `lastIndexedBlock` even on failure** (move forward!)
2. Add failed block to retry queue (process separately)
3. Add expiry: maxRetries & expiryDate per block
4. Background processor for retry queue

**Proposed Code:**

```typescript
interface BlockRetryTask {
  chainId: number
  blockNumber: number
  retryCount: number
  maxRetries: number // Default: 5
  lastError: string
  lastRetryAt: number
  expiryDate: number // e.g., 1 week from first failure
  events: ethers.Log[] // Events in this block
}

// In indexLoop()
try {
  processedBlocks = await processBlocks(...)

  // UPDATE last indexed block on success
  currentBlock = await updateLastIndexedBlockNumber(
    processedBlocks.lastBlock,
    lastIndexedBlock
  )

  emitNewlyIndexedAssets(processedBlocks.foundEvents)

} catch (error) {
  INDEXER_LOGGER.error(`Processing block ${startBlock} failed: ${error.message}`)

  // NEW: Add to retry queue
  await this.addBlockToRetryQueue({
    chainId: this.blockchain.chainId,
    blockNumber: startBlock,
    retryCount: 0,
    maxRetries: 5,
    lastError: error.message,
    lastRetryAt: Date.now(),
    expiryDate: Date.now() + (7 * 24 * 60 * 60 * 1000), // 1 week
    events: chunkEvents
  })

  // NEW: Still update lastIndexedBlock (move forward!)
  currentBlock = await updateLastIndexedBlockNumber(
    processedBlocks?.lastBlock || startBlock,
    lastIndexedBlock
  )

  // Indexer continues to next block
}

// Background processor (separate async loop)
async processBlockRetryQueue() {
  while (!this.stopSignal) {
    const retryTasks = await this.getRetryTasksDue()

    for (const task of retryTasks) {
      if (task.retryCount >= task.maxRetries || Date.now() > task.expiryDate) {
        // Max retries or expired → move to failed_blocks table
        await this.moveToFailedBlocks(task)
        continue
      }

      try {
        // Retry processing
        const processed = await processBlocks(
          task.events,
          this.signer,
          this.provider,
          task.chainId,
          task.blockNumber,
          1
        )

        // Success → remove from retry queue
        await this.removeFromRetryQueue(task)
        INDEXER_LOGGER.info(`Block ${task.blockNumber} retry succeeded`)

      } catch (error) {
        // Failed again → update retry count with exponential backoff
        task.retryCount++
        task.lastError = error.message
        task.lastRetryAt = Date.now()

        // Exponential backoff: 1min, 10min, 1hr, 12hr, 1day
        const backoffs = [60000, 600000, 3600000, 43200000, 86400000]
        const nextRetryDelay = backoffs[task.retryCount - 1] || 86400000

        await this.updateRetryTask(task, nextRetryDelay)
        INDEXER_LOGGER.warn(
          `Block ${task.blockNumber} retry ${task.retryCount}/${task.maxRetries} failed, ` +
          `next retry in ${nextRetryDelay / 1000}s`
        )
      }
    }

    await sleep(10000) // Check every 10 seconds
  }
}
```

**Benefits:**

- ✅ Indexer no longer stuck on bad blocks
- ✅ Failed blocks retried in background with exponential backoff
- ✅ Clear failure tracking (`failed_blocks` table)
- ✅ Configurable retry limits
- ✅ Progress continues even with some failures

**Migration Steps:**

1. Add `blockRetryQueue` table to database
2. Add `failed_blocks` table for permanent failures
3. Implement `processBlockRetryQueue()` background loop
4. Update `indexLoop()` to add failures to queue
5. Add monitoring dashboard for retry queue

---

### Layer 4: DDO Decryption Retry

**Purpose:** Handle transient HTTP/network errors during DDO decryption

**Code Flow:**

```typescript
// In BaseProcessor - decryptDDO()
const response = await withRetrial(async () => {
  const { nonce, signature } = await createSignature()

  const payload = {
    transactionId: txId,
    chainId,
    decrypterAddress: keys.ethAddress,
    dataNftAddress: contractAddress,
    signature,
    nonce
  }

  try {
    const res = await axios({
      method: 'post',
      url: `${decryptorURL}/api/services/decrypt`,
      data: payload,
      timeout: 30000,
      validateStatus: (status) => {
        return (status >= 200 && status < 300) || status === 400 || status === 403
      }
    })

    if (res.status === 400 || res.status === 403) {
      // Don't retry client errors
      return res
    }

    if (res.status !== 200 && res.status !== 201) {
      // Retry 5XX errors
      throw new Error(`bProvider exception: ${res.status}`)
    }

    return res
  } catch (err) {
    // Only retry on connection refused
    if (err.code === 'ECONNREFUSED' || err.message.includes('ECONNREFUSED')) {
      INDEXER_LOGGER.error(`Decrypt failed with ECONNREFUSED, retrying...`)
      throw err // Will be retried by withRetrial
    }
    throw err // Other errors not retried
  }
})
```

**withRetrial Implementation:**

```typescript
// Max 5 retries with exponential backoff
async function withRetrial<T>(fn: () => Promise<T>, maxRetries = 5): Promise<T> {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn()
    } catch (error) {
      if (i === maxRetries - 1) throw error
      await sleep(Math.pow(2, i) * 1000) // Exponential backoff
    }
  }
}
```

**Behavior:**

- Max 5 retries with exponential backoff (1s, 2s, 4s, 8s, 16s)
- Only retries ECONNREFUSED errors (connection issues)
- Does NOT retry 400/403 (client errors)
- Retries 5XX errors (server errors)
- 30-second timeout per attempt

**⚠️ ISSUES:**

1. **Only retries ECONNREFUSED** (not P2P, timeouts, 429, etc.)
2. **Blocking** (stops processing during retries)
3. **Embedded in decryption logic** (not reusable)
4. **Short retry window** (16s total, not enough for service outages)

---

### 🔴 PROPOSED: Layer 4 - Event-Level Retry Queue (NEW!)

**Purpose:** Unified, non-blocking retry for ALL event processing errors

**Key Concept:** Move retry logic OUT of event processors and INTO a queue-based system

#### Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                   EVENT PROCESSING FLOW                       │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  Blockchain Event Detected                                   │
│         ↓                                                    │
│  Add to EVENT_QUEUE                                          │
│         ↓                                                    │
│  EventQueueProcessor (async worker pool)                     │
│         ├─ SUCCESS → Log to ddo_logs (status: success)       │
│         │           Update DB                                │
│         │           Remove from queue                        │
│         │                                                    │
│         └─ FAILURE → Log to ddo_logs (status: failed)        │
│                     Classify error (retryable?)              │
│                     Add to EVENT_RETRY_QUEUE                 │
│                                                              │
│  EventRetryProcessor (background loop)                       │
│         ├─ Get tasks due for retry                           │
│         ├─ Check: retryCount < maxRetries                    │
│         ├─ Check: Date.now() < expiryDate                    │
│         ├─ Retry event processing                            │
│         ├─ SUCCESS → Remove from retry queue                 │
│         └─ FAILURE → Increment retryCount                    │
│                     Update nextRetryAt (exponential backoff) │
│                     If maxRetries → Move to dead_letter      │
└──────────────────────────────────────────────────────────────┘
```

#### Data Structures

```typescript
interface EventQueueTask {
  id: string // UUID
  chainId: number
  eventType: string // METADATA_CREATED, ORDER_STARTED, etc.
  eventHash: string
  txHash: string
  blockNumber: number
  eventData: any // Raw event data
  createdAt: number
  status: 'pending' | 'processing' | 'success' | 'failed'
}

interface EventRetryTask {
  id: string
  chainId: number
  did?: string // If known
  eventType: string
  eventHash: string
  txHash: string
  blockNumber: number
  eventData: any
  retryCount: number
  maxRetries: number // Default: 5
  lastError: string
  errorType: ErrorType
  createdAt: number
  lastRetryAt: number
  nextRetryAt: number // Exponential backoff
  expiryDate: number // e.g., 1 week from creation
}

enum ErrorType {
  HTTP_ERROR = 'http_error', // Decrypt service down
  P2P_ERROR = 'p2p_error', // Peer unreachable
  RPC_ERROR = 'rpc_error', // RPC timeout, 429
  DB_ERROR = 'db_error', // Database temp unavailable
  VALIDATION_ERROR = 'validation_error', // Factory check, etc.
  NON_RETRYABLE = 'non_retryable' // Don't retry
}
```

#### Implementation

```typescript
export class EventQueueProcessor {
  private eventQueue: Queue<EventQueueTask>
  private retryQueue: Queue<EventRetryTask>
  private workerPool: number = 5 // Concurrent workers

  async start() {
    // Start worker pool for new events
    for (let i = 0; i < this.workerPool; i++) {
      this.startWorker(i)
    }

    // Start retry processor (background)
    this.startRetryProcessor()
  }

  private async startWorker(workerId: number) {
    while (!this.stopSignal) {
      const task = await this.eventQueue.dequeue()
      if (!task) {
        await sleep(100)
        continue
      }

      try {
        // Update status
        task.status = 'processing'

        // Get event processor
        const processor = getEventProcessor(task.eventType, task.chainId)

        // Process event (no retry logic inside!)
        const result = await processor.processEvent(
          task.eventData,
          task.chainId,
          this.signer,
          this.provider,
          task.eventType
        )

        // Success
        task.status = 'success'
        await this.logToDdoLogs(task, 'success', null, result?.did)

        INDEXER_LOGGER.info(
          `Worker ${workerId}: Processed ${task.eventType} tx ${task.txHash}`
        )
      } catch (error) {
        // Failure
        task.status = 'failed'
        const errorType = this.classifyError(error)

        await this.logToDdoLogs(task, 'failed', error.message, task.eventData.did)

        if (this.isRetryable(errorType)) {
          // Add to retry queue
          await this.addToRetryQueue(task, error, errorType)

          INDEXER_LOGGER.warn(
            `Worker ${workerId}: ${task.eventType} failed (retryable), ` +
              `added to retry queue: ${error.message}`
          )
        } else {
          INDEXER_LOGGER.error(
            `Worker ${workerId}: ${task.eventType} failed (non-retryable): ` +
              error.message
          )
        }
      }
    }
  }

  private async startRetryProcessor() {
    while (!this.stopSignal) {
      try {
        const dueRetries = await this.getRetryTasksDue()

        for (const retryTask of dueRetries) {
          // Check expiry
          if (Date.now() > retryTask.expiryDate) {
            await this.moveToDeadLetter(retryTask, 'Expired')
            continue
          }

          // Check max retries
          if (retryTask.retryCount >= retryTask.maxRetries) {
            await this.moveToDeadLetter(retryTask, 'Max retries exceeded')
            continue
          }

          try {
            // Retry processing
            const processor = getEventProcessor(retryTask.eventType, retryTask.chainId)
            const result = await processor.processEvent(
              retryTask.eventData,
              retryTask.chainId,
              this.signer,
              this.provider,
              retryTask.eventType
            )

            // Success!
            await this.removeFromRetryQueue(retryTask)
            await this.logToDdoLogs(retryTask, 'success', null, result?.did)

            INDEXER_LOGGER.info(
              `Retry succeeded: ${retryTask.eventType} tx ${retryTask.txHash} ` +
                `(attempt ${retryTask.retryCount + 1})`
            )
          } catch (error) {
            // Failed again
            retryTask.retryCount++
            retryTask.lastError = error.message
            retryTask.lastRetryAt = Date.now()

            // Exponential backoff: 10s, 1min, 10min, 1hr, 1 week
            const backoffs = [10000, 60000, 600000, 3600000, 604800000]
            const nextDelay = backoffs[retryTask.retryCount - 1] || 604800000
            retryTask.nextRetryAt = Date.now() + nextDelay

            await this.updateRetryTask(retryTask)
            await this.logToDdoLogs(retryTask, 'retrying', error.message, retryTask.did)

            INDEXER_LOGGER.warn(
              `Retry failed: ${retryTask.eventType} tx ${retryTask.txHash} ` +
                `(attempt ${retryTask.retryCount}/${retryTask.maxRetries}), ` +
                `next retry in ${nextDelay / 1000}s`
            )
          }
        }
      } catch (error) {
        INDEXER_LOGGER.error(`RetryProcessor error: ${error.message}`)
      }

      await sleep(10000) // Check every 10 seconds
    }
  }

  private classifyError(error: Error): ErrorType {
    const msg = error.message.toLowerCase()
    const code = (error as any).code

    // HTTP errors (decrypt service)
    if (code === 'ECONNREFUSED' || msg.includes('econnrefused')) {
      return ErrorType.HTTP_ERROR
    }
    if (code === 'ETIMEDOUT' || msg.includes('timeout')) {
      return ErrorType.HTTP_ERROR
    }
    if (msg.includes('429') || msg.includes('rate limit')) {
      return ErrorType.RPC_ERROR
    }

    // P2P errors
    if (msg.includes('p2p') || msg.includes('peer')) {
      return ErrorType.P2P_ERROR
    }

    // RPC errors
    if (msg.includes('rpc') || msg.includes('provider')) {
      return ErrorType.RPC_ERROR
    }

    // DB errors
    if (msg.includes('database') || msg.includes('elasticsearch')) {
      return ErrorType.DB_ERROR
    }

    // Validation errors (usually non-retryable)
    if (msg.includes('factory') || msg.includes('validation')) {
      return ErrorType.NON_RETRYABLE
    }

    // Default: retryable
    return ErrorType.HTTP_ERROR
  }

  private isRetryable(errorType: ErrorType): boolean {
    return errorType !== ErrorType.NON_RETRYABLE
  }

  private async logToDdoLogs(
    task: EventQueueTask | EventRetryTask,
    status: string,
    error: string | null,
    did?: string
  ) {
    const { ddoLogs } = await getDatabase()
    await ddoLogs.create({
      did: did || 'unknown',
      chainId: task.chainId,
      eventType: task.eventType,
      eventHash: task.eventHash,
      txHash: task.txHash,
      blockNumber: task.blockNumber,
      status,
      error,
      retryCount: 'retryCount' in task ? task.retryCount : 0,
      timestamp: Date.now()
    })
  }
}
```

#### Benefits

**✅ Unified Retry Logic**

- All 12 event types use same retry mechanism
- No more scattered retry code in processors
- Easier to maintain and test

**✅ Non-Blocking**

- Indexer continues processing new events
- Retries happen in background
- No performance impact on main indexing loop

**✅ Retry ALL Error Types**

- HTTP errors (decrypt service down)
- P2P errors (peer unreachable)
- RPC errors (timeout, 429 rate limit)
- DB errors (temp unavailable)
- Removes ECONNREFUSED-only limitation

**✅ Exponential Backoff with Long Window**

- 10s → 1min → 10min → 1hr → 1 week
- Handles long service outages
- Configurable per error type

**✅ Full Observability**

- All events logged to `ddo_logs`
- Track retry count, error messages
- Dead letter queue for permanent failures
- Monitoring dashboard for queue depth

**✅ Decoupled from Event Logic**

- Event processors just process, no retry code
- Queue handles all retry complexity
- Testable in isolation

#### Migration Steps

1. Create `event_queue` table
2. Create `event_retry_queue` table
3. Create `ddo_logs` index (all events, not just metadata)
4. Create `dead_letter_queue` table
5. Implement `EventQueueProcessor` class
6. Update all event processors to remove retry logic
7. Update `ChainIndexer` to enqueue events (not emit)
8. Replace `EventEmitter` with queue system
9. Add monitoring dashboard
10. Update tests

---

### Error Handling Issues (Current)

**Current Problems:**

1. **No Centralized Strategy:**

   - 4 different retry mechanisms
   - No coordination between layers
   - Unclear which mechanism applies when

2. **Silent Failures:**

   - Events skipped with `continue` statement
   - No error tracking or metrics
   - Difficult to diagnose missing events

3. **No Circuit Breaker:**

   - Continues retrying failed RPCs indefinitely
   - Can cause cascade failures
   - No health status tracking

4. **Infinite Retries:**

   - Layer 2 and 3 have no max retries
   - Can get stuck on persistent errors
   - No timeout mechanism

5. **No Error Classification:**
   - All processing errors treated equally
   - No distinction between retryable and permanent errors
   - Bad events can block entire chunk

---

## Failure Scenarios & Recovery

### Scenario 1: RPC Provider Fails

**Current Behavior:**

```
1. retrieveChunkEvents() throws error
2. Caught in indexLoop()
3. Adaptive chunk sizing triggered:
   - chunkSize = floor(chunkSize / 2)
   - Minimum: 1 block
4. Next iteration retries with smaller chunk
5. If all fallback RPCs fail during startup:
   - retryCrawlerWithDelay() retries up to 10 times
   - After max retries → ChainIndexer not started
```

**Recovery:**

- Self-healing via chunk size reduction
- Fallback RPC support (tries alternatives)
- Manual restart required if startup fails after 10 retries

**Issues:**

- No RPC health tracking
- No circuit breaker (keeps retrying forever after startup)
- Can get very slow (chunk size = 1)

---

### Scenario 2: Database Unavailable

**Current Behavior:**

```
1. DB operation fails (read or write)
2. Error thrown and caught in indexLoop()
3. Last indexed block NOT updated
4. Sleep for interval (30s)
5. Next iteration retries same chunk
6. Repeats indefinitely until DB available
```

**Recovery:**

- Automatic retry (infinite)
- Data integrity preserved (no gaps)
- No manual intervention needed (if DB comes back)

**Issues:**

- No DB health check
- No timeout (infinite retry)
- Can process events but not store them (wasted work)
- No notification that DB is down

---

### Scenario 3: Processing Error in Event Handler

**Current Behavior:**

```
1. processor.processEvent() throws error
2. Caught in processBlocks()
3. Error re-thrown
4. Caught in indexLoop()
5. Last indexed block NOT updated
6. Sleep for interval
7. Next iteration retries same chunk
```

**Recovery:**

- Retry same chunk indefinitely
- No max retries
- Eventually succeeds if error is transient

**Issues:**

- Bad event data can block entire chunk
- No skip mechanism for permanently bad events
- No event-level error handling
- All events in chunk must succeed

**Example:** If chunk has 100 events and event #50 is corrupted, the entire chunk retries forever.

---

### Scenario 4: DDO Decryption Fails

**Current Behavior:**

```
1. decryptDDO() throws error after 5 retries
2. Error caught in processEvent()
3. Event skipped
4. ddoState updated with error message
5. Processing continues with next event
```

**Recovery:**

- Event marked as invalid in ddoState
- Other events in chunk processed normally
- No retry (event permanently skipped)

**Issues:**

- Event lost (not retried later)
- No notification mechanism
- Needs manual intervention (reindex tx)

---

### Scenario 5: Validation Failure

**Current Behavior:**

```
1. Validation fails (e.g., not from Ocean Factory)
2. `continue` statement executed
3. Event silently skipped
4. No database update
5. Processing continues with next event
```

**Recovery:**

- No recovery (by design)
- Event intentionally ignored

**Issues:**

- Silent failures (no logging at error level)
- No metrics on skipped events
- Difficult to diagnose why events are missing

---

## Summary

### Event Monitoring Characteristics

**Monitoring:**

- Continuous polling every 30 seconds
- Processes 1-1000 blocks per iteration (adaptive)
- Filter-based event retrieval (12 event types)
- Per-chain monitoring (concurrent via async/await)

**Processing:**

- Sequential within chunk (maintains order)
- Multi-layer validation (factory → metadata → publisher)
- Complex DDO decryption (3 strategies: HTTP, P2P, local)
- Rich metadata enrichment (10-20 RPC calls per metadata event)

**Performance:**

- ~10-20 RPC calls per metadata event
- ~1-2 RPC calls per order/pricing event
- No batching (events processed one at a time)
- No parallelization within chunk

### Error Handling Characteristics

**Retry Mechanisms:**

- Layer 1: Startup (10 retries, recursive, checks DB)
- Layer 2: Adaptive chunk sizing (infinite, self-healing)
- Layer 3: Block processing (infinite, preserves integrity)
- Layer 4: DDO decryption (5 retries, exponential backoff)

**Issues:**

- No centralized retry strategy
- No circuit breaker pattern
- Silent failures on validation
- Infinite retries can cause hangs
- No error classification
- No metrics/observability

### Key Improvement Opportunities

**Event Monitoring:**

- Implement batch RPC calls
- Parallelize event processing (where safe)
- Add event prioritization
- Implement event queue

**Error Handling:**

- Centralize retry logic
- Add circuit breaker pattern
- Implement timeout mechanisms
- Add error classification (retryable vs permanent)
- Skip mechanism for bad events
- Metrics and alerting

**Observability:**

- Track events processed/skipped/failed
- Monitor RPC health per provider
- Track processing latency
- Alert on persistent failures

---

**Document Version:** 2.0  
**Last Updated:** January 27, 2026  
**Status:** Focused on Event Monitoring & Error Handling  
**Word Count:** ~4,500 words (reduced from 12,000+)
