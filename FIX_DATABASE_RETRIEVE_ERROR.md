# Fix for "Cannot read properties of undefined (reading 'retrieve')" Error

**Date:** 2026-01-15  
**Status:** ✅ Fixed

## Problem Description

The error occurred when the `findDDO` command tried to retrieve a DDO from the database:

```
2026-01-15T09:07:40.161Z error: CORE: ❌ Error: 'Cannot read properties of undefined (reading 'retrieve')' 
was caught while getting DDO info for id: did:op:bb83b4b7f86b9523523be931a763aaa3a20dc9d3d46c96feb1940e86fde278ac
```

### Root Cause

The issue occurred when the database configuration was invalid or incomplete. In such cases:
1. The `Database` class would be partially initialized
2. The `ddo` property (and other database properties like `indexer`, `logs`, `ddoState`) would be `undefined`
3. Code attempting to call methods like `database.ddo.retrieve()` would fail with "Cannot read properties of undefined"

This happened because the database initialization in `/src/components/database/index.ts` only creates the `ddo`, `indexer`, `logs`, `order`, and `ddoState` properties when `hasValidDBConfiguration(config)` returns `true` (lines 65-108).

## Solution

Added defensive checks before accessing database properties in all affected files. The fix ensures that:
1. The database object exists
2. The specific database property (e.g., `ddo`, `indexer`, `logs`) exists
3. Returns appropriate error responses (HTTP 503 - Service Unavailable) when database is not available

## Files Modified

### 1. `/src/components/core/utils/findDdoHandler.ts`
**Function:** `findDDOLocally()`
- Added check for `database` and `database.ddo` before calling `retrieve()`
- Returns `undefined` with a warning log if database is not available

### 2. `/src/components/core/handler/queryHandler.ts`
**Functions:** 
- `QueryHandler.handle()` - Added check for `database.ddo`
- `QueryDdoStateHandler.handle()` - Added check for `database.ddoState`
- Returns HTTP 503 error if database is not available

### 3. `/src/components/core/handler/ddoHandler.ts`
**Functions:**
- `GetDdoHandler.handle()` - Added check for `database.ddo`
- `FindDdoHandler.handle()` (sink function) - Added check before checking if DDO exists locally
- `findAndFormatDdo()` - Added check for `database.ddo`
- Returns HTTP 503 error if database is not available

### 4. `/src/components/core/handler/policyServer.ts`
**Function:** `PolicyServerInitializeHandler.handle()`
- Added check for `database.ddo` before retrieving DDO
- Returns HTTP 503 error if database is not available

### 5. `/src/components/httpRoutes/logs.ts`
**Route:** `POST /log/:id`
- Added check for `database.logs` before retrieving log
- Returns HTTP 503 error if database is not available

### 6. `/src/components/core/utils/statusHandler.ts`
**Function:** `getIndexerBlockInfo()`
- Added check for `database.indexer` before retrieving block info
- Returns '0' with a warning log if indexer database is not available

## Pattern Applied

Before (unsafe):
```typescript
const ddo = await node.getDatabase().ddo.retrieve(id)
```

After (safe):
```typescript
const database = node.getDatabase()
if (!database || !database.ddo) {
  // Handle error appropriately
  return {
    stream: null,
    status: { httpStatus: 503, error: 'DDO database is not available' }
  }
}
const ddo = await database.ddo.retrieve(id)
```

## Testing

To verify the fix:
1. Run the node with an invalid database configuration
2. Try to execute a `findDDO` command
3. The system should now return a proper error message instead of crashing

Expected behavior:
- HTTP 503 response with message: "DDO database is not available"
- Logs should show warning messages about unavailable database
- No more "Cannot read properties of undefined" errors

## Impact

- **Backwards Compatible:** Yes, no breaking changes
- **Error Handling:** Improved - now provides meaningful error messages
- **Stability:** Significantly improved - prevents crashes when database is not fully initialized
- **Performance:** No impact - only adds lightweight null checks

## Related Files

- `/src/OceanNode.ts` - Defines `getDatabase()` method
- `/src/components/database/index.ts` - Database initialization logic
- `/src/components/database/DatabaseFactory.ts` - Database factory pattern

## Configuration Note

To ensure full database functionality, make sure the following environment variable is properly configured:
- `DB_URL` - Required for DDO, Indexer, Logs, Order, and DDO State databases

Without a valid `DB_URL`, only the Nonce, C2D, Auth Token, and Config databases will be initialized.

