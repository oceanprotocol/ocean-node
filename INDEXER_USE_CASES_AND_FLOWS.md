# Ocean Node Indexer - Use Cases & Current Flows Documentation

**Created:** January 2026  
**Purpose:** Deep review of all indexer use cases and execution flows for refactoring discussion  
**Status:** Pre-Meeting Preparation Document

---

## Table of Contents

1. [Overview](#overview)
2. [Use Cases](#use-cases)
3. [Event Monitoring Deep Dive](#event-monitoring-deep-dive)
   - How Event Monitoring Works
   - Event Identification & Routing
   - Detailed Event Handling Per Type
   - Event Processing Pipeline Summary
   - Performance Characteristics
4. [Current Flows - Detailed Analysis](#current-flows-detailed-analysis)
5. [Event Processing Flows](#event-processing-flows)
6. [Error Handling & Retry Mechanisms](#error-handling--retry-mechanisms)
7. [Async/Await Architecture & Concurrency](#asyncawait-architecture--concurrency)
8. [Failure Scenarios & Recovery](#failure-scenarios--recovery)
9. [State Management](#state-management)
10. [Observations & Pain Points](#observations--pain-points)
11. [Summary](#summary)

---

## Overview

The Ocean Node Indexer is responsible for:

- Continuously monitoring multiple blockchain networks for Ocean Protocol events
- Processing and validating events (metadata, orders, pricing)
- Storing processed data in databases (Elasticsearch/Typesense)
- Managing indexing state per chain
- Supporting reindexing operations (full chain or specific transactions)
- Emitting events for downstream consumers

**Architecture Summary:**

- One `OceanIndexer` instance (orchestrator)
- One `ChainIndexer` instance per supported blockchain network
- All operations use async/await (no worker threads)
- Event-driven communication via `EventEmitter`
- Event processors for each event type (12 different event types)
- Database layer for persistence (Elasticsearch/Typesense)
- Job queue for admin commands
- RPC client with fallback support

---

## Use Cases

### UC1: Normal Block Crawling (Continuous Indexing)

**Description:** Continuously monitor blockchain networks and process new blocks containing Ocean Protocol events.

**Trigger:** Automatic on node startup, runs indefinitely

**Actors:** System (automatic)

**Preconditions:**

- Node is running
- Database is accessible
- RPC providers are configured
- Supported chains are configured

**Main Flow:**

1. Node starts → `OceanIndexer` constructor called
2. `startThreads()` invoked
3. For each supported chain:
   - Validate RPC connection (with fallback support)
   - Create `Blockchain` instance
   - Create `ChainIndexer` instance
   - Call `indexer.start()` (non-blocking, runs in background)
4. Each `ChainIndexer` runs asynchronously:
   - Enters infinite `indexLoop()` using async/await
   - Gets last indexed block from DB
   - Gets current network height via RPC
   - Calculates blocks to process (respects chunk size)
   - **Event Retrieval:** Calls `provider.getLogs()` with Ocean Protocol event topic filters
   - **Event Processing:** Routes events to appropriate processors
   - **Database Updates:** Stores processed data
   - Updates last indexed block
   - Sleeps for interval (default 30s)
   - Repeats until stop signal

**Postconditions:**

- All supported chains are being indexed concurrently
- Events are being processed and stored in real-time
- Last indexed block is updated per chain
- Event emitters notify downstream consumers

---

### UC2: Process Metadata Created Event

**Description:** Process a `MetadataCreated` event, validate it, decrypt DDO, and store it.

**Trigger:** Event detected during block crawling

**Actors:** System (automatic)

**Preconditions:**

- Block crawling is active
- Event log found in block range
- Event matches `METADATA_CREATED` signature

**Main Flow:**

1. Event log detected in `retrieveChunkEvents()`
2. Event routed to `processChunkLogs()`
3. Event identified as `METADATA_CREATED`
4. **Validation Phase:**
   - Check if metadata validation is enabled
   - Get transaction receipt
   - Extract `MetadataValidated` events from receipt
   - Validate validators against `allowedValidators` list
   - If `allowedValidatorsList` configured:
     - For each access list contract:
       - Check `balanceOf()` for each validator
       - Require at least one validator has balance > 0
   - If validation fails → skip event (continue to next)
5. **Processing Phase:**
   - Get `MetadataEventProcessor` instance
   - Call `processor.processEvent()`
   - Check if NFT was deployed by Ocean Factory
   - Decode event data from transaction receipt
   - **Decrypt DDO:**
     - Try HTTP decryption (from metadata URL)
     - Try P2P decryption (from libp2p network)
     - Try local decryption (if available)
     - Handle nonce management
     - Verify signatures
   - Validate DDO hash matches generated DID
   - Check authorized publishers
   - Get NFT info (name, symbol, owner, etc.)
   - Get token info (datatoken addresses, names, symbols)
   - Get pricing stats (dispensers, exchanges, rates)
   - Check purgatory status
   - Check policy server
   - Build DDO with `indexedMetadata`
6. **Storage Phase:**
   - Update or create DDO in database
   - Update DDO state (validation tracking)
   - Emit `METADATA_CREATED` event to parent thread
   - Parent thread emits to `INDEXER_DDO_EVENT_EMITTER`

**Postconditions:**

- DDO stored in database
- DDO state updated
- Event emitted for listeners

**Error Handling:**

- Validation failures → event skipped, logged
- Decryption failures → event skipped, DDO state marked invalid
- Database failures → error logged, event not stored

---

### UC3: Process Metadata Updated Event

**Description:** Process a `MetadataUpdated` event, update existing DDO.

**Trigger:** Event detected during block crawling

**Actors:** System (automatic)

**Preconditions:**

- Block crawling is active
- Event log found
- Event matches `METADATA_UPDATED` signature

**Main Flow:**

1. Similar to UC2 (Metadata Created)
2. Uses same `MetadataEventProcessor`
3. Validation phase identical
4. Processing phase:
   - Retrieves existing DDO from database
   - Updates DDO with new metadata
   - Merges pricing and order stats
5. Storage phase:
   - Updates DDO in database (not creates)
   - Updates DDO state
   - Emits `METADATA_UPDATED` event

**Postconditions:**

- DDO updated in database
- Event emitted

---

### UC4: Process Order Started Event

**Description:** Process an `OrderStarted` event, update order count and create order record.

**Trigger:** Event detected during block crawling

**Actors:** System (automatic)

**Preconditions:**

- Block crawling is active
- Event log found
- Event matches `ORDER_STARTED` signature

**Main Flow:**

1. Event log detected
2. Routed to `OrderStartedEventProcessor`
3. Decode event data:
   - Consumer address
   - Payer address
   - Datatoken address
   - NFT address
   - Service ID
   - Start order ID
4. Retrieve DDO from database
5. Update order count in DDO stats
6. Create order record in order database
7. Update DDO in database
8. Emit `ORDER_STARTED` event

**Postconditions:**

- Order record created
- DDO updated with order count
- Event emitted

---

### UC5: Process Pricing Events (Dispenser/Exchange)

**Description:** Process dispenser or exchange events (created, activated, deactivated, rate changed).

**Trigger:** Event detected during block crawling

**Actors:** System (automatic)

**Preconditions:**

- Block crawling is active
- Event log found
- Event matches pricing event signature

**Main Flow:**

1. Event identified (DispenserCreated, DispenserActivated, ExchangeActivated, etc.)
2. Routed to appropriate processor
3. Decode event data
4. Retrieve DDO from database
5. Update pricing arrays in DDO stats
6. Update DDO in database
7. Emit event (if applicable)

**Postconditions:**

- DDO pricing info updated
- Event emitted

---

### UC6: Reindex Specific Transaction

**Description:** Re-process a specific transaction that was already indexed (e.g., after bug fix).

**Trigger:** Admin command via API

**Actors:** Admin/Operator

**Preconditions:**

- Indexer is running
- ChainIndexer exists for chain
- Transaction hash is valid

**Main Flow:**

1. Admin calls `reindexTx` API endpoint
2. `ReindexTxHandler` validates command:
   - Validates chainId is supported
   - Validates txId format
3. `indexer.addReindexTask()` called on OceanIndexer
4. Job created and added to `JOBS_QUEUE`
5. Task added to `INDEXING_QUEUE` (OceanIndexer instance)
6. OceanIndexer calls `chainIndexer.addReindexTask(task)`
7. ChainIndexer adds task to its `reindexQueue` (instance property)
8. During next indexing loop iteration:
   - `processReindexQueue()` called
   - Task shifted from queue (FIFO)
   - Get transaction receipt from RPC: `provider.getTransactionReceipt(txId)`
   - Extract logs from receipt (all logs or specific index)
   - Process logs using `processChunkLogs(logs, signer, provider, chainId)`
   - ChainIndexer emits `REINDEX_QUEUE_POP` event
9. OceanIndexer event listener:
   - Removes task from `INDEXING_QUEUE`
   - Updates job status to SUCCESS via `updateJobStatus()`
   - Emits to `INDEXER_CRAWLING_EVENT_EMITTER`

**Postconditions:**

- Transaction re-processed
- DDO updated in database
- Job status updated (DELIVERED → PENDING → SUCCESS)
- Event emitted to downstream consumers

**Error Handling:**

- If receipt not available yet → task remains in queue, retried next iteration
- If processing fails → error logged, task removed from queue (lost)
- If ChainIndexer not found → error returned, job not created
- No retry limit → task processed until successful or error

---

### UC7: Reindex Entire Chain

**Description:** Reset indexing for a chain and re-index from a specific block (or deployment block).

**Trigger:** Admin command via API

**Actors:** Admin/Operator

**Preconditions:**

- Indexer is running
- Chain is supported
- Optional: block number provided

**Main Flow:**

1. Admin calls `reindexChain` API endpoint
2. `ReindexChainHandler` validates command:
   - Validates chainId is supported
   - Validates block number (if provided)
3. `indexer.resetCrawling(chainId, blockNumber)` called on OceanIndexer
4. Check if ChainIndexer is running:
   - Get indexer from `indexers.get(chainId)`
   - If not running → call `startThread(chainId)` to create and start
   - If start fails → return error
5. Job created and added to `JOBS_QUEUE`
6. OceanIndexer calls `chainIndexer.triggerReindexChain(blockNumber)`
7. ChainIndexer calculates target block:
   - Get deployment block for chain
   - If blockNumber provided and > deployment block → use it
   - Else if `startBlock` configured and > deployment block → use it
   - Else → use deployment block
8. Set `this.reindexBlock` to target block
9. During next indexing loop iteration:
   - Check `this.reindexBlock !== null`
   - Get network height
   - Call `this.reindexChain(currentBlock, networkHeight)`
   - Validate reindexBlock < networkHeight
   - Update last indexed block: `updateLastIndexedBlockNumber(reindexBlock)`
   - Delete all assets: `deleteAllAssetsFromChain()`
   - If deletion fails → revert last block: `updateLastIndexedBlockNumber(currentBlock)`
   - Clear `this.reindexBlock = null`
   - ChainIndexer emits `REINDEX_CHAIN` event
10. OceanIndexer event listener:
    - Updates job status (SUCCESS or FAILURE) via `updateJobStatus()`
    - Emits to `INDEXER_CRAWLING_EVENT_EMITTER`

**Postconditions:**

- All assets deleted from chain (database cleared)
- Last indexed block reset to target block
- Normal crawling resumes from reset block
- Job status updated (DELIVERED → PENDING → SUCCESS/FAILURE)
- Downstream consumers notified

**Error Handling:**

- Invalid block (> network height) → error logged, reindex aborted, reindexBlock cleared
- Deletion failure → last block reverted to currentBlock, reindex fails, returns false
- Update block failure → error logged, reindex aborted, returns false
- ChainIndexer not found/can't start → error returned, job not created
- Database errors → error logged, manual retry needed

---

### UC8: Version-Based Auto-Reindexing

**Description:** Automatically trigger reindexing when node version requires it.

**Trigger:** Node startup, before starting threads

**Actors:** System (automatic)

**Preconditions:**

- Node is starting
- Database is accessible
- Version check enabled

**Main Flow:**

1. `startThreads()` called
2. `checkAndTriggerReindexing()` called first
3. Get current node version from `process.env.npm_package_version`
4. Get database version from `sqliteConfig`
5. Compare with `MIN_REQUIRED_VERSION` ('0.2.2')
6. If reindexing needed:
   - For each supported chain:
     - Delete all assets from chain
     - Reset last indexed block to deployment block
     - Log results
   - Update database version to current
7. Continue with normal thread startup

**Postconditions:**

- Chains reindexed if needed
- Database version updated
- Normal indexing resumes

**Error Handling:**

- Database not reachable → reindexing skipped, error logged
- Deletion failures → error logged per chain, continues with other chains

---

### UC9: Stop Indexing for Chain

**Description:** Gracefully stop indexing for a specific chain.

**Trigger:** Admin command or node shutdown

**Actors:** Admin/System

**Preconditions:**

- Indexer is running
- Chain is being indexed

**Main Flow:**

1. `indexer.stopThread(chainId)` called on OceanIndexer
2. Get ChainIndexer: `indexer = indexers.get(chainId)`
3. If indexer exists:
   - Call `await indexer.stop()` (async, waits for completion)
   - ChainIndexer internally:
     - Sets `this.stopSignal = true`
     - Logs: "Stopping indexer for chain X, waiting for graceful shutdown..."
     - Waits for loop to exit: `while (this.isRunning) await sleep(100)`
     - Indexing loop checks `stopSignal` on each iteration
     - When `stopSignal` is true → breaks loop
     - Sets `this.isRunning = false`
     - Logs: "Chain X indexer stopped"
   - OceanIndexer:
     - Removes from map: `indexers.delete(chainId)`
     - Logs: "Stopped indexer for chain X"
4. Else:
   - Error logged: "Unable to find running indexer for chain X"

**Postconditions:**

- ChainIndexer stopped gracefully
- Indexing loop exited cleanly
- Instance removed from indexers map
- No more indexing for chain
- Any in-progress iteration completes before stop

**Benefits of Current Implementation:**

- Graceful shutdown (waits for current iteration to complete)
- No abrupt termination mid-processing
- Clean state (last indexed block updated)
- Async/await makes shutdown explicit and reliable

---

### UC10: Handle RPC Connection Failures

**Description:** Handle RPC provider failures and fallback to alternative providers.

**Trigger:** RPC call failure during block retrieval

**Actors:** System (automatic)

**Preconditions:**

- Block crawling active
- RPC call fails

**Main Flow:**

1. `retrieveChunkEvents()` called
2. `provider.getLogs()` fails
3. Exception caught in `processNetworkData()`
4. Error logged
5. **Adaptive chunk sizing:**
   - `chunkSize = Math.floor(chunkSize / 2)`
   - Minimum chunk size = 1
   - `successfulRetrievalCount` reset to 0
6. Next iteration uses smaller chunk
7. After 3 successful retrievals:
   - Revert to original `chunkSize`
8. **RPC Fallback (during startup):**
   - `startCrawler()` checks network readiness
   - If not ready → `tryFallbackRPCs()` called
   - Tries each fallback RPC in order
   - If any succeeds → use that provider
9. **Retry Logic:**
   - `retryCrawlerWithDelay()` called during startup
   - Max 10 retries
   - Retry interval = `max(fallbackRPCs.length * 3000, 5000)`
   - Recursive retry on failure

**Postconditions:**

- Smaller chunks processed
- Alternative RPC used if available
- Crawling continues

**Error Handling:**

- All RPCs fail → retry up to 10 times
- After max retries → worker thread not started
- Database check → if DB unreachable, give up

---

## Event Monitoring Deep Dive

### How Event Monitoring Works

The Ocean Node Indexer monitors blockchain events using a sophisticated multi-step process that ensures no events are missed while maintaining performance and reliability.

#### 1. Event Discovery Process

**Location:** `ChainIndexer.ts` - `indexLoop()` → `retrieveChunkEvents()`

**Step-by-Step:**

```
1. ChainIndexer maintains current position (lastIndexedBlock)
   ├─> Retrieved from database on each iteration
   └─> Persisted after successful processing

2. Get network height from RPC
   ├─> Current blockchain tip
   └─> Determines how many blocks to process

3. Calculate chunk to process
   ├─> remainingBlocks = networkHeight - lastIndexedBlock
   ├─> blocksToProcess = min(chunkSize, remainingBlocks)
   └─> Default chunkSize from config (typically 100-1000 blocks)

4. Call provider.getLogs() with filters
   ├─> fromBlock: lastIndexedBlock + 1
   ├─> toBlock: lastIndexedBlock + blocksToProcess
   ├─> topics: [ALL_OCEAN_EVENT_HASHES]
   └─> Returns array of Log objects

5. Process logs through pipeline
   ├─> Identify event type by topic hash
   ├─> Route to appropriate processor
   ├─> Validate and transform
   └─> Store in database

6. Update lastIndexedBlock
   └─> Only updated on successful processing
```

**Event Topic Filtering:**

The indexer listens for these event signatures (identified by topic[0]):

```typescript
EVENT_HASHES = {
  '0x5463569dcc320958360074a9ab27e809e8a6942c394fb151d139b5f7b4ecb1bd': MetadataCreated
  '0x127c3f87d5f806ee52e3045f6c9c39e0ef0a3c96c0c75f3e18b84917b88dc2b3': MetadataUpdated
  '0x1f432bc9a19ebfc7c5e1cb25e4faeea2f7e162a3af75ae6fd7f4d7ba24d93052': MetadataState
  '0xa0e0424cb5b1293c12c34b4a4867cc2a426e665be57d01dfa48aaaa0c90ec7c0': OrderStarted
  '0x6e0dd7434b30641fa1c2e87c22ac88fc95c44b50f8b0c24b8c01c3ac88a41f65': OrderReused
  '0xdcda18b5bc4d3564ccef3d80910ad33cc3e2bb60f09e0d1be21501f97a71ea51': DispenserCreated
  '0x6e0cf36da82bc089a41b8ba5a4aaa4e6f4f3c36a2ba0e47f8d4b5bd4c82b17ab': DispenserActivated
  '0x53ae36d41e99f27c63c6c8d7d1c8fd58e1f1dbc7d5d9c0d8e2f6d8a5c4b3a2b1': DispenserDeactivated
  '0xdcda18b5bc4d3564ccef3d80910ad33cc3e2bb60f09e0d1be21501f97a71ea52': ExchangeCreated
  '0x6e0cf36da82bc089a41b8ba5a4aaa4e6f4f3c36a2ba0e47f8d4b5bd4c82b17ac': ExchangeActivated
  '0x53ae36d41e99f27c63c6c8d7d1c8fd58e1f1dbc7d5d9c0d8e2f6d8a5c4b3a2b2': ExchangeDeactivated
  '0x7b3b3f0f3f3f3f3f3f3f3f3f3f3f3f3f3f3f3f3f3f3f3f3f3f3f3f3f3f3f3f3f': ExchangeRateChanged
}
```

#### 2. Event Identification & Routing

**Location:** `processor.ts` - `processChunkLogs()`

When logs are retrieved, each log goes through:

```
For each log in retrieved logs:
  │
  ├─> 1. Extract topic[0] (event signature hash)
  │
  ├─> 2. Look up in EVENT_HASHES mapping
  │      └─> Identifies event type (e.g., METADATA_CREATED)
  │
  ├─> 3. Check if Ocean Protocol event
  │      └─> If not recognized → skip
  │
  ├─> 4. Apply event-specific validation
  │      └─> For metadata events: check validators
  │      └─> For other events: basic validation
  │
  ├─> 5. Get or create processor instance
  │      └─> Cached per (eventType + chainId)
  │
  ├─> 6. Call processor.processEvent()
  │      └─> Event-specific handling logic
  │
  └─> 7. Store result for batch emission
```

### Detailed Event Handling Per Type

#### A. METADATA_CREATED Event

**Trigger:** When a new data asset is published on-chain

**On-Chain Event Data:**

- `owner` - Publisher address
- `flags` - Encryption flags
- `metadata` - Encrypted/compressed DDO
- `metadataHash` - SHA256 hash of DDO
- `validateTime` - Timestamp

**Processing Steps:**

```
MetadataEventProcessor.processEvent():
  │
  ├─> 1. FACTORY VALIDATION
  │   └─> wasNFTDeployedByOurFactory()
  │       ├─> Instantiate ERC721Factory contract
  │       ├─> Call getCurrentNFTCount()
  │       ├─> Loop through all NFTs
  │       ├─> Check if NFT address matches
  │       └─> If not deployed by Ocean → REJECT, return null
  │
  ├─> 2. DECODE EVENT DATA
  │   └─> getEventData(provider, txHash, ERC721Template.abi, eventName)
  │       ├─> Fetch transaction receipt
  │       ├─> Find log matching event hash
  │       ├─> Parse with contract ABI
  │       └─> Extract: owner, flags, metadata, metadataHash, etc.
  │
  ├─> 3. DDO DECRYPTION (Complex, 400+ lines)
  │   └─> decryptDDO(decryptorURL, flag, owner, nftAddress, chainId, txId, metadataHash, metadata)
  │       │
  │       ├─> Check flag bit 2 (encrypted vs compressed)
  │       │
  │       ├─> IF ENCRYPTED (flag & 2 != 0):
  │       │   ├─> Determine decryptor type:
  │       │   │   ├─> HTTP URL → Call external provider
  │       │   │   ├─> PeerID → Call via P2P network
  │       │   │   └─> Local node → Internal handler
  │       │   │
  │       │   ├─> Build signature:
  │       │   │   ├─> Get nonce from provider
  │       │   │   ├─> Create message: txId + ethAddress + chainId + nonce
  │       │   │   ├─> Hash with solidityPackedKeccak256
  │       │   │   ├─> Sign with wallet
  │       │   │   └─> Verify signature
  │       │   │
  │       │   ├─> Make decrypt request:
  │       │   │   ├─> POST /api/services/decrypt
  │       │   │   ├─> Payload: { transactionId, chainId, decrypterAddress, dataNftAddress, signature, nonce }
  │       │   │   ├─> Timeout: 30 seconds
  │       │   │   ├─> Retry up to 5 times (withRetrial)
  │       │   │   └─> Handle 400/403 errors (no retry)
  │       │   │
  │       │   └─> Validate response hash:
  │       │       ├─> create256Hash(response.data)
  │       │       ├─> Compare with metadataHash
  │       │       └─> If mismatch → REJECT
  │       │
  │       └─> IF COMPRESSED (flag & 2 == 0):
  │           ├─> getBytes(metadata)
  │           ├─> toUtf8String(byteArray)
  │           └─> JSON.parse(utf8String)
  │
  ├─> 4. VALIDATE DDO ID
  │   └─> Check ddo.id matches makeDid(nftAddress, chainId)
  │       └─> If mismatch → REJECT, update ddoState with error
  │
  ├─> 5. CHECK AUTHORIZED PUBLISHERS
  │   └─> If authorizedPublishers configured:
  │       └─> Check if owner in authorizedPublishers list
  │           └─> If not → REJECT, update ddoState
  │
  ├─> 6. FETCH NFT INFORMATION
  │   └─> getNFTInfo(nftAddress, signer, owner, timestamp)
  │       ├─> Instantiate NFT contract
  │       ├─> Call getMetaData() → get state
  │       ├─> Call getId() → get token ID
  │       ├─> Call tokenURI(id) → get URI
  │       ├─> Call name() → get name
  │       ├─> Call symbol() → get symbol
  │       └─> Return: { state, address, name, symbol, owner, created, tokenURI }
  │
  ├─> 7. FETCH TOKEN INFORMATION
  │   └─> getTokenInfo(ddo.services, signer)
  │       └─> For each service in DDO:
  │           ├─> Instantiate datatoken contract (ERC20)
  │           ├─> Call name() → get name
  │           ├─> Call symbol() → get symbol
  │           └─> Collect: { address, name, symbol, serviceId }
  │
  ├─> 8. FETCH PRICING INFORMATION
  │   └─> getPricingStatsForDddo(nftAddress, signer, provider, chainId)
  │       ├─> Get all datatokens from NFT
  │       ├─> For each datatoken:
  │       │   ├─> Check dispenser:
  │       │   │   ├─> Get Dispenser contract address
  │       │   │   ├─> Call status(datatoken, owner)
  │       │   │   └─> If active → add to prices array
  │       │   └─> Check exchange:
  │       │       ├─> Get FixedRateExchange address
  │       │       ├─> Call getAllExchanges()
  │       │       ├─> Filter by datatoken
  │       │       └─> If active → add rate to prices array
  │       └─> Return pricing arrays per service
  │
  ├─> 9. CHECK PURGATORY STATUS
  │   └─> Purgatory.check(nftAddress, chainId, account)
  │       ├─> Check if NFT is in purgatory list
  │       ├─> Check if account is in purgatory list
  │       └─> Return: { state: boolean }
  │
  ├─> 10. CHECK POLICY SERVER
  │    └─> If policyServer configured:
  │        ├─> POST to policy server endpoint
  │        ├─> Payload: { did, chain, nft }
  │        └─> Check response (approve/deny)
  │
  ├─> 11. BUILD INDEXED METADATA
  │    └─> Construct indexedMetadata object:
  │        ├─> nft: { state, address, name, symbol, owner, created, tokenURI }
  │        ├─> event: { txid, from, contract, block, datetime }
  │        ├─> stats: [{
  │        │     datatokenAddress,
  │        │     name,
  │        │     symbol,
  │        │     serviceId,
  │        │     orders: 0,  // Initial count
  │        │     prices: [{ type: 'dispenser|exchange', price, contract, token, exchangeId }]
  │        │   }]
  │        └─> purgatory: { state }
  │
  ├─> 12. STORE IN DATABASE
  │    └─> createOrUpdateDDO(ddo, method)
  │        ├─> ddoDatabase.create(ddo)  // New asset
  │        ├─> ddoState.create(chainId, did, nftAddress, txId, valid=true)
  │        └─> Return saved DDO
  │
  └─> 13. EMIT EVENT
      └─> Event emitted to INDEXER_DDO_EVENT_EMITTER
          └─> Downstream consumers notified (API, cache, webhooks)
```

**Database Operations:**

- INSERT into `ddo` table (Elasticsearch/Typesense)
- INSERT into `ddoState` table (validation tracking)

**Error Handling:**

- Factory validation fail → skip, log error
- Decryption fail → skip, update ddoState with error
- DDO ID mismatch → skip, update ddoState
- Publisher not authorized → skip, update ddoState
- Database fail → error logged, event not stored

---

#### B. METADATA_UPDATED Event

**Trigger:** When asset metadata is updated on-chain

**Processing Steps:**

```
MetadataEventProcessor.processEvent():
  │
  ├─> 1-10. Same as METADATA_CREATED
  │          (validation, decryption, fetching info)
  │
  ├─> 11. RETRIEVE EXISTING DDO
  │    └─> ddoDatabase.retrieve(ddo.id)
  │
  ├─> 12. MERGE DDO DATA
  │    └─> Merge new metadata with existing:
  │        ├─> Update: metadata, services, credentials
  │        ├─> Preserve: existing order counts
  │        ├─> Merge: pricing arrays (add new, keep existing)
  │        └─> Update: indexedMetadata.event (new tx, block, datetime)
  │
  ├─> 13. UPDATE DATABASE
  │    └─> ddoDatabase.update(mergedDdo)
  │
  └─> 14. EMIT EVENT
      └─> METADATA_UPDATED event emitted
```

**Key Difference from CREATED:**

- Uses `update()` instead of `create()`
- Merges with existing data instead of creating new
- Preserves order statistics

---

#### C. ORDER_STARTED Event

**Trigger:** When someone purchases/orders access to a data asset

**On-Chain Event Data:**

- `consumer` - Buyer address
- `payer` - Payment source address
- `datatoken` - Datatoken address
- `serviceId` - Service identifier
- `amount` - Amount paid
- `timestamp` - Order time

**Processing Steps:**

```
OrderStartedEventProcessor.processEvent():
  │
  ├─> 1. DECODE EVENT DATA
  │   └─> Parse event args:
  │       ├─> consumer
  │       ├─> payer
  │       ├─> datatoken
  │       ├─> amount
  │       └─> timestamp
  │
  ├─> 2. FIND NFT ADDRESS
  │   └─> Query datatoken contract:
  │       ├─> Instantiate ERC20 contract
  │       ├─> Call getERC721Address()
  │       └─> Get NFT address
  │
  ├─> 3. BUILD DID
  │   └─> did = makeDid(nftAddress, chainId)
  │
  ├─> 4. RETRIEVE DDO
  │   └─> ddoDatabase.retrieve(did)
  │       └─> If not found → error, cannot update
  │
  ├─> 5. UPDATE ORDER COUNT
  │   └─> Find matching service in ddo.stats:
  │       ├─> Match by datatokenAddress
  │       └─> Increment orders count
  │
  ├─> 6. CREATE ORDER RECORD
  │   └─> orderDatabase.create({
  │       type: 'startOrder',
  │       timestamp,
  │       consumer,
  │       payer,
  │       datatokenAddress,
  │       nftAddress,
  │       did,
  │       startOrderId: txHash
  │     })
  │
  ├─> 7. UPDATE DDO
  │   └─> ddoDatabase.update(ddo)
  │
  └─> 8. EMIT EVENT
      └─> ORDER_STARTED event emitted
```

**Database Operations:**

- UPDATE `ddo` table (increment order count)
- INSERT into `order` table (new order record)

---

#### D. DISPENSER_ACTIVATED Event

**Trigger:** When a free dispenser is activated for a datatoken

**On-Chain Event Data:**

- `datatoken` - Datatoken address
- `owner` - Dispenser owner
- `dispenserId` - Unique identifier

**Processing Steps:**

```
DispenserActivatedEventProcessor.processEvent():
  │
  ├─> 1. DECODE EVENT DATA
  │   └─> Extract: datatoken, owner, dispenserId
  │
  ├─> 2. FIND NFT ADDRESS
  │   └─> Query datatoken contract → getNFTAddress()
  │
  ├─> 3. RETRIEVE DDO
  │   └─> ddoDatabase.retrieve(did)
  │
  ├─> 4. UPDATE PRICING ARRAY
  │   └─> Find service by datatokenAddress:
  │       └─> Add to prices array:
  │           {
  │             type: 'dispenser',
  │             price: '0',  // Free
  │             contract: dispenserAddress,
  │             token: ZeroAddress,
  │             dispenserId
  │           }
  │
  ├─> 5. UPDATE DDO
  │   └─> ddoDatabase.update(ddo)
  │
  └─> 6. EMIT EVENT
      └─> DISPENSER_ACTIVATED event emitted
```

---

#### E. EXCHANGE_RATE_CHANGED Event

**Trigger:** When exchange rate is updated for a fixed-rate exchange

**On-Chain Event Data:**

- `exchangeId` - Exchange identifier
- `baseToken` - Base token address
- `datatoken` - Datatoken address
- `newRate` - New exchange rate

**Processing Steps:**

```
ExchangeRateChangedEventProcessor.processEvent():
  │
  ├─> 1. DECODE EVENT DATA
  │   └─> Extract: exchangeId, baseToken, datatoken, newRate
  │
  ├─> 2. FIND NFT ADDRESS
  │   └─> Query datatoken contract → getNFTAddress()
  │
  ├─> 3. RETRIEVE DDO
  │   └─> ddoDatabase.retrieve(did)
  │
  ├─> 4. UPDATE PRICING ARRAY
  │   └─> Find service by datatokenAddress:
  │       └─> Find exchange entry by exchangeId:
  │           └─> Update price: newRate
  │
  ├─> 5. UPDATE DDO
  │   └─> ddoDatabase.update(ddo)
  │
  └─> 6. EMIT EVENT
      └─> EXCHANGE_RATE_CHANGED event emitted
```

---

### Event Processing Pipeline Summary

```
┌─────────────────────────────────────────────────────────────────────┐
│                    CONTINUOUS MONITORING LOOP                        │
│                                                                      │
│  ChainIndexer (per chain) running async/await:                      │
│    while (!stopSignal):                                              │
│      ├─> Get last indexed block from DB                             │
│      ├─> Get network height from RPC                                │
│      ├─> Calculate chunk size (adaptive)                            │
│      ├─> provider.getLogs(fromBlock, toBlock, topics)              │
│      │   └─> Returns: Log[] (raw blockchain logs)                   │
│      │                                                               │
│      └─> processChunkLogs(logs, signer, provider, chainId)         │
│          │                                                           │
│          └─> For each log:                                          │
│              ├─> Identify event by topic[0]                         │
│              ├─> Check if Ocean Protocol event                      │
│              ├─> Apply validation (if metadata event)               │
│              ├─> Route to processor                                 │
│              │   └─> processEvent() called                          │
│              │       ├─> Decode on-chain data                       │
│              │       ├─> Fetch additional data (RPC calls)          │
│              │       ├─> Transform to domain model                  │
│              │       └─> Store in database                          │
│              └─> Collect result                                     │
│                                                                      │
│      ├─> Update last indexed block                                  │
│      ├─> Emit events to INDEXER_DDO_EVENT_EMITTER                  │
│      └─> Sleep for interval (30s default)                           │
└─────────────────────────────────────────────────────────────────────┘

                              ↓

┌─────────────────────────────────────────────────────────────────────┐
│                     EVENT EMITTER LISTENERS                          │
│                                                                      │
│  Downstream consumers subscribe to events:                          │
│    ├─> API endpoints (query fresh data)                             │
│    ├─> Cache invalidation (update cache)                            │
│    ├─> Webhooks (notify external services)                          │
│    ├─> Analytics (track metrics)                                    │
│    └─> P2P network (advertise new assets)                           │
└─────────────────────────────────────────────────────────────────────┘
```

### Performance Characteristics

**Event Monitoring Frequency:**

- Check for new blocks every 30 seconds (configurable)
- Process up to `chunkSize` blocks per iteration (default 100-1000)
- Adaptive chunk sizing on RPC errors (halves on failure, recovers after 3 successes)

**Concurrency:**

- All chains monitored concurrently (async/await)
- No worker threads (optimal for I/O-bound operations)
- Events within a chunk processed serially (to maintain order)

**RPC Call Patterns:**

- 1 call to get network height per iteration
- 1 call to getLogs per chunk
- Per metadata event:
  - 1-2 calls for transaction receipt
  - 1+ calls for factory validation
  - 1+ calls for NFT info (name, symbol, state)
  - 1+ calls for token info (per datatoken)
  - Multiple calls for pricing info (dispensers, exchanges)
  - Optional: access list checks (1+ per validator)

**Database Operations:**

- 1 read to get last indexed block
- 1 write to update last indexed block
- Per event: 1-2 writes (ddo + ddoState/order)
- No batching currently implemented

**Failure Recovery:**

- RPC failure → reduce chunk size, retry
- Processing failure → don't update last block, retry same chunk
- Validation failure → skip event, continue with next
- Database failure → error logged, event not stored

---

## Current Flows - Detailed Analysis

### Flow 1: Initialization & Startup

**Location:** `index.ts` - `OceanIndexer` constructor and `startThreads()`

**Sequence:**

```
1. OceanIndexer constructor called
   ├─> Initialize database reference
   ├─> Store supported networks (RPCS config)
   ├─> Initialize INDEXING_QUEUE = []
   ├─> Create Map<chainId, ChainIndexer> for indexers
   └─> Call startThreads()

2. startThreads()
   ├─> checkAndTriggerReindexing() [UC8]
   │   ├─> Get current version from process.env
   │   ├─> Get DB version from sqliteConfig
   │   ├─> Compare with MIN_REQUIRED_VERSION
   │   ├─> If reindex needed:
   │   │   ├─> For each chain:
   │   │   │   ├─> Delete all assets: ddo.deleteAllAssetsFromChain()
   │   │   │   └─> Reset last indexed block to deployment block
   │   │   └─> Update DB version
   │   └─> Continue to indexer startup
   │
   ├─> setupEventListeners() [Global event handlers]
   │   ├─> Listen for METADATA_CREATED on INDEXER_CRAWLING_EVENT_EMITTER
   │   ├─> Listen for METADATA_UPDATED
   │   ├─> Listen for ORDER_STARTED
   │   ├─> Listen for REINDEX_QUEUE_POP
   │   ├─> Listen for REINDEX_CHAIN
   │   └─> Re-emit to INDEXER_DDO_EVENT_EMITTER (for external consumers)
   │
   └─> For each supported chain (sequential):
       ├─> startThread(chainId)
       │   ├─> Check if indexer already running
       │   │   └─> If yes: stop it, wait, then proceed
       │   │
       │   ├─> Get network config (rpc, fallbackRPCs, chunkSize, etc.)
       │   │
       │   ├─> Create Blockchain instance
       │   │   └─> new Blockchain(rpc, chainId, config, fallbackRPCs)
       │   │
       │   ├─> Validate connectivity: retryCrawlerWithDelay()
       │   │   ├─> Check: blockchain.isNetworkReady()
       │   │   ├─> If not ready: tryFallbackRPCs()
       │   │   ├─> Check: DB reachable
       │   │   ├─> Retry up to 10 times with exponential backoff
       │   │   └─> Return: canStart (boolean)
       │   │
       │   ├─> If connectivity failed → return null, skip chain
       │   │
       │   ├─> Create ChainIndexer instance
       │   │   └─> new ChainIndexer(blockchain, rpcDetails, INDEXER_CRAWLING_EVENT_EMITTER)
       │   │
       │   ├─> Start indexer (non-blocking!)
       │   │   └─> await indexer.start()
       │   │       └─> Internally calls indexLoop() without await
       │   │       └─> Returns immediately, loop runs in background
       │   │
       │   └─> Store: indexers.set(chainId, indexer)
       │
       └─> Return: all indexers started successfully

3. Each ChainIndexer now running independently
   └─> Async indexLoop() executing concurrently for all chains
```

**Key Behaviors:**

- Version check happens before indexers start
- Each chain gets its own ChainIndexer instance
- RPC connection validated before starting indexer
- All indexers run concurrently via async/await (no worker threads)
- Event listeners set up globally (shared EventEmitter)
- ChainIndexers emit events, OceanIndexer re-emits to external consumers

**Current Architecture Benefits:**

- No worker threads → simpler code, easier debugging
- Async/await → better error handling, stack traces preserved
- EventEmitter → decoupled communication
- All indexers share same Node.js event loop
- Optimal for I/O-bound workloads (RPC calls, DB queries)

---

### Flow 2: Block Crawling Loop (ChainIndexer)

**Location:** `ChainIndexer.ts` - `indexLoop()`

**Sequence:**

```
async indexLoop() {
  // Initialization
  contractDeploymentBlock = getDeployedContractBlock(chainId)
  crawlingStartBlock = rpcDetails.startBlock || contractDeploymentBlock
  provider = blockchain.getProvider()
  signer = blockchain.getSigner()
  interval = getCrawlingInterval() // Default 30s
  chunkSize = rpcDetails.chunkSize || 1
  successfulRetrievalCount = 0
  lockProcessing = false
  startedCrawling = false

  // Main loop
  while (!this.stopSignal) {
    if (!lockProcessing) {
      lockProcessing = true

      try {
        // 1. GET CURRENT STATE
        lastIndexedBlock = await this.getLastIndexedBlock()
        networkHeight = await getNetworkHeight(provider)
        startBlock = lastIndexedBlock > crawlingStartBlock
                     ? lastIndexedBlock
                     : crawlingStartBlock

        INDEXER_LOGGER.info(
          `Chain ${chainId}: Last=${lastIndexedBlock}, Start=${startBlock}, Height=${networkHeight}`
        )

        // 2. CHECK IF WORK TO DO
        if (networkHeight > startBlock) {
          // Emit one-shot event when crawling starts
          if (!startedCrawling) {
            startedCrawling = true
            this.eventEmitter.emit(INDEXER_CRAWLING_EVENTS.CRAWLING_STARTED, {
              chainId,
              startBlock,
              networkHeight,
              contractDeploymentBlock
            })
          }

          // 3. CALCULATE CHUNK SIZE
          remainingBlocks = networkHeight - startBlock
          blocksToProcess = min(chunkSize, remainingBlocks)

          INDEXER_LOGGER.info(`Processing ${blocksToProcess} blocks...`)

          // 4. RETRIEVE EVENTS FROM RPC
          let chunkEvents = []
          try {
            chunkEvents = await retrieveChunkEvents(
              signer,
              provider,
              chainId,
              startBlock,
              blocksToProcess
            )
            // Inside retrieveChunkEvents():
            //   provider.getLogs({
            //     fromBlock: startBlock + 1,
            //     toBlock: startBlock + blocksToProcess,
            //     topics: [ALL_OCEAN_EVENT_HASHES]
            //   })

            successfulRetrievalCount++
          } catch (error) {
            // ADAPTIVE CHUNK SIZING on RPC error
            INDEXER_LOGGER.warn(`RPC error: ${error.message}`)
            chunkSize = floor(chunkSize / 2) < 1 ? 1 : floor(chunkSize / 2)
            successfulRetrievalCount = 0
            INDEXER_LOGGER.info(`Reduced chunk size to ${chunkSize}`)
            // Continue to next iteration
          }

          // 5. PROCESS EVENTS
          try {
            processedBlocks = await processBlocks(
              chunkEvents,
              signer,
              provider,
              chainId,
              startBlock,
              blocksToProcess
            )
            // processBlocks() calls processChunkLogs()
            // which routes events to processors

            INDEXER_LOGGER.debug(
              `Processed ${processedBlocks.foundEvents.length} events from ${chunkEvents.length} logs`
            )

            // 6. UPDATE LAST INDEXED BLOCK (critical!)
            currentBlock = await this.updateLastIndexedBlockNumber(
              processedBlocks.lastBlock,
              lastIndexedBlock
            )
            // Inside updateLastIndexedBlockNumber():
            //   indexerDb.update(chainId, block)
            //   Returns new lastIndexedBlock or -1 on failure

            // Safety check
            if (currentBlock < 0 && lastIndexedBlock !== null) {
              currentBlock = lastIndexedBlock
              INDEXER_LOGGER.error('Failed to update last block, keeping old value')
            }

            // 7. EMIT EVENTS FOR NEWLY INDEXED ASSETS
            this.emitNewlyIndexedAssets(processedBlocks.foundEvents)
            // Emits to INDEXER_CRAWLING_EVENT_EMITTER:
            //   - METADATA_CREATED
            //   - METADATA_UPDATED
            //   - ORDER_STARTED
            //   - ORDER_REUSED
            //   - DISPENSER_ACTIVATED/DEACTIVATED
            //   - EXCHANGE_ACTIVATED/DEACTIVATED/RATE_CHANGED

            // 8. ADAPTIVE CHUNK SIZE RECOVERY
            if (successfulRetrievalCount >= 3 && chunkSize < rpcDetails.chunkSize) {
              chunkSize = rpcDetails.chunkSize
              successfulRetrievalCount = 0
              INDEXER_LOGGER.info(`Reverted chunk size to ${chunkSize}`)
            }

          } catch (error) {
            // PROCESSING ERROR
            INDEXER_LOGGER.error(`Processing failed: ${error.message}`)
            successfulRetrievalCount = 0
            // Critical: Don't update last block → retry same chunk
            await sleep(interval)
          }

        } else {
          // No new blocks available
          await sleep(interval)
        }

        // 9. PROCESS REINDEX QUEUE
        await this.processReindexQueue(provider, signer)
        // Processes this.reindexQueue (FIFO)
        // For each task:
        //   - Get transaction receipt
        //   - Process logs from receipt
        //   - Emit REINDEX_QUEUE_POP event

        // 10. HANDLE CHAIN REINDEX COMMAND
        if (this.reindexBlock !== null) {
          networkHeight = await getNetworkHeight(provider)
          result = await this.reindexChain(currentBlock, networkHeight)

          this.eventEmitter.emit(INDEXER_CRAWLING_EVENTS.REINDEX_CHAIN, {
            result,
            chainId
          })
        }

      } catch (error) {
        INDEXER_LOGGER.error(`Error in indexing loop: ${error.message}`)
        await sleep(interval)
      } finally {
        lockProcessing = false
      }

    } else {
      // Already processing, wait a bit
      INDEXER_LOGGER.debug('Processing in progress, waiting...')
      await sleep(1000)
    }
  }

  // 11. CLEANUP ON STOP
  this.isRunning = false
  INDEXER_LOGGER.info(`Exiting indexer loop for chain ${chainId}`)
}
```

**Key Behaviors:**

- Infinite async loop with `lockProcessing` flag
- Adaptive chunk sizing on RPC errors (halves on error, recovers after 3 successes)
- Last block only updated on successful processing (critical for consistency)
- Reindex queue processed after each chunk
- One-shot `CRAWLING_STARTED` event
- Graceful shutdown via `stopSignal`
- All operations use async/await (no callbacks, no worker threads)

**Current Implementation Improvements:**

- `lockProcessing` now has actual waiting: `await sleep(1000)` when locked
- Instance state (`this.reindexBlock`, `this.reindexQueue`) instead of global
- Better error handling with try/catch/finally
- Cleaner shutdown: sets `isRunning = false`
- EventEmitter instead of postMessage (simpler, type-safe)

**Performance Characteristics:**

- One iteration per 30 seconds (if caught up)
- Processes up to `chunkSize` blocks per iteration (typically 100-1000)
- On RPC error: chunk size halves (min 1) → slower but more reliable
- Recovery: after 3 successful calls → chunk size restored
- No parallel event processing within chunk (maintains order)

---

### Flow 3: Event Processing Pipeline

**Location:** `processor.ts` - `processChunkLogs()`

**Sequence:**

```
processChunkLogs(logs, signer, provider, chainId):
  storeEvents = {}

  if (logs.length > 0) {
    config = await getConfiguration()
    checkMetadataValidated = (allowedValidators.length > 0 ||
                              allowedValidatorsList exists)

    for each log in logs:
      // 1. Identify event
      event = findEventByKey(log.topics[0])

      if (event && event.type in EVENTS):
        // 2. Metadata validation (if metadata event)
        if (event.type in [METADATA_CREATED, METADATA_UPDATED, METADATA_STATE]):
          if (checkMetadataValidated):
            // Get transaction receipt
            txReceipt = await provider.getTransactionReceipt(log.txHash)

            // Extract MetadataValidated events
            metadataProofs = fetchEventFromTransaction(
              txReceipt, 'MetadataValidated', ERC20Template.abi
            )

            if (!metadataProofs):
              continue // Skip event

            // Extract validator addresses
            validators = metadataProofs.map(proof => proof.args[0])

            // Check allowed validators
            allowed = allowedValidators.filter(v =>
              validators.indexOf(v) !== -1
            )

            if (!allowed.length):
              continue // Skip event

            // Check access lists (if configured)
            if (allowedValidatorsList && validators.length > 0):
              isAllowed = false
              for each accessListAddress in allowedValidatorsList[chainId]:
                accessListContract = new Contract(accessListAddress, ...)
                for each validator in validators:
                  balance = await accessListContract.balanceOf(validator)
                  if (balance > 0):
                    isAllowed = true
                    break
                if (isAllowed) break

              if (!isAllowed):
                continue // Skip event

        // 3. Route to processor
        if (event.type === TOKEN_URI_UPDATE):
          storeEvents[event.type] = 'TOKEN_URI_UPDATE'
        else:
          processor = getEventProcessor(event.type, chainId)
          result = await processor.processEvent(
            log, chainId, signer, provider, event.type
          )
          storeEvents[event.type] = result

    return storeEvents
  }

  return {}
```

**Key Behaviors:**

- Sequential processing (one event at a time)
- Validation happens before processing
- Multiple RPC calls per metadata event (receipt + access list checks)
- Processor instances cached per event type + chain
- Events skipped silently on validation failure

**Issues Observed:**

- Nested validation logic (hard to read)
- Multiple RPC calls per event (performance issue)
- No parallelization
- No batch validation
- Silent failures (just `continue`)

---

### Flow 4: Metadata Event Processing

**Location:** `processors/MetadataEventProcessor.ts` - `processEvent()`

**Sequence:**

```
processEvent(log, chainId, signer, provider, eventName):
  // 1. Factory check
  wasDeployedByUs = await wasNFTDeployedByOurFactory(
    chainId, signer, event.address
  )
  if (!wasDeployedByUs):
    return // Skip

  // 2. Decode event
  decodedEventData = await getEventData(
    provider, log.txHash, ERC721Template.abi, eventName
  )
  metadata = decodedEventData.args[4]
  metadataHash = decodedEventData.args[5]
  flag = decodedEventData.args[3]
  owner = decodedEventData.args[0]

  // 3. Decrypt DDO (400+ lines)
  ddo = await decryptDDO(
    decodedEventData.args[2], flag, owner,
    event.address, chainId, log.txHash,
    metadataHash, metadata
  )

  // 4. Validate DDO ID
  ddoInstance = DDOManager.getDDOClass(ddo)
  expectedDid = ddoInstance.makeDid(event.address, chainId)
  if (ddo.id !== expectedDid):
    await ddoState.update(..., false, 'DID mismatch')
    return

  // 5. Check authorized publishers
  if (authorizedPublishers configured):
    if (owner not in authorizedPublishers):
      await ddoState.update(..., false, 'Unauthorized publisher')
      return

  // 6. Get NFT info
  nftInfo = await getNFTInfo(event.address, signer)

  // 7. Get token info
  tokenInfo = await getTokenInfo(event.address, signer, provider)

  // 8. Get pricing stats
  pricingStats = await getPricingStatsForDddo(
    event.address, signer, provider, chainId
  )

  // 9. Check purgatory
  purgatoryStatus = await Purgatory.check(...)

  // 10. Check policy server
  policyServerCheck = await checkPolicyServer(...)

  // 11. Build indexed metadata
  indexedMetadata = {
    nft: nftInfo,
    event: { txid, from, contract, block, datetime },
    stats: [{
      datatokenAddress, name, symbol, serviceId,
      orders: number,
      prices: [...]
    }],
    purgatory: purgatoryStatus
  }

  // 12. Create or update DDO
  if (eventName === METADATA_CREATED):
    await ddoDatabase.create(ddo)
  else:
    existingDdo = await ddoDatabase.retrieve(ddo.id)
    // Merge stats
    updatedDdo = mergeDDO(existingDdo, ddo)
    await ddoDatabase.update(updatedDdo)

  // 13. Update DDO state
  await ddoState.update(chainId, ddo.id, event.address,
                       log.txHash, true, null)

  return ddo
```

**Key Behaviors:**

- Many sequential async operations
- Multiple RPC calls (NFT info, token info, pricing)
- DDO decryption with multiple strategies
- State tracking separate from DDO storage
- Stats merging for updates

**Issues Observed:**

- Very long method (400+ lines)
- Many external calls (slow)
- No batching of RPC calls
- Decryption logic complex and hard to test
- No error recovery for individual steps

---

### Flow 5: Reindex Transaction

**Location:** `crawlerThread.ts` - `processReindex()`

**Sequence:**

```
processReindex(provider, signer, chainId):
  while (REINDEX_QUEUE.length > 0):
    reindexTask = REINDEX_QUEUE.pop()

    try:
      // Get transaction receipt
      receipt = await provider.getTransactionReceipt(
        reindexTask.txId
      )

      if (receipt):
        // Extract logs
        if (reindexTask.eventIndex defined):
          log = receipt.logs[reindexTask.eventIndex]
          logs = [log]
        else:
          logs = receipt.logs

        // Process logs (same as normal flow)
        await processChunkLogs(logs, signer, provider, chainId)

        // Notify parent
        parentPort.postMessage({
          method: REINDEX_QUEUE_POP,
          data: { reindexTask }
        })
      else:
        // Receipt not found, re-queue
        REINDEX_QUEUE.push(reindexTask)

    catch (error):
      // Error logged, task lost
      INDEXER_LOGGER.error(...)
```

**Key Behaviors:**

- Processes queue during normal crawling loop
- Uses same processing pipeline as normal events
- Re-queues on receipt not found
- No retry limit

**Issues Observed:**

- Tasks can be lost on error
- No timeout for receipt retrieval
- Processes during normal crawling (could slow down)
- No priority mechanism

---

### Flow 6: Reindex Chain

**Location:** `crawlerThread.ts` - `reindexChain()`

**Sequence:**

```
reindexChain(currentBlock, networkHeight):
  // 1. Validate block
  if (REINDEX_BLOCK > networkHeight):
    REINDEX_BLOCK = null
    return false

  // 2. Update last indexed block
  block = await updateLastIndexedBlockNumber(REINDEX_BLOCK)

  if (block !== -1):
    REINDEX_BLOCK = null

    // 3. Delete all assets
    res = await deleteAllAssetsFromChain()

    if (res === -1):
      // Deletion failed, revert block
      await updateLastIndexedBlockNumber(currentBlock)
      return false

    return true
  else:
    REINDEX_BLOCK = null
    return false
```

**Key Behaviors:**

- Validates block before proceeding
- Updates block first, then deletes assets
- Reverts block if deletion fails
- Clears `REINDEX_BLOCK` flag

**Issues Observed:**

- No transaction wrapping (block update + deletion)
- Race condition possible (normal crawling could interfere)
- No progress tracking
- Can take very long for large chains

---

## Event Processing Flows

### Event Types Processed

1. **Metadata Events:**

   - `METADATA_CREATED` - New asset published
   - `METADATA_UPDATED` - Asset metadata updated
   - `METADATA_STATE` - Asset state changed

2. **Order Events:**

   - `ORDER_STARTED` - New order initiated
   - `ORDER_REUSED` - Order reused

3. **Dispenser Events:**

   - `DISPENSER_CREATED` - Dispenser created
   - `DISPENSER_ACTIVATED` - Dispenser activated
   - `DISPENSER_DEACTIVATED` - Dispenser deactivated

4. **Exchange Events:**

   - `EXCHANGE_CREATED` - Exchange created
   - `EXCHANGE_ACTIVATED` - Exchange activated
   - `EXCHANGE_DEACTIVATED` - Exchange deactivated
   - `EXCHANGE_RATE_CHANGED` - Exchange rate changed

5. **Other:**
   - `TOKEN_URI_UPDATE` - Token URI updated (no processing)

### Event Flow Summary

```
Block Logs
  ↓
Event Identification (by topic hash)
  ↓
Validation (for metadata events)
  ├─> Factory check
  ├─> Metadata proof validation
  ├─> Access list check
  └─> Publisher authorization
  ↓
Route to Processor
  ├─> MetadataEventProcessor
  ├─> OrderStartedEventProcessor
  ├─> DispenserEventProcessor
  └─> ExchangeEventProcessor
  ↓
Process Event
  ├─> Decode event data
  ├─> Fetch additional data (RPC calls)
  ├─> Transform to domain model
  └─> Store in database
  ↓
Emit Event (to parent thread)
  ↓
Parent Thread Emits (to listeners)
```

---

## Error Handling & Retry Mechanisms

### Current Retry Mechanisms (4 Layers)

**Layer 1: Crawler Startup Retry**

- Location: `index.ts` - `retryCrawlerWithDelay()`
- Max retries: 10
- Interval: `max(fallbackRPCs.length * 3000, 5000)` ms
- Recursive retry
- Checks DB reachability

**Layer 2: Adaptive Chunk Sizing**

- Location: `crawlerThread.ts` - `processNetworkData()`
- On RPC error: `chunkSize = floor(chunkSize / 2)` (min 1)
- Reverts after 3 successful calls
- No max retries (infinite)

**Layer 3: Block Processing Retry**

- Location: `crawlerThread.ts` - `processNetworkData()`
- On processing error: sleep and retry same chunk
- No max retries
- Last block not updated on error

**Layer 4: Individual RPC Retry**

- Location: `processors/BaseProcessor.ts` - `withRetrial()`
- Max retries: 5
- Used in `decryptDDO()`
- Exponential backoff

### Error Handling Issues

1. **No Centralized Strategy:**

   - 4 different retry mechanisms
   - Unclear which applies when
   - No consistent backoff

2. **Silent Failures:**

   - Events skipped with `continue`
   - No error tracking
   - No metrics on failures

3. **No Circuit Breaker:**

   - Continues retrying failed RPCs
   - Can cause cascade failures
   - No health tracking

4. **State Recovery:**
   - Last block not updated on error
   - Same chunk retried indefinitely
   - No timeout mechanism

---

## Async/Await Architecture & Concurrency

### Current Architecture (No Worker Threads)

- **One ChainIndexer instance per chain**
- **Main thread:** `OceanIndexer` orchestrator
- **Communication:** Direct `EventEmitter` (event-driven)
- **State:** Instance-based (no shared state between chains)
- **Concurrency:** Async/await leveraging Node.js event loop

### Indexer Lifecycle

```
OceanIndexer                          ChainIndexer (Chain 1)
     │                                       │
     │  new ChainIndexer(...)                │
     ├──────────────────────────────────────→│ Constructor
     │                                       │
     │  await indexer.start()                │
     ├──────────────────────────────────────→│ start() called
     │  (returns immediately)                │  ├─> Set stopSignal = false
     │                                       │  ├─> Set isRunning = true
     │                                       │  └─> Call indexLoop() without await
     │                                       │      (runs in background)
     │                                       │
     │                                       │ async indexLoop()
     │                                       │   while (!stopSignal) {
     │                                       │     ├─> Get last block
     │                                       │     ├─> Get network height
     │                                       │     ├─> Retrieve events
     │                                       │     ├─> Process events
     │                                       │     ├─> Update last block
     │                                       │     └─> Sleep 30s
     │                                       │   }
     │                                       │
     │  indexer.addReindexTask(task)         │
     ├──────────────────────────────────────→│ Add to reindexQueue
     │                                       │  (processed in next iteration)
     │                                       │
     │                                       │ eventEmitter.emit(METADATA_CREATED)
     │ ←──────────────────────────────────────┤
     │  (event listener catches)             │
     │  re-emit to INDEXER_DDO_EVENT_EMITTER │
     │                                       │
     │  await indexer.stop()                 │
     ├──────────────────────────────────────→│ stop() called
     │  (waits for graceful shutdown)        │  ├─> Set stopSignal = true
     │                                       │  └─> Wait for loop to exit
     │                                       │      while (isRunning) sleep(100)
     │                                       │
     │ ←──────────────────────────────────────┤ isRunning = false
     │  (stop() returns)                     │  Loop exited
```

### Concurrency Model

**How Multiple Chains Run Concurrently:**

```
Node.js Event Loop
    │
    ├─> ChainIndexer(chain=1).indexLoop()
    │   └─> await getLastBlock() ────→ I/O operation (yields control)
    │
    ├─> ChainIndexer(chain=137).indexLoop()
    │   └─> await provider.getLogs() ───→ I/O operation (yields control)
    │
    ├─> ChainIndexer(chain=8996).indexLoop()
    │   └─> await processBlocks() ──────→ I/O operation (yields control)
    │
    └─> (all run concurrently via async/await)
```

**Key Point:** When one indexer awaits an I/O operation (RPC call, DB query), control yields to the event loop, allowing other indexers to progress. No worker threads needed!

### Benefits Over Worker Threads

1. **Simpler Code:**

   - No `postMessage()` / `parentPort` complexity
   - Direct method calls
   - Clear data flow
   - Standard async/await patterns

2. **Better Error Handling:**

   - Stack traces preserved across async boundaries
   - try/catch works normally
   - Errors don't crash entire thread
   - No serialization errors

3. **State Management:**

   - Instance-based state (each ChainIndexer has its own)
   - No global state between chains
   - No race conditions on shared state
   - TypeScript types preserved

4. **Debugging:**

   - Can use standard debuggers
   - Breakpoints work normally
   - Console.log from anywhere
   - No need to debug worker threads

5. **Testing:**
   - Easy to mock ChainIndexer
   - No Worker API to mock
   - Can unit test methods directly
   - Faster test execution

### Current Concurrency Characteristics

1. **Lock Mechanism:**

   - `lockProcessing` flag prevents re-entry
   - Actual waiting: `await sleep(1000)` when locked
   - No race conditions (single-threaded per instance)

2. **Event Ordering:**

   - Events emitted in order per chain
   - EventEmitter guarantees listener order
   - No message queue (immediate delivery)

3. **Error Propagation:**

   - Errors caught in indexLoop()
   - Logged with chain context
   - Loop continues after error
   - `isRunning` flag tracks health

4. **Graceful Shutdown:**
   - `stop()` sets `stopSignal = true`
   - Loop exits on next iteration
   - `await` ensures complete shutdown
   - No orphaned processes

### Why This Works for I/O-Bound Workloads

**Ocean Node Indexer is I/O-bound:**

- 90%+ time spent waiting for:
  - RPC calls (network I/O)
  - Database queries (disk/network I/O)
  - Sleep intervals
- Minimal CPU-bound work (event decoding, JSON parsing)

**Async/await is optimal because:**

- During I/O wait, other indexers can progress
- No context switching overhead (vs threads)
- No memory duplication (vs processes)
- Single event loop handles all concurrency

---

## Failure Scenarios & Recovery

### Scenario 1: RPC Provider Fails

**Current Behavior:**

1. `retrieveChunkEvents()` throws error
2. Caught in `processNetworkData()`
3. Chunk size reduced
4. Sleep and retry
5. If all RPCs fail → retry up to 10 times during startup
6. After max retries → worker not started

**Recovery:**

- Manual restart required
- No automatic RPC health tracking
- No circuit breaker

**Issues:**

- Slow recovery (chunk size reduction)
- No provider health tracking
- Can get stuck retrying

---

### Scenario 2: Database Unavailable

**Current Behavior:**

1. DB call fails
2. Error logged
3. Last block not updated
4. Same chunk retried
5. Can loop indefinitely

**Recovery:**

- No automatic recovery
- Manual intervention needed
- State may be inconsistent

**Issues:**

- No DB health check
- No timeout
- Can process events but not store them

---

### Scenario 3: Worker Thread Crashes

**Current Behavior:**

1. Worker throws uncaught error
2. `worker.on('error')` handler logs error
3. `worker.on('exit')` handler sets `runningThreads[chainId] = false`
4. No automatic restart

**Recovery:**

- Manual restart via API
- Or node restart

**Issues:**

- No automatic restart
- State lost (in-memory queues)
- No health monitoring

---

### Scenario 4: Processing Error in Event Handler

**Current Behavior:**

1. `processor.processEvent()` throws error
2. Caught in `processBlocks()`
3. Error re-thrown
4. Caught in `processNetworkData()`
5. Last block not updated
6. Sleep and retry same chunk

**Recovery:**

- Retry same chunk
- No max retries
- Can loop forever on bad event

**Issues:**

- No error classification
- No skip mechanism for bad events
- Can block progress

---

### Scenario 5: Reindex Task Fails

**Current Behavior:**

1. `processReindex()` called
2. Receipt not found → re-queued
3. Processing error → logged, task lost
4. No retry limit

**Recovery:**

- Re-queue on receipt not found
- Lost on processing error
- No timeout

**Issues:**

- Tasks can be lost
- No retry limit
- No timeout

---

## State Management

### Global State Variables

**Parent Thread (`index.ts`):**

- `INDEXING_QUEUE: ReindexTask[]` - Reindex tasks
- `JOBS_QUEUE: JobStatus[]` - Admin job queue
- `runningThreads: Map<number, boolean>` - Thread status
- `globalWorkers: Map<number, Worker>` - Worker references
- `numCrawlAttempts: number` - Retry counter

**Worker Thread (`crawlerThread.ts`):**

- `REINDEX_BLOCK: number` - Chain reindex target
- `REINDEX_QUEUE: ReindexTask[]` - Transaction reindex queue
- `stoppedCrawling: boolean` - Stop flag
- `startedCrawling: boolean` - Start flag

**Database:**

- `indexer` table - Last indexed block per chain
- `ddo` table - DDO documents
- `ddoState` table - Validation state
- `order` table - Order records
- `sqliteConfig` table - Node version

### State Synchronization Issues

1. **Dual Queues:**

   - `INDEXING_QUEUE` (parent) and `REINDEX_QUEUE` (worker)
   - Can get out of sync
   - No transaction

2. **Last Block Updates:**

   - Updated after processing
   - Not updated on error
   - Can lead to gaps or duplicates

3. **Job Status:**

   - Updated via `updateJobStatus()`
   - Searches entire queue (O(n))
   - Can have duplicates

4. **Thread Status:**
   - `runningThreads` and `globalWorkers` can diverge
   - No cleanup on crash

---

## Observations & Pain Points

### Complexity Issues

1. **Mixed Concerns:**

   - Crawler thread handles: networking, validation, processing, state
   - Hard to test individual components
   - Changes affect multiple areas

2. **Nested Logic:**

   - Validation logic deeply nested (80+ lines)
   - Hard to read and maintain
   - Error paths unclear

3. **Long Methods:**
   - `processNetworkData()` - 160+ lines
   - `processChunkLogs()` - 120+ lines
   - `decryptDDO()` - 400+ lines
   - Hard to understand flow

### Performance Issues

1. **Serial Processing:**

   - Events processed one at a time
   - No parallelization
   - Slow for large chunks

2. **Many RPC Calls:**

   - Receipt per metadata event
   - Access list checks per validator
   - NFT info, token info, pricing per event
   - No batching

3. **Database Calls:**
   - One call per event
   - No batching
   - No transaction wrapping

### Reliability Issues

1. **Error Recovery:**

   - Multiple retry mechanisms
   - Unclear recovery paths
   - Can get stuck in loops

2. **State Consistency:**

   - No transactions
   - State can be inconsistent
   - No rollback mechanism

3. **Observability:**
   - Only logs
   - No metrics
   - Hard to debug production issues

### Testing Issues

1. **Worker Threads:**

   - Hard to unit test
   - Requires mocking Worker API
   - Integration tests slow

2. **Tight Coupling:**

   - Database calls throughout
   - RPC calls in processors
   - Hard to mock

3. **Global State:**
   - Tests can interfere
   - Hard to isolate
   - Flaky tests

---

## Summary

This document provides a comprehensive view of all indexer use cases, event monitoring mechanisms, and current flows. Key takeaways:

### Architecture Overview

1. **Current Implementation:**

   - Uses ChainIndexer classes (one per blockchain)
   - Async/await architecture (no worker threads)
   - Event-driven communication via EventEmitter
   - Optimal for I/O-bound operations

2. **Event Monitoring:**

   - Continuous block scanning (30-second intervals)
   - Filter-based event retrieval (topic hashes)
   - 12 different event types supported
   - Real-time processing and database updates

3. **Event Processing Pipeline:**
   - Event identification by topic hash
   - Multi-layer validation (factory, metadata, publishers)
   - Complex DDO decryption (HTTP, P2P, local)
   - Rich metadata enrichment (NFT info, pricing, orders)
   - Database persistence with state tracking

### Documentation Scope

1. **10 Main Use Cases** covering:

   - Normal block crawling and indexing
   - Event processing (metadata, orders, pricing)
   - Admin operations (reindex tx, reindex chain)
   - Error handling and recovery

2. **Event Monitoring Deep Dive** showing:

   - How events are discovered on-chain
   - Topic filtering and identification
   - Detailed processing for each event type
   - Database operations and state updates

3. **6 Detailed Flows** with:

   - Initialization and startup sequence
   - Block crawling loop (ChainIndexer)
   - Event processing pipeline
   - Metadata event handling
   - Reindex operations

4. **4 Retry Mechanisms** across:

   - Crawler startup (10 retries)
   - Adaptive chunk sizing (infinite, recovers after 3 successes)
   - Block processing retry (infinite, same chunk)
   - Individual RPC retry (5 retries in decryptDDO)

5. **5 Failure Scenarios** with:
   - RPC provider failures
   - Database unavailability
   - Worker/indexer crashes (now ChainIndexer)
   - Processing errors in handlers
   - Reindex task failures

### Key Technical Insights

**Event Monitoring:**

- Uses `provider.getLogs()` with Ocean Protocol event topic filters
- Processes up to 1000 blocks per iteration (configurable)
- Adaptive chunk sizing on RPC failures
- Sequential processing within chunk (maintains order)

**Event Processing:**

- 12 event types with dedicated processors
- Complex validation: factory → metadata proof → access list → publisher
- DDO decryption: 3 strategies (HTTP, P2P, local) with retries
- Metadata enrichment: NFT info + token info + pricing + purgatory
- Database operations: create/update DDO + state tracking + order records

**Concurrency Model:**

- All chains indexed concurrently via async/await
- No worker threads (simpler, more maintainable)
- Leverages Node.js event loop for I/O operations
- Instance-based state (no global state between chains)

### Next Steps for Meeting

**Analysis Topics:**

- Review event monitoring and processing flows
- Identify inconsistencies or implicit behavior
- Discuss validation complexity and optimization opportunities
- Evaluate error handling and retry strategies
- Consider batching and performance improvements

**Improvement Areas:**

- Serial event processing (no parallelization)
- Many RPC calls per metadata event (no batching)
- No database transaction wrapping
- Multiple retry mechanisms (uncoordinated)
- Complex nested validation logic

**Refactoring Considerations:**

- Separate validation from processing
- Extract DDO decryption service
- Implement batch RPC calls
- Add circuit breaker pattern
- Introduce metrics and observability

---

## Document Change Log

**Version 2.0 - January 27, 2026:**

**Major Updates:**

- ✅ Updated architecture from Worker Threads to ChainIndexer classes
- ✅ Replaced worker thread references with async/await architecture
- ✅ Added comprehensive "Event Monitoring Deep Dive" section (600+ lines)
- ✅ Detailed event handling for all 12 event types
- ✅ Updated all use cases to reflect current implementation
- ✅ Updated all flows with ChainIndexer lifecycle
- ✅ Renamed "Worker Threads & Concurrency" to "Async/Await Architecture & Concurrency"
- ✅ Enhanced summary with technical insights and improvement areas

**New Content:**

- Event discovery process with step-by-step breakdown
- Event identification and routing mechanism
- Detailed processing for METADATA_CREATED event (13 steps, 400+ lines)
- Detailed processing for METADATA_UPDATED event
- Detailed processing for ORDER_STARTED event
- Detailed processing for DISPENSER_ACTIVATED event
- Detailed processing for EXCHANGE_RATE_CHANGED event
- Event processing pipeline summary with visual diagram
- Performance characteristics (RPC patterns, concurrency model, failure recovery)
- Concurrency model explanation (why async/await works for I/O-bound workloads)

**Documentation Focus:**
This document now provides deep technical insight into:

1. How events are monitored on-chain (continuous polling, topic filtering)
2. What happens for each event type detected (validation → decryption → enrichment → storage)
3. Current implementation details (ChainIndexer, async/await, EventEmitter)
4. Pain points and improvement opportunities

**Target Audience:**

- Development team preparing for refactoring
- New developers understanding the indexer
- Architecture review meeting participants
- Technical stakeholders evaluating improvements

---

**Document Version:** 2.0  
**Last Updated:** January 27, 2026  
**Status:** Ready for Meeting - Reflects Current Implementation
