# Policy Server

Sometimes, actions performed by Ocean Node have to be double-checked on a higher level of authorization. This might include Oath tokens, SSI verifiable credentials, Enterprise LDAP, etc...

For this, we will adopt a simple, but flexible architecture:

For every command, Ocean Node will query PolicyServer (if such env is defined) and wait for it to perform all needed checks.

For 200 OK responses, Ocean Node will continue to perform the action. For everything else, it will deny. If there is a body in response, we will forward that body to the caller. (so users can see the PolicyServer error messages and act accordingly)

Every Ocean Node command will also accept a data field, called "policyServer" which will be added to the query (so we can pass data from the user to PolicyServer)

## PolicyServer API definition

All queries will be performed by sending a POST request to PolicyServer Endpoint, with a json payload that looks like this:

```json
{
    "action":"newDDO",
    ......
}
```

Every command will have its own set of data, in addition to the "action" field.
I will describe them below:

### newDDO

Called whenever a new DDO is detected by indexer

```json
{
    "action":"newDDO",
    "rawDDO": {..},
    "chainId": 1,
    "txId": "0x123",
    "eventRaw": "raw event data"
}
```

### updateDDO

Called whenever a DDO is updated by indexer

```json
{
    "action":"updateDDO",
    "rawDDO": {..},
    "chainId": 1,
    "txId": "0x123",
    "eventRaw": "raw event data"
}
```

### validateDDO

Called whenever a DDO is validated

```json
{
    "action":"validateDDO",
    "rawDDO": {..},
    "publisherAddress": '0x001',
    "policyServer": {}
}
```

### initialize

Called whenever a new initialize command is received by Ocean Node

```json
{
  "action": "initialize",
  "documentId": "did:op:123",
  "ddo": {},
  "serviceId": "0x123",
  "consumerAddress": "0x123",
  "policyServer": {}
}
```

### download

Called whenever a new download command is received by Ocean Node

```json
{
    "action":"download",
    "documentId": "did:op:123",
    "ddo": {},
    "serviceId": "0x123",
    "fileIndex": 1,
    "transferTxId": "0x123",
    "consumerAddress": "0x123"
    "policyServer": {}
}
```

### encrypt

Called whenever a new encrypt command is received by Ocean Node

```json
{
  "action": "encrypt",
  "policyServer": {}
}
```

### encryptFile

Called whenever a new encryptFile command is received by Ocean Node

```json
{
  "action": "encrypt",
  "policyServer": {},
  "file"?: object
}
```

### decrypt

Called whenever a new decrypt command is received by Ocean Node

```json
{
  "action": "decrypt",
  "decrypterAddress": "0x123",
  "chainId": 1,
  "transactionId": "0x123",
  "dataNftAddress": "0x123",
  "policyServer": {}
}
```

## Passthrough and caller identity

`POST /api/services/PolicyServerPassthrough` lets a caller send an arbitrary payload
straight to the PolicyServer, and `POST /api/services/initializePSVerification` starts an
`initiate` flow. Both are **authenticated by Ocean Node**: the caller must supply either an
`Authorization` header carrying an auth token, or a `nonce` + `signature` pair, together
with `consumerAddress`. Unauthenticated requests get a `401` and never reach the
PolicyServer.

Because the passthrough body is forwarded verbatim, Ocean Node **overwrites** the identity
fields after it has verified the caller. The payload the PolicyServer receives therefore
always carries:

| field           | set by     | meaning                                                            |
| --------------- | ---------- | ------------------------------------------------------------------ |
| consumerAddress | Ocean Node | the address this node verified — trustworthy, not caller-controlled |
| authorization   | Ocean Node | the caller's auth token, relayed as received                       |
| nonce           | Ocean Node | the caller's nonce (already consumed by this node)                 |
| signature       | Ocean Node | the caller's signature, so the PolicyServer can re-verify it       |
| ddo             | Ocean Node | the DDO resolved from `documentId`, or `null` if not found         |
| nodeAddress     | Ocean Node | the address of the node making the request                         |

Everything else in the payload — including `action` — is caller-supplied and must be
treated as untrusted input.

Each endpoint is its own command, and the command string is part of the signed message, so a
signature is scoped to one endpoint and cannot be replayed against the other:

| endpoint                              | command                    | signed message                                        |
| ------------------------------------- | -------------------------- | ----------------------------------------------------- |
| `/api/services/PolicyServerPassthrough`  | `PolicyServerPassthrough`  | `consumerAddress + nonce + "PolicyServerPassthrough"` |
| `/api/services/initializePSVerification` | `PolicyServerInitialize`   | `consumerAddress + nonce + "PolicyServerInitialize"`  |

A PolicyServer can independently recompute and verify either one. Note that for
`initializePSVerification` the credentials arrive nested inside the `policyServer` object
rather than at the top level.

> **A caller controls `action`.** A passthrough payload can claim `"action": "download"` or
> `"action": "startCompute"` and look much like the ones Ocean Node itself sends for those
> commands. The `consumerAddress` is trustworthy, but the action is not — do not grant a
> passthrough request the same authority as a node-initiated one.

> **The caller's auth token leaves the node.** `authorization` is relayed to the
> PolicyServer so it can run its own checks, so `POLICY_SERVER_URL` should be an HTTPS
> endpoint the operator controls.
