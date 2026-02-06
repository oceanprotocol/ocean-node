# Ocean Node Indexer - Event Monitoring & Error Handling

## Table of Contents

1. [Overview](#overview)
2. [🔴 PROPOSED IMPROVEMENTS (Post-Meeting Changes)](#-proposed-improvements-post-meeting-changes)

---

## Overview

### Current Indexer Architecture

The Ocean Node Indexer is built with the following design principles (see [Architecture.md](./Arhitecture.md) for details):

- **Single-threaded, non-blocking design**: Uses Node.js async/await for concurrent execution across multiple chains
- **ChainIndexer instances**: Each blockchain network is monitored by a dedicated ChainIndexer instance running concurrently via the event loop
- **Event-driven communication**: Components communicate through EventEmitter for clean separation of concerns
- **Efficient I/O handling**: All RPC calls, database operations, and network requests are non-blocking, allowing high concurrency without worker threads

### Proposed Architecture Evolution

The refactoring strategy below maintains the core single-threaded, non-blocking architecture while introducing key improvements:

1. **EventEmitter → Persistent Queues**: Replace synchronous EventEmitter with persistent queue system for better reliability and observability
2. **Event-level retry**: Move retry logic from embedded operations to event-level processing
3. **Enhanced error tracking**: Introduce comprehensive logging via `ddo_logs` index
4. **Per-chain resilience**: Isolate chain failures to prevent cascading issues

These changes preserve the efficient I/O model and concurrent ChainIndexer execution while adding production-grade error handling and monitoring.

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
│                 EVENT ERROR PROCESSING QUEUE                 │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  Event Detected                                              │
│       ↓                                                      │
│  Send to Processor                                           │
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
│    ✓ Non-blocking (doesn't halt chain indexing)              │
│    ✓ Works for ALL error types (HTTP, P2P, RPC, DB)         │
│    ✓ Visible retry state in monitoring                      │
└─────────────────────────────────────────────────────────────┘
```

**Applies to:** All event processors, especially METADATA_CREATED/UPDATED

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
- **Add handler and routes (HTTP + P2P)** to query all information about a DID, transaction, or event
  - Similar to existing `ddo-state` handler but for comprehensive logs
  - Enable querying by: `did`, `txHash`, `blockNumber`, `eventType`
  - Support both HTTP API endpoints and P2P protocol for distributed querying

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
  retryCount: number // Number of retry attempts default 0
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

**Unified Queue-Based Approach for Both Orders and Pricing Events:**

```
IF DDO not found:
  1. Check if DDO exists in database
  2. If not found → add event to pending queue
  3. Store event in ddo_logs with status: 'pending_ddo'
  4. Link event to DID for future reconciliation
  5. When DDO is successfully indexed:
     → Process all pending events for that DID (orders + pricing)
     → Update event status from 'pending_ddo' to 'success' or 'failed'
     → Maintain event order based on blockNumber and logIndex
```

**Queue Structure:**

```typescript
interface PendingEvent {
  did: string
  eventType: string // ORDER_STARTED, ORDER_REUSED, DISPENSER_*, EXCHANGE_*
  chainId: number
  txHash: string
  blockNumber: number
  timestamp: number
  retryCount: number
  queuedAt: number
}
```

**Benefits:**

- **Consistent approach** for all event types (orders + pricing)
- **No data loss** - all events queued and processed eventually
- **Maintains event order** using blockNumber and logIndex
- **Automatic reconciliation** when DDO becomes available
- **Better observability** - track pending events per DID
- **Prevents orphaned records** - only create records when DDO exists

---

### 5. 🚫 MOVE RETRY LOGIC TO ChainIndexer (Block Only That Chain)

**Current Issue:**

- Crawler startup retry in `OceanIndexer`
- Failure blocks **entire node** (all chains)

**Proposed Change:**

- Move `retryCrawlerWithDelay()` → **ChainIndexer**
- Each chain fails independently
- Other chains continue indexing

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
