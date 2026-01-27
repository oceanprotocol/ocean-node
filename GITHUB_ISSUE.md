## Bug: Cannot read properties of undefined (reading 'retrieve') in findDDO command

### Description
The ocean-node crashes with `TypeError: Cannot read properties of undefined (reading 'retrieve')` when attempting to execute the `findDDO` command if the database is not fully initialized.

### Steps to Reproduce
1. Run ocean-node without a valid `DB_URL` environment variable
2. Execute a `findDDO` command with any DID
3. Observe the crash

### Error Log
```
2026-01-15T09:07:40.160Z debug: CORE:  Unable to find DDO locally. Proceeding to call findDDO
2026-01-15T09:07:40.161Z info: CORE:  Checking received command data for Command "findDDO": {
    "id": "did:op:bb83b4b7f86b9523523be931a763aaa3a20dc9d3d46c96feb1940e86fde278ac",
    "command": "findDDO",
    "force": false
}
2026-01-15T09:07:40.161Z error: CORE:  ❌ Error: 'Cannot read properties of undefined (reading 'retrieve')' was caught while getting DDO info for id: did:op:bb83b4b7f86b9523523be931a763aaa3a20dc9d3d46c96feb1940e86fde278ac
```

### Root Cause
When `DB_URL` is invalid or missing, the `Database` class only initializes essential databases (Nonce, C2D, Auth Token, Config). Properties like `ddo`, `indexer`, `logs`, `ddoState`, and `order` remain `undefined`. Code accessing these properties without null checks throws `TypeError`.

### Impact
- Node crashes when handling DDO-related commands without proper database configuration
- Poor error messages that don't indicate the actual problem (missing DB configuration)
- Affects multiple handlers: `findDDO`, `getDDO`, `query`, `policyServer`, etc.

### Solution
Add defensive null checks before accessing database properties in:
- `findDdoHandler.ts` - `findDDOLocally()`
- `queryHandler.ts` - `QueryHandler` and `QueryDdoStateHandler`
- `ddoHandler.ts` - `GetDdoHandler`, `FindDdoHandler`, `findAndFormatDdo()`
- `policyServer.ts` - `PolicyServerInitializeHandler`
- `logs.ts` - `/log/:id` route
- `statusHandler.ts` - `getIndexerBlockInfo()`

Return HTTP 503 with clear error message: "DDO database is not available" instead of crashing.

### Expected Behavior After Fix
- Node returns HTTP 503 with descriptive error message
- Logs warning about unavailable database
- No crashes when database is not fully initialized
- Backwards compatible with existing functionality

