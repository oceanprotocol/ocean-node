# Ocean Node Indexer - Event Monitoring & Error Handling

## Table of Contents

1. [Overview](#overview)
2. [Event Monitoring Architecture](#event-monitoring-architecture)
3. [Event Processing Pipeline](#event-processing-pipeline)
4. [Detailed Event Handling](#detailed-event-handling)
5. [Error Handling & Retry Mechanisms](#error-handling--retry-mechanisms)
6. [Failure Scenarios & Recovery](#failure-scenarios--recovery)

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
       │   ├─> P2P: p2pNode.sendTo(decryptorURL, message)
       │   ├─> Local: node.getCoreHandlers().handle(decryptDDOTask)
       │   └─> Validate response hash matches metadataHash
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
```

**RPC Calls:** 1-2 (get NFT address, receipt)

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

3. FIND NFT ADDRESS
   └─> datatokenContract.getERC721Address()

4. RETRIEVE DDO
   └─> ddo = ddoDatabase.retrieve(did)

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
```

**RPC Calls:** 2-3 (receipt, validation, NFT address)

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

### Overview: 4 Retry Layers

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
└──────────────────────────────────────────────────────────────┘
                          ↓
┌──────────────────────────────────────────────────────────────┐
│ LAYER 4: Individual RPC Retry                                │
│ Location: BaseProcessor - withRetrial()                     │
│ Scope: DDO decryption HTTP calls                             │
│ Max Retries: 5                                                │
│ Strategy: Exponential backoff                                │
│ Conditions: Only retry on ECONNREFUSED                       │
└──────────────────────────────────────────────────────────────┘
```

### Layer 1: Startup Retry

**Purpose:** Ensure RPC and DB are reachable before starting indexer

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

---

### Error Handling Issues

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
