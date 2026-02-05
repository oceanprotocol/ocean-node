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

### initialize

Called whenever a new initialize command is received by Ocean Node

```json
{
    "action":"initialize",
    "documentId": "did:op:123",
    "ddo": {},
    "serviceId": "0x123",
    "consumerAddress": "0x123"
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
