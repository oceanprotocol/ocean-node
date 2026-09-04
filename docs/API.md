# Ocean Node Api

## Address casing

Every EVM address you send (`consumerAddress`, `owner`, `address`, `decrypterAddress`,
`dataNftAddress`, `publisherAddress`, `consumerAddrs`, `additionalViewers`) is accepted in **any
casing** — checksummed (EIP-55), all-lowercase, all-uppercase — and canonicalized to its checksummed
form by the node before it is used as a lookup key or compared against an owner. A lowercased
address therefore matches the same jobs, services and buckets as the checksummed one.

Signatures are unaffected: the node verifies the signed message against the casing you actually
signed, so clients that build the message from a lowercase address keep working.

---

## State DDO

### `HTTP` GET /api/aquarius/assets/metadata/query?

#### Description

returns ddo state

#### Query Parameters

| name    | type   | required | description                                            |
| ------- | ------ | -------- | ------------------------------------------------------ |
| did     | object |          | document id or did                                     |
| chainId | object |          | chain id of network on which document is provided      |
| nft     | object |          | one or more field names that should be queried against |

#### Response

```
123
```

---

## Query DDO

### `HTTP` POST /api/aquarius/assets/metadata/query

#### Description

returns search result for query

#### Parameters

| name     | type   | required | description                                            |
| -------- | ------ | -------- | ------------------------------------------------------ |
| q        | object | v        | text to search for in database                         |
| query_by | object | v        | one or more field names that should be queried against |

#### Request

```json
{
  "q": "0x123",
  "query_by": "nftAddress"
}
```

#### Response

```
[{
  "facet_counts": [],
  "found": 1,
  "out_of": 1,
  "page": 1,
  "request_params": {
    "collection_name": "ddo",
    "per_page": 10,
    "q": "0x123"
  },
  "search_time_ms": 1,
  "hits": [
    {
      "highlights": [
        {
          "field": "nftAddress",
          "snippet": "<mark>0x123</mark>",
          "matched_tokens": ["0x123"]
        }
      ],
      "document": {
        "@context": ["https://w3id.org/did/v1"],
        "id": "did:op:ACce67694eD2848dd683c651Dab7Af823b7dd123",
        "version": "4.1.0",
        "chainId": 1,
        "nftAddress": "0x123",
        ...
      },
      "text_match": 130916
    }
  ]
}]
```

---

## Get DDO Metadata

### `HTTP` GET /api/aquarius/assets/ddo/:did

#### Description

returns metadata of document by id

#### Response

```
{
    "created": "2020-11-15T12:27:48Z",
    "updated": "2021-05-17T21:58:02Z",
    "description": "Sample description",
    "name": "Sample asset",
    "type": "dataset",
    "author": "OPF",
    "license": "https://market.oceanprotocol.com/terms"
}
```

---

## Get DDO

### `HTTP` GET /api/aquarius/assets/ddo/:did

#### Description

returns document by id

#### Response

```
{
  "@context": ["https://w3id.org/did/v1"],
  "id": "did:op:ACce67694eD2848dd683c651Dab7Af823b7dd123",
  "version": "4.1.0",
  "chainId": 1,
  "nftAddress": "0x123",
  ...
}
```

---

## Nonce

### `HTTP` GET /api/services/nonce?

#### Description

returns stored nonce for an address

#### Query Parameters

| name        | type   | required | description |
| ----------- | ------ | -------- | ----------- |
| userAddress | string | v        | address     |

#### Response

```
123
```

---

## Initialize Service

### `HTTP` GET /api/services/initialize?

#### Description

returns amount of tokens to transfer to the provider account

#### Query Parameters

| name            | type   | required | description                                    |
| --------------- | ------ | -------- | ---------------------------------------------- |
| documentId      | string | v        | document id or did                             |
| serviceId       | string | v        | id of the service the datatoken is attached to |
| consumerAddress | string | v        | consumer address                               |

#### Response

```
{
  "datatoken": "0x123",
  "nonce": "123",
  "providerFee": {
    providerFeeAddress: "0x123",
    providerFeeToken: "0x123",
    providerFeeAmount: 123,
    providerData: "0x123",
    v: 123,
    r: "0x123",
    s: "0x123",
    validUntil: 123
  }
}
```

---

## Encrypt

### `HTTP` POST /api/services/encrypt

#### Description

returns encrypted blob

#### Query Parameters

| name            | type   | required | description                                             |
| --------------- | ------ | -------- | ------------------------------------------------------- |
| nonce           | string | v        | is required to verify a request paired with a signature |
| consumerAddress | string | v        | consumer address                                        |
| signature       | string | v        | signed message based on ` nonce`                        |

#### Request body

```
string
```

#### Response

```
0x123
```

---

## EncryptFile

### `HTTP` POST /api/services/encryptFile

#### Description

returns encrypted file

#### Query Parameters

| name            | type   | required | description                                             |
| --------------- | ------ | -------- | ------------------------------------------------------- |
| nonce           | string | v        | is required to verify a request paired with a signature |
| consumerAddress | string | v        | consumer address                                        |
| signature       | string | v        | signed message based on ` nonce`                        |

#### Request body

if Content-Type = 'application/json'

```
BaseFileObject
```

if Content-Type = 'application/octet-stream' || 'multipart/form-data'

```
FileContent(bytes)
```

#### Response

```
0x123
```

---

## Decrypt DDO

### `HTTP` POST /api/services/decrypt

#### Description

returns decrypted document

#### Parameters

| name              | type   | required | description                                                                                   |
| ----------------- | ------ | -------- | --------------------------------------------------------------------------------------------- |
| decrypterAddress  | string | v        | decrypter address                                                                             |
| chainId           | number | v        | chain id of network on which document is provided                                             |
| transactionId     | string |          | tx id of encrypted document                                                                   |
| dataNftAddress    | string |          | address of nft token                                                                          |
| encryptedDocument | string |          | encrypted document                                                                            |
| flags             | number |          | metadata flags if DDO is ECIES encrypted or lzma compressed                                   |
| documentHash      | string |          | hash based on sha256 of asset                                                                 |
| nonce             | string | v        | is required to verify a request paired with a signature                                       |
| signature         | string | v        | signed message based on `transactionId + dataNftAddress + decrypterAddress + chainId + nonce` |

#### Request

```json
{
  "decrypterAddress": "0x123",
  "chainId": 123,
  "transactionId": "0x123",
  "dataNftAddress": "0x123",
  "encryptedDocument": "0x123",
  "flags": 1,
  "documentHash": "0x123",
  "nonce": "123",
  "signature": "0x123"
}
```

#### Response

```
{
  "@context": ["https://w3id.org/did/v1"],
  "id": "did:op:ACce67694eD2848dd683c651Dab7Af823b7dd123",
  "version": "4.1.0",
  "chainId": 1,
  "nftAddress": "0x123",
  ...
}
```

---

## File Info

### `HTTP` POST /api/fileInfo

#### Description

returns file information

#### Parameters

| name      | type   | required | description                              |
| --------- | ------ | -------- | ---------------------------------------- |
| type      | string |          | type of storage `url or arweave or ipfs` |
| did       | string |          | document id or did                       |
| serviceId | number |          | service id of services list              |
| fileIndex | number |          | file index in files array                |
| file      | object |          | file data                                |
| checksum  | number |          | index in transaction events list         |

#### Request

```json
{
  "type": "123",
  "did": "did:op:123",
  "serviceId": 123,
  "fileIndex": 123,
  "file": 123,
  "checksum": 123
}
```

#### Response

```
[
    {
      valid: true
      contentLength: "123"
      contentType: "123"
      name: "123"
      type: "url or arweave or ipfs"
    }
]
```

---

## Download

### `HTTP` GET /api/services/download?

#### Description

returns a file stream of the requested file

#### Query Parameters

| name              | type   | required | description                                                                              |
| ----------------- | ------ | -------- | ---------------------------------------------------------------------------------------- |
| fileIndex         | number | v        | file index in the list of document files                                                 |
| documentId        | string | v        | document id or did                                                                       |
| serviceId         | string | v        | service id of array of services defining access to the asset                             |
| transferTxId      | string | v        | tx id of transaction for approval of datatokens transfer given to the provider's account |
| nonce             | string | v        | is required to verify a request paired with a signature                                  |
| consumerAddress   | string | v        | consumer address                                                                         |
| signature         | string | v        | signed message based on `did + nonce`                                                    |
| aes_encrypted_key | string |          | encrypted key for cipher to decrypt file                                                 |

#### Response

```
byte array
```

---

## Log

### `HTTP` GET /logs/:id"

#### Description

returns log by id

#### Response

```
{
  "timestamp": "123",
  "level": "123",
  "message": "123",
  "moduleName": "123",
  "meta": "123",
}
```

---

## Logs

### `HTTP` GET /logs/?

#### Description

returns list of logs

#### Query Parameters

| name       | type   | required | description                |
| ---------- | ------ | -------- | -------------------------- |
| startTime  | string |          | filter logs from date      |
| endTime    | string |          | filter logs to date        |
| maxLogs    | string |          | logs per page              |
| moduleName | string |          | filter logs by module name |
| level      | string |          | filter logs by level       |

#### Response

```
[
    {
      "id": "123",
      "timestamp": "123",
      "level": "123",
      "message": "123",
      "moduleName": "123",
      "meta": "123",
    }
]
```

---

## Get providers for a string

### `HTTP` GET /getProvidersForString/?input=did:op:123"

#### Description

returns list of nodes providing the specific element(s) (dids, c2d resources, etc)

#### Query Parameters

| name  | type   | required | description            |
| ----- | ------ | -------- | ---------------------- |
| input | string | v        | did, c2d resource, etc |

## Get providers for a list of strings

### `HTTP` POST /getProvidersForStrings?timeout=10"

#### Description

returns list of nodes providing all specific elements.

#### Query Parameters

| name    | type   | required | description            |
| ------- | ------ | -------- | ---------------------- |
| timeout | string | optional | timeout in miliseconds |

#### Request

```json
["{\"c2d\":{\"free\":false,\"disk\":1}}", "{\"c2d\":{\"free\":false,\"cpu\":1}}"]
```

#### Response

```json
[
  {
    "id": "16Uiu2HAmENNgCY1QAdQrPxipgUCQjyookUgpnbgXua4ZMju4Rkou",
    "multiaddrs": [
      "/ip4/10.255.255.254/tcp/41015/ws",
      "/ip4/10.255.255.254/tcp/41347",
      "/ip4/127.0.0.1/tcp/41015/ws",
      "/ip4/127.0.0.1/tcp/41347",
      "/ip4/172.27.58.101/tcp/41015/ws",
      "/ip4/172.27.58.101/tcp/41347",
      "/ip6/::1/tcp/37527"
    ]
  }
]
```

---

## Get P2P Peer

### `HTTP` GET /getP2PPeer/?

#### Description

returns P2P peer

#### Query Parameters

| name   | type   | required | description |
| ------ | ------ | -------- | ----------- |
| peerId | string | v        | peer id     |

#### Response

```
{
  "id": "PeerId",
  "addresses": [{ multiaddr: "123", isCertified: true }],
  "protocols": ["123", "123", "123"],
  "metadata": {},
  "tags": {},
  "publicKey": "0x123"
}
```

---

## find peer multiaddress

### `HTTP` GET /findPeer/?

#### Description

returns P2P peer multiaddresses if found in DHT

#### Query Parameters

| name    | type   | required | description |
| ------- | ------ | -------- | ----------- |
| peerId  | string | v        | peer id     |
| timeout | int    | optional | timeout     |

#### Response

```
{
    "id": "16Uiu2HAmLhRDqfufZiQnxvQs2XHhd6hwkLSPfjAQg1gH8wgRixiP",
    "multiaddrs": [
        "/ip4/127.0.0.1/tcp/9000",
        "/ip4/127.0.0.1/tcp/9001/ws",
        "/ip4/172.18.0.2/tcp/9000",
        "/ip4/172.18.0.2/tcp/9001/ws",
        "/ip6/::1/tcp/9002"
    ]
}
```

---

## Get P2P Peers

### `HTTP` GET /getP2PPeers

#### Description

returns list of all P2P peers

#### Response

```
[
    {
      "id": "PeerId",
      "addresses": [{ multiaddr: "123", isCertified: true }],
      "protocols": ["123", "123", "123"],
      "metadata": {},
      "tags": {}
    }
]
```

---

## Validate DDO

### `HTTP` POST /directCommand

### `P2P` command: validateDDO

#### Description

returns an empty object if it is valid otherwise an array with error

#### Parameters

| name       | type     | required | description                                       |
| ---------- | -------- | -------- | ------------------------------------------------- |
| command    | string   | v        | command name                                      |
| node       | string   |          | if not present it means current node              |
| multiAddrs | string[] |          | if passed, use this instead of peerStore & DHT    |
| id         | string   | v        | document id or did                                |
| chainId    | number   | v        | chain id of network on which document is provided |
| nftAddress | string   | v        | address of nft token                              |

#### Request

```json
{
  "command": "validateDDO",
  "node": "PeerId",
  "id": "did:op:123",
  "chainId": 123,
  "nftAddress": "0x123"
}
```

---

## File Info

### `HTTP` POST /directCommand

### `P2P` command: fileInfo

#### Description

returns file information

#### Parameters

| name      | type   | required | description                              |
| --------- | ------ | -------- | ---------------------------------------- |
| command   | string | v        | command name                             |
| node      | string |          | if not present it means current node     |
| type      | string |          | type of storage `url or arweave or ipfs` |
| did       | string |          | document id or did                       |
| serviceId | number |          | service id of services list              |
| fileIndex | number |          | file index in files array                |
| file      | object |          | file data                                |
| checksum  | number |          | index in transaction events list         |

#### Request

```json
{
  "command": "fileInfo",
  "node": "PeerId",
  "type": "123",
  "did": "did:op:123",
  "serviceId": 123,
  "fileIndex": 123,
  "file": 123,
  "checksum": 123
}
```

#### Response

```
[
    {
      valid: true
      contentLength: "123"
      contentType: "123"
      name: "123"
      type: "url or arweave or ipfs"
    }
]
```

---

## Re-Index Transaction

### `HTTP` POST /directCommand

### `P2P` command: reIndex

#### Description

returns a message about successful addition to the reindexing queue

#### Parameters

| name       | type   | required | description                                          |
| ---------- | ------ | -------- | ---------------------------------------------------- |
| command    | string | v        | command name                                         |
| node       | string |          | if not present it means current node                 |
| txId       | string | v        | id of transaction for reindexing                     |
| chainId    | number | v        | chain id of network on which transaction is provided |
| eventIndex | number |          | index in transaction events list                     |

#### Request

```json
{
  "command": "reIndex",
  "node": "PeerId",
  "txId": "0x123",
  "chainId": 123,
  "eventIndex": 123
}
```

#### Response

```
Added to reindex queue successfully
```

---

## Get Fees

### `HTTP` POST /directCommand

### `P2P` command: getFees

#### Description

returns calculated provider fees for DDO with service id

#### Parameters

| name      | type   | required | description                          |
| --------- | ------ | -------- | ------------------------------------ |
| command   | string | v        | command name                         |
| node      | string |          | if not present it means current node |
| ddo       | object | v        | document object                      |
| serviceId | string | v        | service id of services list          |

#### Request

```json
{
  "command": "getFees",
  "node": "PeerId",
  "ddo": {
    "@context": ["https://w3id.org/did/v1"],
    "id": "did:op:ACce67694eD2848dd683c651Dab7Af823b7dd123",
    "version": "4.1.0",
    "chainId": 1,
    "nftAddress": "0x123",
    "...": "..."
  },
  "serviceId": "123"
}
```

#### Response

```
[
    {
      providerFeeAddress: "0x123",
      providerFeeToken: "0x123",
      providerFeeAmount: 123,
      providerData: "0x123",
      v: 123,
      r: "0x123",
      s: "0x123",
      validUntil: 123,
    }
]
```

---

## Find DDO

### `HTTP` POST /directCommand

### `P2P` command: findDDO

#### Description

returns list of providers from which ddo can be obtained

#### Parameters

| name    | type   | required | description                          |
| ------- | ------ | -------- | ------------------------------------ |
| command | string | v        | command name                         |
| node    | string |          | if not present it means current node |
| id      | string | v        | document id or did                   |

#### Request

```json
{
  "command": "findDDO",
  "node": "PeerId",
  "id": "did:op:123"
}
```

#### Response

```
[
    {
      provider: "PeerId",
      id: "did:op:123"
      lastUpdateTx: "123",
      lastUpdateTime: "123",
    }
]
```

---

## Status

### `HTTP` POST /directCommand

### `P2P` command: status

#### Description

returns status of node

#### Parameters

| name    | type   | required | description                          |
| ------- | ------ | -------- | ------------------------------------ |
| command | string | v        | command name                         |
| node    | string |          | if not present it means current node |

#### Request

```json
{
  "command": "status",
  "node": "PeerId"
}
```

#### Response

```
{
    "id": "PeerId",
    "publicKey": "0x123",
    "address": "0x123",
    "version": "123",
    "http": true,
    "p2p": true,
    "provider": [],
    "indexer": [],
    "supportedStorage": {
      "ipfs": true
      "arwave": true
      "url": true
    },
    "uptime": 123,
    "platform": {
      "cpus": "123",
      "freemem": 123,
      "totalmem": 123,
      "loadavg": [123],
      "arch": "123",
      "machine": "123",
      "platform": "123",
      "release": "123",
      "osType": "123",
      "osVersion": "123",
      "node": "123"
    }
  }
```

---

## Query DDO

### `HTTP` POST /directCommand

### `P2P` command: query

#### Description

returns search result for query

#### Parameters

| name           | type   | required | description                                            |
| -------------- | ------ | -------- | ------------------------------------------------------ |
| command        | string | v        | command name                                           |
| node           | string |          | if not present it means current node                   |
| query          | object | v        | query parameters                                       |
| query.q        | object | v        | text to search for in database                         |
| query.query_by | object | v        | one or more field names that should be queried against |

#### Request

```json
{
  "command": "query",
  "node": "PeerId",
  "query": {
    "q": "0x123",
    "query_by": "nftAddress"
  }
}
```

#### Response

```
[{
  "facet_counts": [],
  "found": 1,
  "out_of": 1,
  "page": 1,
  "request_params": {
    "collection_name": "ddo",
    "per_page": 10,
    "q": "0x123"
  },
  "search_time_ms": 1,
  "hits": [
    {
      "highlights": [
        {
          "field": "nftAddress",
          "snippet": "<mark>0x123</mark>",
          "matched_tokens": ["0x123"]
        }
      ],
      "document": {
        "@context": ["https://w3id.org/did/v1"],
        "id": "did:op:ACce67694eD2848dd683c651Dab7Af823b7dd123",
        "version": "4.1.0",
        "chainId": 1,
        "nftAddress": "0x123",
        ...
      },
      "text_match": 130916
    }
  ]
}]
```

---

## Get DDO

### `HTTP` POST /directCommand

### `P2P` command: getDDO

#### Description

returns document by id

#### Parameters

| name    | type   | required | description                          |
| ------- | ------ | -------- | ------------------------------------ |
| command | string | v        | command name                         |
| node    | string |          | if not present it means current node |
| id      | string | v        | document id or did                   |

#### Request

```json
{
  "command": "getDDO",
  "node": "PeerId",
  "id": "did:op:123"
}
```

#### Response

```
{
  "@context": ["https://w3id.org/did/v1"],
  "id": "did:op:ACce67694eD2848dd683c651Dab7Af823b7dd123",
  "version": "4.1.0",
  "chainId": 1,
  "nftAddress": "0x123",
  ...
}
```

---

## Encrypt

### `HTTP` POST /directCommand

### `P2P` command: encrypt

#### Description

returns encrypted blob

#### Parameters

| name           | type   | required | description                          |
| -------------- | ------ | -------- | ------------------------------------ |
| command        | string | v        | command name                         |
| node           | string |          | if not present it means current node |
| blob           | string | v        | blob data                            |
| encoding       | string | v        | data encoding `string or base58`     |
| encryptionType | string | v        | encrypt method `AES or ECIES`        |

#### Request

```json
{
  "command": "encrypt",
  "node": "PeerId",
  "blob": "123",
  "encoding": "0x123",
  "encryptionType": "0x123"
}
```

#### Response

```
0x123
```

---

## Nonce

### `HTTP` POST /directCommand

### `P2P` command: nonce

#### Description

returns stored nonce for an address

#### Parameters

| name    | type   | required | description                          |
| ------- | ------ | -------- | ------------------------------------ |
| command | string | v        | command name                         |
| node    | string |          | if not present it means current node |
| address | string | v        | consumer address                     |

#### Request

```json
{
  "command": "nonce",
  "node": "PeerId",
  "address": "0x123"
}
```

#### Response

```
123
```

---

## Decrypt DDO

### `HTTP` POST /directCommand

### `P2P` command: decryptDDO

#### Description

returns decrypted document

#### Parameters

| name              | type   | required | description                                                                                   |
| ----------------- | ------ | -------- | --------------------------------------------------------------------------------------------- |
| command           | string | v        | command name                                                                                  |
| node              | string |          | if not present it means current node                                                          |
| decrypterAddress  | string | v        | decrypter address                                                                             |
| chainId           | number | v        | chain id of network on which document is provided                                             |
| transactionId     | string |          | tx id of encrypted document                                                                   |
| dataNftAddress    | string |          | address of nft token                                                                          |
| encryptedDocument | string |          | encrypted document                                                                            |
| flags             | number |          | metadata flags if DDO is ECIES encrypted or lzma compressed                                   |
| documentHash      | string |          | hash based on sha256 of asset                                                                 |
| nonce             | string | v        | is required to verify a request paired with a signature                                       |
| signature         | string | v        | signed message based on `transactionId + dataNftAddress + decrypterAddress + chainId + nonce` |

#### Request

```json
{
  "command": "decryptDDO",
  "node": "PeerId",
  "decrypterAddress": "0x123",
  "chainId": 123,
  "transactionId": "0x123",
  "dataNftAddress": "0x123",
  "encryptedDocument": "0x123",
  "flags": 1,
  "documentHash": "0x123",
  "nonce": "123",
  "signature": "0x123"
}
```

#### Response

```
{
  "@context": ["https://w3id.org/did/v1"],
  "id": "did:op:ACce67694eD2848dd683c651Dab7Af823b7dd123",
  "version": "4.1.0",
  "chainId": 1,
  "nftAddress": "0x123",
  ...
}
```

---

## Download

### `HTTP` POST /directCommand

### `P2P` command: download

#### Description

returns a file stream of the requested file

#### Parameters

| name              | type   | required | description                                                                              |
| ----------------- | ------ | -------- | ---------------------------------------------------------------------------------------- |
| command           | string | v        | command name                                                                             |
| node              | string |          | if not present it means current node                                                     |
| fileIndex         | number | v        | file index in the list of document files                                                 |
| documentId        | string | v        | document id or did                                                                       |
| serviceId         | string | v        | service id of array of services defining access to the asset                             |
| transferTxId      | string | v        | tx id of transaction for approval of datatokens transfer given to the provider's account |
| nonce             | string | v        | is required to verify a request paired with a signature                                  |
| consumerAddress   | string | v        | consumer address                                                                         |
| signature         | string | v        | signed message based on `did + nonce`                                                    |
| aes_encrypted_key | string |          | encrypted key for cipher to decrypt file                                                 |

#### Request

```json
{
  "command": "download",
  "node": "PeerId",
  "fileIndex": 0,
  "documentId": "did:op:123",
  "serviceId": "0",
  "transferTxId": "0x123",
  "nonce": "123",
  "consumerAddress": "0x123",
  "signature": "0x123",
  "aes_encrypted_key": "0x123"
}
```

#### Response

```
byte array
```

---

## Get indexing queue

### `HTTP` GET /api/services/indexQueue

#### Description

returns the current indexing queue, as an array of objects

#### Response

```
{
  queue: []
}
```

## PolicyServer Passthrough

### `HTTP` POST /api/services/PolicyServerPassthrough

### `P2P` command: PolicyServerPassthrough

#### Description

Forwards request to PolicyServer (if any).

This endpoint is not authenticated. The node forwards the caller-supplied payload and adds
the resolved `ddo` plus its own `nodeAddress`. Caller-supplied identity fields are not
verified.

#### Parameters

| name                    | type   | required | description                                    |
| ----------------------- | ------ | -------- | ---------------------------------------------- |
| command                 | string | v        | command name                                   |
| node                    | string |          | if not present it means current node           |
| policyServerPassthrough | object | v        | command and params for PolicyServer (see docs) |

#### HTTP Example

```json
{
  "policyServerPassthrough": {
    "action": "newDDO",
    "rawDDO": {},
    "chainId": 1,
    "txId": "0x123",
    "eventRaw": "raw event data"
  }
}
```

#### P2P Example

```json
{
  "command": "PolicyServerPassthrough",
  "node": "PeerId",
  "policyServerPassthrough": {
    "action": "newDDO",
    "rawDDO": {},
    "chainId": 1,
    "txId": "0x123",
    "eventRaw": "raw event data"
  }
}
```

#### Responses

| code | description                                                     |
| ---- | --------------------------------------------------------------- |
| 200  | PolicyServer allowed the request; its response body is returned |
| 400  | missing/invalid parameters                                      |

---

## initializePSVerification

### `HTTP` POST /api/services/initializePSVerification

### `P2P` command: PolicyServerInitialize

#### Description

Asks the PolicyServer to start a verification flow (`initiate` action) for a given
asset/service and consumer. This endpoint requires an `Authorization` header or a
`nonce` + `signature` pair.

This is a distinct command from `PolicyServerPassthrough`, so the signed message uses its
own command string: `consumerAddress + nonce + "PolicyServerInitialize"`.

The verified `consumerAddress` is the one forwarded to the PolicyServer; the caller's
`authorization`, `nonce` and `signature` are added to the `policyServer` object.

#### Parameters

| name            | type   | required | description                                          |
| --------------- | ------ | -------- | ---------------------------------------------------- |
| documentId      | string | v        | the asset DID                                        |
| serviceId       | string | v        | the service id within the asset                      |
| consumerAddress | string | v        | the caller's address                                 |
| policyServer    | any    | v        | free-form data passed to the PolicyServer            |
| nonce           | string |          | required unless an `Authorization` token is supplied |
| signature       | string |          | required unless an `Authorization` token is supplied |

#### HTTP Example

```json
{
  "documentId": "did:op:1234",
  "serviceId": "0",
  "consumerAddress": "0x9876543210fedcba9876543210fedcba98765432",
  "nonce": "1",
  "signature": "0x123",
  "policyServer": {}
}
```

#### Responses

| code | description                       |
| ---- | --------------------------------- |
| 200  | PolicyServer response body        |
| 400  | missing/invalid parameters        |
| 401  | missing or invalid authentication |
| 404  | asset not found                   |
| 503  | DDO database not available        |

---

## Fetch Config

### `HTTP` GET /api/admin/config

#### Description

returns current node configuration with sensitive data hidden (admin only)

#### Parameters

| name            | type   | required | description                                  |
| --------------- | ------ | -------- | -------------------------------------------- |
| expiryTimestamp | number | v        | expiry timestamp for the request             |
| signature       | string | v        | signed message to authenticate admin request |

#### Request

```json
{
  "expiryTimestamp": 1234567890,
  "signature": "0x123"
}
```

#### Response

```json
{
  "keys": {
    "privateKey": "[*** HIDDEN CONTENT ***]"
  },
  "chainIds": [1],
  "rpcs": { "1": "https://eth-mainnet.g.alchemy.com/v2/..." },
  "...": "..."
}
```

---

## Update Config

### `HTTP` POST /api/admin/config/update

#### Description

updates node configuration and reloads it gracefully (admin only)

#### Parameters

| name            | type   | required | description                                        |
| --------------- | ------ | -------- | -------------------------------------------------- |
| expiryTimestamp | number | v        | expiry timestamp for the request                   |
| signature       | string | v        | signed message to authenticate admin request       |
| config          | object | v        | partial configuration object with fields to update |

#### Request

```json
{
  "expiryTimestamp": 1234567890,
  "signature": "0x123",
  "config": {
    "chainIds": [1],
    "rpcs": { "1": "https://eth-mainnet.g.alchemy.com/v2/..." }
  }
}
```

#### Response

```json
{
  "keys": {
    "privateKey": "[*** HIDDEN CONTENT ***]"
  },
  "chainIds": [1],
  "rpcs": { "1": "https://eth-mainnet.g.alchemy.com/v2/..." },
  "...": "..."
}
```

---

## Get Escrow Events

### `HTTP` GET /api/services/escrow/events?

### `HTTP` POST /directCommand

### `P2P` command: getEscrowEvents

#### Description

Returns indexed Escrow contract events. The indexer matches Escrow logs by topic hash, verifies they came from the chain's `Escrow` contract (`Deposit`/`Withdraw`/`Lock` are generic signatures), and stores one row per event in the append-only `escrow` collection keyed by `${txHash}-${logIndex}`. All filters are optional.

#### Parameters

| name      | type   | required  | description                                               |
| --------- | ------ | --------- | --------------------------------------------------------- |
| command   | string | POST only | command name (`getEscrowEvents`)                          |
| chainId   | number |           | chain id                                                  |
| eventType | string |           | one of `Auth, Lock, Claimed, Canceled, Deposit, Withdraw` |
| payer     | string |           | payer address (case-insensitive)                          |
| payee     | string |           | payee address (case-insensitive)                          |
| token     | string |           | token address (case-insensitive)                          |
| jobId     | string |           | compute job id                                            |
| txId      | string |           | transaction hash                                          |
| offset    | number |           | rows to skip (default 0)                                  |
| size      | number |           | page size (default 100, max 250)                          |

#### Request (POST /directCommand)

```json
{
  "command": "getEscrowEvents",
  "chainId": 8996,
  "eventType": "Deposit",
  "offset": 0,
  "size": 50
}
```

#### Response

Every row has `id, eventType, chainId, contract, block, txHash` plus event-specific fields (`payer, payee, token, jobId, amount, expiry, proof, maxLockedAmount, maxLockSeconds, maxLockCounts`).

```json
[
  {
    "id": "0x39f3...6575-3",
    "eventType": "Deposit",
    "chainId": 8996,
    "contract": "0x282d...a1a1",
    "block": 55,
    "txHash": "0x39f3...6575",
    "payer": "0xbe54...ab5e",
    "token": "0x282d...a1a1",
    "amount": "100000000000000000000"
  }
]
```

---

## Get Node Metrics

### `HTTP` GET /nodeMetrics

### `HTTP` POST /directCommand

### `P2P` command: getNodeMetrics

#### Description

Returns a live per-node resource snapshot, rolled up across every C2D engine (the same aggregate the telemetry layer exports) blended with host `os` readings. Read-only, no parameters. `hasAggregate` is a freshness flag: when `false`, no engine had a fresh compute aggregate (metrics collection is disabled via `C2D_METRICS_INTERVAL_SECONDS=0`, or nothing has been sampled yet) and every scalar is a structural zero rather than a genuine reading. The snapshot is returned either way.

#### Parameters

| name    | type   | required  | description                     |
| ------- | ------ | --------- | ------------------------------- |
| command | string | POST only | command name (`getNodeMetrics`) |

#### Response

```json
{
  "collectedAt": 1730370000000,
  "hasAggregate": true,
  "cpu": {
    "usagePercent": 42.5,
    "coresAllocated": 4,
    "hostCores": 16,
    "throttledCount": 0,
    "loadAverage": [1.2, 1.1, 0.9]
  },
  "memory": {
    "usedBytes": 2147483648,
    "limitBytes": 8589934592,
    "hostFreeBytes": 12000000000,
    "hostTotalBytes": 34359738368
  },
  "disk": { "usedBytes": 1073741824 },
  "network": { "rxBytes": 12345, "txBytes": 6789 },
  "jobs": { "running": 1, "runningFree": 0, "queued": 0, "queuedFree": 0 },
  "gpu": [
    {
      "resourceId": "0",
      "vendor": "nvidia",
      "utilizationPercent": 55,
      "memoryUsedBytes": 2000000000,
      "memoryTotalBytes": 16000000000,
      "temperatureC": 61,
      "powerWatts": 120
    }
  ],
  "env": [{ "env": "env-hash", "resource": "cpu", "total": 16, "inUse": 4 }],
  "meta": { "sampledContainers": 1, "oldestSampleAgeSeconds": 8 }
}
```

---

## Get Node Metrics History

### `HTTP` GET /nodeMetrics/history?startTime=&stopTime=

### `HTTP` POST /directCommand

### `P2P` command: getNodeMetricsHistory

#### Description

Returns ordered hourly averages of the per-node resource snapshot, persisted to SQLite by the sampler/roll-up cron jobs and retained for `NODE_METRICS_RETENTION_DAYS` (default 180). Scalars are arithmetic means over the hour's minute-samples; `sampleCount` is how many samples fed each bucket; GPU entries are averaged per `resourceId`, env entries per `env`+`resource`. Requires the node-metrics database (returns `503` when unavailable, e.g. history disabled via `NODE_METRICS_HISTORY_ENABLED=false`).

When the requested range includes the current, in-progress hour, the last bucket is a **live** average computed on the fly from the raw samples collected so far this hour (before the top-of-hour roll-up has stored it). It is flagged `"partial": true` and is the only bucket that carries that flag; every completed hour is a finalized, stored average. This lets a caller see fresh data without waiting for the hourly roll-up.

#### Parameters

| name      | type          | required | description                                                                        |
| --------- | ------------- | -------- | ---------------------------------------------------------------------------------- |
| command   | string        | POST only | command name (`getNodeMetricsHistory`)                                             |
| startTime | number/string |          | range start — epoch ms or ISO-8601. Defaults to now minus the retention window     |
| stopTime  | number/string |          | range end — epoch ms or ISO-8601. Defaults to now                                  |

`startTime` must be earlier than `stopTime` (else `400`); the range is clamped to the retention window and the row count is capped.

#### Request (POST /directCommand)

```json
{
  "command": "getNodeMetricsHistory",
  "startTime": 1727778000000,
  "stopTime": 1730370000000
}
```

#### Response

```json
{
  "startTime": 1727778000000,
  "stopTime": 1730370000000,
  "count": 1,
  "buckets": [
    {
      "hourStart": 1730368800000,
      "sampleCount": 60,
      "cpu": { "usagePercent": 40.1, "coresAllocated": 4, "hostCores": 16, "throttledCount": 0 },
      "memory": {
        "usedBytes": 2000000000,
        "limitBytes": 8589934592,
        "hostFreeBytes": 12000000000,
        "hostTotalBytes": 34359738368
      },
      "disk": { "usedBytes": 1073741824 },
      "network": { "rxBytes": 12000, "txBytes": 6000 },
      "jobs": { "running": 1, "runningFree": 0, "queued": 0, "queuedFree": 0 },
      "gpu": [{ "resourceId": "0", "vendor": "nvidia", "utilizationPercent": 50 }],
      "env": [{ "env": "env-hash", "resource": "cpu", "total": 16, "inUse": 4 }],
      "meta": { "sampledContainers": 1 }
    }
  ]
}
```

---

# Compute

For starters, you can find a list of algorithms in the [Ocean Algorithms repository](https://github.com/oceanprotocol/algo_dockers) and the docker images in the [Algo Dockerhub](https://hub.docker.com/r/oceanprotocol/algo_dockers/tags).

## Compute object definitions

### Dataset (`ComputeAsset` Interface)

The `ComputeAsset` interface defines the structure of a compute asset in the Ocean Node. It can include information about the file object, document ID, service ID, transfer transaction ID, and user data.

#### Properties

- **fileObject**: Optional. An object of type `BaseFileObject` representing the file associated with the compute asset.
- **documentId**: Optional. A string representing the document ID of the compute asset.
- **serviceId**: Optional. A string representing the service ID associated with the compute asset.
- **transferTxId**: Optional. A string representing the transaction ID for the transfer of the compute asset.
- **userdata**: Optional. An object containing additional user-defined data related to the compute asset.

```typescript
export interface ComputeAsset {
  fileObject?: BaseFileObject
  documentId?: string
  serviceId?: string
  transferTxId?: string
  userdata?: { [key: string]: any }
}
```

This interface is used to encapsulate the details of a compute asset, which can be utilized in various compute-related operations within the Ocean Node.

### `ComputeAlgorithm` Interface

The `ComputeAlgorithm` interface defines the structure of a compute algorithm in the Ocean Node.
It can include information about the file object, document ID, service ID, transfer transaction ID, algorithm custom data, metadata and user data.

#### Properties

- **documentId**: Optional. A string representing the document ID of the compute algorithm.
- **serviceId**: Optional. A string representing the service ID associated with the compute algorithm.
- **fileObject**: Optional. An object of type `BaseFileObject` representing the file associated with the compute algorithm.
- **meta**: Optional. An object of type `MetadataAlgorithm` containing metadata related to the compute algorithm.
- **transferTxId**: Optional. A string representing the transaction ID for the transfer of the compute algorithm.
- **algocustomdata**: Optional. An object containing additional custom data related to the compute algorithm.
- **userdata**: Optional. An object containing additional user-defined data related to the compute algorithm.
- **envs**: Optional. Array of keys:values to be used as environment variables for algo.

```typescript
export interface ComputeAlgorithm {
  documentId?: string
  serviceId?: string
  fileObject?: BaseFileObject
  meta?: MetadataAlgorithm
  transferTxId?: string
  algocustomdata?: { [key: string]: any }
  userdata?: { [key: string]: any }
}
```

This interface is used to encapsulate the details of a compute algorithm, which can be utilized in various compute-related operations within the Ocean Node.

## Compute commands

### `HTTP` GET /api/services/computeEnvironments

### `P2P` command: getComputeEnvironments

#### Description

fetch all compute environments

#### Response

```json
[
  {
    "id": "0x7d187e4c751367be694497ead35e2937ece3c7f3b325dcb4f7571e5972d092bd-0xf173fdc0a9c7cc1c34f8aaf6b3aafe866795851b567436e1d4fbab17b0e26ca1",
    "runningJobs": 0,
    "consumerAddress": "0xf9C5B7eE7708efAc6dC6Bc7d4b0455eBbf22b519",
    "platform": { "architecture": "x86_64", "os": "Ubuntu 22.04.3 LTS" },
    "fees": { "1": [[{ "feeToken": "0x123", "prices": [{ "id": "cpu", "price": 1 }] }]] },
    "storageExpiry": 604800,
    "maxJobDuration": 3600,
    "minJobDuration": 60,
    "maxServiceDuration": 86400,
    "resources": [
      { "id": "cpu", "total": 16, "max": 16, "min": 1, "inUse": 0 },
      {
        "id": "ram",
        "total": 33617674240,
        "max": 33617674240,
        "min": 1000000000,
        "inUse": 0
      },
      { "id": "disk", "total": 1000000000, "max": 1000000000, "min": 0, "inUse": 0 }
    ],
    "free": {
      "maxJobDuration": 60,
      "minJobDuration": 10,
      "maxJobs": 3,
      "resources": [
        { "id": "cpu", "max": 1, "inUse": 0 },
        { "id": "ram", "max": 1000000000, "inUse": 0 },
        { "id": "disk", "max": 1000000000, "inUse": 0 }
      ]
    },
    "runningfreeJobs": 0
  }
]
```

`maxJobDuration` / `minJobDuration` apply to **compute jobs**. Services use
`maxServiceDuration` instead: the hard cap SERVICE_START validates a requested `duration`
against, and the ceiling SERVICE_EXTEND caps the resulting remaining window to. It defaults to
the daemon's `serviceOnDemand.maxDurationSeconds` and can be lowered per environment with
that environment's own `maxServiceDuration` (a larger per-env value is clamped to the daemon
ceiling at startup), so environments on the same engine may report different values.
Services have no minimum duration — any value above 0 is accepted, then billed at the
`minJobDuration` floor, rounded up to whole minutes.

The field is additive: an older node omits it, so treat a missing value as the 86400 s
(24 h) default rather than falling back to `maxJobDuration`, which is a different limit and
is often much smaller.

### `HTTP` POST /api/services/freeCompute

### `P2P` command: freeStartCompute

#### Description

starts a free compute job and returns jobId if succesfull

#### Parameters

| name                        | type   | required | description                                                                                                                                                                                                                                        |
| --------------------------- | ------ | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| command                     | string | v        | command name                                                                                                                                                                                                                                       |
| node                        | string |          | if not present it means current node                                                                                                                                                                                                               |
| consumerAddress             | string | v        | consumer address                                                                                                                                                                                                                                   |
| signature                   | string | v        | signature (msg=String(nonce) )                                                                                                                                                                                                                     |
| nonce                       | string | v        | nonce for the request                                                                                                                                                                                                                              |
| datasets                    | object |          | list of ComputeAsset to be used as inputs                                                                                                                                                                                                          |
| algorithm                   | object |          | ComputeAlgorithm definition                                                                                                                                                                                                                        |
| environment                 | string | v        | compute environment to use                                                                                                                                                                                                                         |
| resources                   | object |          | optional list of required resources                                                                                                                                                                                                                |
| metadata                    | object |          | optional metadata for the job, data provided by the user                                                                                                                                                                                           |
| additionalViewers           | object |          | optional array of addresses that are allowed to fetch the result                                                                                                                                                                                   |
| queueMaxWaitTime            | number |          | optional max time in seconds a job can wait in the queue before being started                                                                                                                                                                      |
| encryptedDockerRegistryAuth | string |          | Ecies encrypted docker auth schema for image (see [Private Docker Registries with Per-Job Authentication](../env.md#private-docker-registries-with-per-job-authentication))                                                                        |
| output                      | string |          | Ecies encrypted with instructions for uploading compute results (see [C2D result upload to remote storage](../Storage.md#c2d-result-upload-to-remote-storage))                                                                                     |
| outputBucketId              | string |          | persistent-storage bucket id; the bucket is mounted at /data/outputs and results are stored there as individual files. Mutually exclusive with `output` (see [persistent storage](../persistentStorage.md#using-a-bucket-for-compute-job-outputs)) |

#### Request

```json
{
  "command": "freeStartCompute",
  "datasets": [],
  "algorithm": {
    "meta": { "container": { "image": "ubuntu", "entrypoint": "/bin/bash'" } }
  },
  "consumerAddress": "0x00",
  "signature": "123",
  "nonce": 1,
  "environment": "0x7d187e4c751367be694497ead35e2937ece3c7f3b325dcb4f7571e5972d092bd-0xbeaf12703d708f39ef98c3d8939ce458553254176dbb69fe83d535883c4cee38",
  "resources": [{ "id": "cpu", "amount": 1 }],
  "metadata": { "key": "value" }
}
```

#### Response

```json
[
  {
    "owner": "0x00",
    "jobId": "0x7d187e4c751367be694497ead35e2937ece3c7f3b325dcb4f7571e5972d092bd-a4ad237d-dfd8-404c-a5d6-b8fc3a1f66d3",
    "dateCreated": "1742291065.119",
    "dateFinished": null,
    "status": 0,
    "statusText": "Job started",
    "results": [],
    "agreementId": null,
    "expireTimestamp": 1742291065.119,
    "environment": "0x7d187e4c751367be694497ead35e2937ece3c7f3b325dcb4f7571e5972d092bd-0xf173fdc0a9c7cc1c34f8aaf6b3aafe866795851b567436e1d4fbab17b0e26ca1",
    "resources": [
      { "id": "cpu", "amount": 1 },
      { "id": "ram", "amount": 1000000000 },
      { "id": "disk", "amount": 0 }
    ],
    "isFree": true,
    "metadata": { "key": "value" }
  }
]
```

### `HTTP` GET /api/services/compute

### `P2P` command: getComputeStatus

#### Description

returns job status

#### Parameters

Required at least one of the following parameters:

| name            | type    | required | description                                                                                                  |
| --------------- | ------- | -------- | ------------------------------------------------------------------------------------------------------------ |
| consumerAddress | string  |          | consumer address to use as filter                                                                            |
| jobId           | string  |          | jobId address to use as filter                                                                               |
| agreementId     | string  |          | agreementId address to use as filter                                                                         |
| includeMetrics  | boolean |          | override the runtime-metrics default (`true` = require them, `false` = never). See note below. |
| signature       | string  |          | signature over `consumerAddress` + `nonce` + `command` (or an auth token) — authenticates the owner |
| nonce           | string  |          | request nonce, paired with `signature`                                                             |

**Runtime metrics are owner-only and returned BY DEFAULT.** If the request carries owner credentials
(`consumerAddress` plus `signature`/`nonce`, or an `Authorization` header token), each job owned by
(or shared with) that address comes back with a `runtimeMetrics` object — no flag needed.

`includeMetrics` only overrides that default:

| `includeMetrics` | behavior |
| --- | --- |
| omitted (default) | Metrics attached when owner credentials are present and valid. A request without credentials — the plain, unauthenticated status call — returns `200` with no metrics, exactly as before. Invalid credentials likewise just mean no metrics. |
| `true` | Metrics are **required**: missing `consumerAddress` answers `400`, failed authentication `401`. Use it when you want to know *why* metrics are absent instead of getting a silently trimmed response. |
| `false` | Metrics are never attached (and the node skips the auth round-trip). |

Metrics never reach a non-owner, and are never part of the on-chain escrow claim proof. They are
best-effort and up to one sampling interval stale (see [compute.md](compute.md) and
`C2D_METRICS_INTERVAL_SECONDS` in [env.md](env.md)).

#### Response

```json
[
  {
    "owner": "0x00",
    "did": null,
    "jobId": "a4ad237d-dfd8-404c-a5d6-b8fc3a1f66d3",
    "dateCreated": "1742291065.119",
    "dateFinished": null,
    "status": 0,
    "statusText": "Job started",
    "results": [],
    "inputDID": null,
    "algoDID": null,
    "agreementId": null,
    "expireTimestamp": 1742291065.119,
    "environment": "0x7d187e4c751367be694497ead35e2937ece3c7f3b325dcb4f7571e5972d092bd-0xf173fdc0a9c7cc1c34f8aaf6b3aafe866795851b567436e1d4fbab17b0e26ca1",
    "resources": [
      {
        "id": "cpu",
        "amount": 1
      },
      {
        "id": "ram",
        "amount": 1000000000
      },
      {
        "id": "disk",
        "amount": 1000000000
      }
    ],
    "isFree": true,
    "metadata": { "key": "value" }
  }
]
```

When called with owner credentials, each owned job additionally carries a `runtimeMetrics` object
(see [The `runtimeMetrics` object](#the-runtimemetrics-object) below).

---

### The `runtimeMetrics` object

`runtimeMetrics` is an optional snapshot of live container stats, returned on
`COMPUTE_GET_STATUS` / `SERVICE_GET_STATUS` to the **authenticated owner** of the job or service —
by default, without asking for it. It never reaches anyone else, and `includeMetrics=false` opts out.
Clients MUST treat every part as optional and render a field only when present.

**Semantics clients should surface to users:**

- **Best-effort & slightly stale.** Sampled on a fixed cadence (`C2D_METRICS_INTERVAL_SECONDS`,
  default 10s), so values can be up to one interval old. `collectedAt` is the sample time — show it
  (e.g. "as of 8s ago").
- **May be missing entirely.** No snapshot yet (job just started), collection disabled on the node
  (`C2D_METRICS_INTERVAL_SECONDS=0`), or a transient sampling failure ⇒ no `runtimeMetrics` field.
  This is normal, not an error.
- **`null` vs absent for GPU numbers.** Inside a `gpu[]` entry, a `null` metric means "the backend
  could not read it" — display as "n/a", never as `0`.
- **Bytes are raw bytes**; percentages are rounded to two decimals — memory/disk/GPU are `0–100`,
  but CPU `usagePercent` can exceed `100` across multiple cores (see the CPU table); durations are
  seconds; the final snapshot after a job/service ends carries the peak/exit values.

#### Top-level fields

| field           | type    | unit / notes                                                                                     |
| --------------- | ------- | ------------------------------------------------------------------------------------------------ |
| collectedAt     | string  | ISO-8601 timestamp of the sample                                                                 |
| containerState  | object  | see below — status + structured exit info                                                        |
| cpu             | object  | see below                                                                                        |
| memory          | object  | see below                                                                                        |
| disk            | object  | see below                                                                                        |
| network         | object? | `{ rxBytes, txBytes }`; **absent** when the container runs with no network (`NetworkMode: none`)  |
| blockIO         | object  | `{ readBytes, writeBytes }` — cumulative disk I/O in bytes                                        |
| pids            | object  | `{ current, limit }` — process/thread count vs the container PID limit (512)                      |
| gpu             | array?  | one entry per GPU the job/service holds; **absent** for CPU-only jobs or when GPU metrics are off |

`containerState`:

| field        | type     | notes                                                                    |
| ------------ | -------- | ------------------------------------------------------------------------ |
| status       | string   | e.g. `running`, `exited`                                                 |
| startedAt    | string?  | ISO-8601                                                                 |
| finishedAt   | string?  | ISO-8601; present once the container has stopped                         |
| exitCode     | number?  | process exit code (present after exit)                                   |
| oomKilled    | boolean  | `true` if the kernel OOM-killed the container                            |
| error        | string?  | Docker-reported error string, if any                                     |
| restartCount | number   | container restarts                                                       |
| health       | string?  | Docker HEALTHCHECK status when the image defines one (e.g. `healthy`)    |

`cpu`:

| field                  | type   | unit / notes                                                                    |
| ---------------------- | ------ | ------------------------------------------------------------------------------- |
| usagePercent           | number | % of one host CPU-second per wall-second (docker-stats formula), `0–N×100`       |
| allocated              | number | CPU cores requested by the job (`0` when unconstrained)                          |
| usagePercentOfAllocated| number | `usagePercent / allocated` — "how saturated is what you paid for" (`0` if alloc 0)|
| cumulativeSeconds      | number | total CPU-seconds consumed since start (monotonic; billing-grade)                |
| throttledPeriods       | number | CFS quota throttling events — high ⇒ the CPU request is too small                |
| throttledSeconds       | number | total time throttled, seconds                                                    |

`memory`:

| field          | type   | unit / notes                                             |
| -------------- | ------ | -------------------------------------------------------- |
| usageBytes     | number | working-set bytes (`usage − inactive_file`, cgroup v2)   |
| limitBytes     | number | memory limit (= allocated RAM) in bytes                  |
| usagePercent   | number | `usageBytes / limitBytes × 100`                          |
| peakUsageBytes | number | max `usageBytes` observed across samples                 |

`disk`:

| field        | type    | unit / notes                                                                       |
| ------------ | ------- | ---------------------------------------------------------------------------------- |
| usedBytes    | number  | compute jobs: bytes written under `/` (excludes base image); services: writable layer |
| quotaBytes   | number? | present only for jobs with a `disk` resource                                        |
| usagePercent | number? | present only when `quotaBytes` is known                                             |

`gpu[]` entry:

| field              | type            | unit / notes                                                          |
| ------------------ | --------------- | --------------------------------------------------------------------- |
| resourceId         | string          | the requested resource id (`gpu0`, `gpu1`, …) — maps the entry to a device |
| vendor             | string          | `nvidia` (only NVIDIA is emitted today; `amd`/`intel` reserved)        |
| utilizationPercent | number \| null  | GPU busy % (`null` = unreadable)                                       |
| memoryUsedBytes    | number \| null  | VRAM used                                                              |
| memoryTotalBytes   | number \| null  | total VRAM                                                             |
| temperatureC       | number?         | °C, when available                                                    |
| powerWatts         | number?         | current draw, W, when available                                       |
| shared             | boolean?        | `true` ⇒ device is shareable and the number may include other jobs    |

> Note: the node also keeps an internal delta accumulator on the stored snapshot; it is stripped
> from the response and clients will never see it.

#### Example `runtimeMetrics`

```json
{
  "collectedAt": "2026-07-29T12:00:10.000Z",
  "containerState": {
    "status": "running",
    "startedAt": "2026-07-29T11:59:30.000Z",
    "oomKilled": false,
    "restartCount": 0
  },
  "cpu": {
    "usagePercent": 182.4,
    "allocated": 2,
    "usagePercentOfAllocated": 91.2,
    "cumulativeSeconds": 73.1,
    "throttledPeriods": 12,
    "throttledSeconds": 0.4
  },
  "memory": {
    "usageBytes": 734003200,
    "limitBytes": 1073741824,
    "usagePercent": 68.36,
    "peakUsageBytes": 812345678
  },
  "disk": { "usedBytes": 524288000, "quotaBytes": 10737418240, "usagePercent": 4.88 },
  "network": { "rxBytes": 10485760, "txBytes": 2097152 },
  "blockIO": { "readBytes": 41943040, "writeBytes": 8388608 },
  "pids": { "current": 24, "limit": 512 },
  "gpu": [
    {
      "resourceId": "gpu0",
      "vendor": "nvidia",
      "utilizationPercent": 77,
      "memoryUsedBytes": 1073741824,
      "memoryTotalBytes": 3221225472,
      "temperatureC": 55,
      "powerWatts": 90
    }
  ]
}
```

### `HTTP` GET /api/services/computeResult

### `P2P` command: getComputeResult

#### Description

returns job result

#### Parameters

| name            | type   | required | description                                                    |
| --------------- | ------ | -------- | -------------------------------------------------------------- |
| consumerAddress | string | v        | consumer address to use as filter                              |
| jobId           | string | v        | jobId address to use as filter                                 |
| signature       | string | v        | signature (consumerAddress + jobId + index.toString() + nonce) |
| nonce           | string | v        | nonce for the request                                          |
| index           | number | v        | index of result (0 for main result, 1 for logs)                |

#### Response

File content

---

## Persistent Storage

### `HTTP` POST /api/services/persistentStorage/buckets

#### Description

Create a new persistent storage bucket. Bucket ownership is set to the request `consumerAddress`.

#### Request Headers

| name          | type   | required | description                                               |
| ------------- | ------ | -------- | --------------------------------------------------------- |
| Authorization | string |          | auth token (optional; depends on node auth configuration) |

#### Request Body

```json
{
  "consumerAddress": "0x...",
  "signature": "0x...",
  "nonce": "123",
  "accessLists": []
}
```

#### Response (200)

```json
{
  "bucketId": "uuid",
  "owner": "0x...",
  "accessList": []
}
```

---

### `HTTP` GET /api/services/persistentStorage/buckets

#### Description

List buckets for a given `owner`. Results are filtered by bucket access lists for the calling consumer.

#### Query Parameters

| name            | type   | required | description                                        |
| --------------- | ------ | -------- | -------------------------------------------------- |
| consumerAddress | string | v        | consumer address                                   |
| signature       | string | v        | signed message (consumerAddress + nonce + command) |
| nonce           | string | v        | request nonce                                      |
| chainId         | number | v        | chain id (used by auth/signature checks)           |
| owner           | string | v        | bucket owner to filter by                          |

#### Response (200)

```json
[
  {
    "bucketId": "uuid",
    "owner": "0x...",
    "createdAt": 1710000000,
    "accessLists": []
  }
]
```

---

### `HTTP` GET /api/services/persistentStorage/buckets/:bucketId/files

#### Description

List files in a bucket.

#### Query Parameters

| name            | type   | required | description                                        |
| --------------- | ------ | -------- | -------------------------------------------------- |
| consumerAddress | string | v        | consumer address                                   |
| signature       | string | v        | signed message (consumerAddress + nonce + command) |
| nonce           | string | v        | request nonce                                      |

#### Response (200)

```json
[
  {
    "bucketId": "uuid",
    "name": "hello.txt",
    "size": 123,
    "lastModified": 1710000000
  }
]
```

---

### `HTTP` GET /api/services/persistentStorage/buckets/:bucketId/files/:fileName/object

#### Description

Return the `fileObject` for a specific file in a bucket (useful for passing references to other subsystems like compute).

#### Query Parameters

| name            | type   | required | description                                        |
| --------------- | ------ | -------- | -------------------------------------------------- |
| consumerAddress | string | v        | consumer address                                   |
| signature       | string | v        | signed message (consumerAddress + nonce + command) |
| nonce           | string | v        | request nonce                                      |

#### Response (200)

```json
{
  "type": "nodePersistentStorage",
  "bucketId": "uuid",
  "fileName": "hello.txt"
}
```

---

### `HTTP` GET /api/services/persistentStorage/buckets/:bucketId/files/:fileName

#### Description

Download a file from a bucket. The response body is the raw file bytes. Enforces the bucket
access list (the consumer must be the bucket owner or on the bucket ACL). The same operation is
available as the `persistentStorageDownloadFile` P2P command, which streams the raw bytes back
identically.

#### Query Parameters

| name            | type   | required | description                                        |
| --------------- | ------ | -------- | -------------------------------------------------- |
| consumerAddress | string | v        | consumer address                                   |
| signature       | string | v        | signed message (consumerAddress + nonce + command) |
| nonce           | string | v        | request nonce                                      |

#### Response (200)

Raw file bytes, sent with:

- `Content-Type: application/octet-stream`
- `Content-Disposition: attachment; filename="<fileName>"`
- `Content-Length` (best-effort)

#### Errors

| status | when                                                        |
| ------ | ---------------------------------------------------------- |
| 403    | consumer is not the bucket owner and not on the bucket ACL |
| 404    | file not found in the bucket                                |

---

### `HTTP` POST /api/services/persistentStorage/buckets/:bucketId/files/:fileName

#### Description

Upload a file to a bucket. The request body is treated as raw bytes.

#### Query Parameters

| name            | type   | required | description                                        |
| --------------- | ------ | -------- | -------------------------------------------------- |
| consumerAddress | string | v        | consumer address                                   |
| signature       | string | v        | signed message (consumerAddress + nonce + command) |
| nonce           | string | v        | request nonce                                      |

#### Request Body

Raw bytes (any content-type).

#### Response (200)

```json
{
  "bucketId": "uuid",
  "name": "hello.txt",
  "size": 123,
  "lastModified": 1710000000
}
```

---

### `HTTP` DELETE /api/services/persistentStorage/buckets/:bucketId/files/:fileName

#### Description

Delete a file from a bucket.

#### Query Parameters

| name            | type   | required | description                                        |
| --------------- | ------ | -------- | -------------------------------------------------- |
| consumerAddress | string | v        | consumer address                                   |
| signature       | string | v        | signed message (consumerAddress + nonce + command) |
| nonce           | string | v        | request nonce                                      |
| chainId         | number | v        | chain id (used by auth/signature checks)           |

#### Response (200)

```json
{ "success": true }
```

---

## Service on Demand

Service-on-Demand lets a consumer launch a long-running Docker container (e.g. JupyterLab, a
vLLM inference server, VS Code) on a compute environment, pay up front via on-chain escrow for
a requested `duration`, and reach it over forwarded network endpoints
(`http://<nodeHost>:<hostPort>`) while it runs. Unlike a compute job, a service stays up until
it expires, is stopped, or is extended. See [`services.md`](./services.md) for the full design
and security model.

All routes live under `/api/services`. Every command except `serviceTemplates` is
authenticated by a signature over `consumerAddress` + `nonce` + `command` (or an auth-token
`Authorization` header). Cost is computed only from the environment's server-side pricing and
charged to the authenticated `consumerAddress`.

> **Note:** service containers run hardened (`no-new-privileges`, `CapDrop: ['ALL']`), so a
> process inside the container cannot bind to a port below 1024 — have your service listen on a
> **high port** (the published host port is allocated by the node regardless).

### Service object definitions

#### `ServiceTemplatePublic` (returned by `serviceTemplates`)

Operator-published blueprint. Secret `envVars` values are never returned — only their keys via
`envVarKeys`.

| property                    | type     | description                                              |
| --------------------------- | -------- | -------------------------------------------------------- |
| id                          | string   | template id (`[a-z0-9][a-z0-9_-]{0,63}`)                 |
| name / description          | string   | human-readable labels                                    |
| image                       | string   | base image                                               |
| tag / checksum / dockerfile | string   | image spec — exactly one                                 |
| exposedPorts                | number[] | container ports to forward                               |
| envVarKeys                  | string[] | keys of operator-set env vars (values never returned)    |
| userConfigurableEnvVars     | object[] | `{ key, validation?, sensitive? }` passed via `userData` |
| command / entrypoint        | string[] | Docker CMD / ENTRYPOINT overrides                        |
| requiredResources           | object[] | resources the service MUST have to run                   |
| recommendedResources        | object[] | resources for best performance                           |

#### `ServiceJob` (returned by start / status / extend / restart / stop)

The encrypted `userData` is never returned. Key fields:

| property       | type     | description                                                                                                                                                                                                         |
| -------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| serviceId      | string   | unique id of the running service                                                                                                                                                                                    |
| environment    | string   | envId the service runs on                                                                                                                                                                                           |
| owner          | string   | consumerAddress                                                                                                                                                                                                     |
| status         | number   | `10` Starting, `20` Locking, `11` PullImage, `13` BuildImage, `30` Claiming, `40` Running, `12` PullImageFailed, `14` BuildImageFailed, `15` VulnerableImage, `50` Stopping, `70` Stopped, `75` Expired, `99` Error |
| statusText     | string   | human-readable status                                                                                                                                                                                               |
| dateCreated    | string   | ISO timestamp                                                                                                                                                                                                       |
| expiresAt      | number   | Unix ms timestamp when the paid window ends                                                                                                                                                                         |
| duration       | number   | requested seconds                                                                                                                                                                                                   |
| endpoints      | object[] | `{ containerPort, hostPort, url }` per exposed port                                                                                                                                                                 |
| resources      | object[] | `{ id, amount, price }`                                                                                                                                                                                             |
| payment        | object   | initial start payment record                                                                                                                                                                                        |
| extendPayments | object[] | one entry per successful extend                                                                                                                                                                                     |

---

### `HTTP` GET /api/services/serviceTemplates

### `P2P` command: serviceGetTemplates

#### Description

List the operator-published service templates (sanitized). Not authenticated.

#### Query Parameters

| name    | type   | required | description                                        |
| ------- | ------ | -------- | -------------------------------------------------- |
| chainId | number |          | filter to templates whose envs price on this chain |

#### Response (200)

```json
[
  {
    "id": "jupyter-cpu",
    "name": "JupyterLab (CPU)",
    "image": "quay.io/jupyter/datascience-notebook",
    "tag": "latest",
    "exposedPorts": [8888],
    "userConfigurableEnvVars": [{ "key": "JUPYTER_TOKEN", "sensitive": true }],
    "requiredResources": [
      { "id": "cpu", "min": 1 },
      { "id": "ram", "min": 2 }
    ]
  }
]
```

---

### `HTTP` POST /api/services/serviceStart

### `P2P` command: serviceStart

#### Description

Validate the request, persist the job, and **return immediately** with the `serviceId` — the
response does **not** wait for escrow or the image pull/build. The consumer supplies the
container spec directly (an `image` referenced by `tag`/`checksum`, or an inline `dockerfile`
when the operator allows building).

The returned job has `status: 10` (`Starting`) and no `endpoints` yet. A background loop then
advances it: `Starting → Locking` (escrow lock) `→ PullImage`/`BuildImage` (image + scan) `→
Claiming` (claim on success, or refund/cancel the lock on failure) `→ Running`. **Poll
`serviceStatus`** until `status` is `40` (`Running`, with `endpoints` populated) or a terminal
`*Failed` / `Error` status. Note that `Running` is not a final resting state for a poller to stop
at: the same background loop keeps checking the container's health afterward, and can move an
already-`Running` service to `Error` later if the container dies on its own — long-lived clients
should keep watching `serviceStatus`, not just stop once they first see `Running`.

#### Request Body

```json
{
  "consumerAddress": "0x...",
  "nonce": "123",
  "signature": "0x...",
  "environment": "env-1",
  "image": "nginxinc/nginx-unprivileged",
  "tag": "alpine",
  "exposedPorts": [8080],
  "resources": [
    { "id": "cpu", "amount": 1 },
    { "id": "ram", "amount": 1 }
  ],
  "duration": 3600,
  "userData": "<ECIES-encrypted-to-node-pubkey hex>",
  "metadata": { "run": "experiment-7", "attempt": 2 },
  "payment": { "chainId": 8996, "token": "0x..." }
}
```

| field                        | type     | required | description                                                       |
| ---------------------------- | -------- | -------- | ----------------------------------------------------------------- |
| environment                  | string   | v        | envId to run on (services must be enabled on it)                  |
| image                        | string   | v        | base image                                                        |
| tag / checksum / dockerfile  | string   |          | image spec — at most one; `dockerfile` requires `allowImageBuild` |
| additionalDockerFiles        | object   |          | filename → content; only with `dockerfile`                        |
| dockerCmd / dockerEntrypoint | string[] |          | container CMD / ENTRYPOINT overrides                              |
| exposedPorts                 | number[] |          | container ports to publish                                        |
| resources                    | object[] |          | `{ id, amount }` requested resources                              |
| duration                     | number   | v        | seconds; capped by `serviceOnDemand.maxDurationSeconds`           |
| userData                     | string   |          | ECIES-encrypted (to the node pubkey) JSON of env vars             |
| metadata                     | object   |          | arbitrary user labels (`string`/`number`/`boolean` values, ≤1 KB JSON); node-opaque. Returned on both `serviceStatus` and `serviceList` |
| payment                      | object   | v        | `{ chainId, token }`                                              |

#### Response (200)

The immediate response — `Starting`, no endpoints yet. Poll `serviceStatus` for the rest.

```json
[
  {
    "serviceId": "0x...",
    "environment": "env-1",
    "owner": "0x...",
    "status": 10,
    "statusText": "Starting",
    "expiresAt": 1735689600000,
    "duration": 3600,
    "endpoints": [],
    "payment": { "chainId": 8996, "token": "0x...", "cost": 10 }
  }
]
```

Errors: `403` services disabled on the env / access denied, `400` invalid params (bad address,
duration, image spec, metadata over 1 KB, unavailable resources, or no pricing for the token).
Escrow lock/claim now
happens in the background, so escrow failures surface as the job ending in an `Error` / `*Failed`
status (observed via `serviceStatus`), not as a synchronous `402`.

---

### `HTTP` GET /api/services/serviceStatus

### `P2P` command: serviceGetStatus

#### Description

Read service job status and endpoints. **Authenticated and owner-scoped** — only services owned
by the authenticated `consumerAddress` are returned.

#### Query Parameters

| name            | type    | required | description |
| --------------- | ------- | -------- | ----------- |
| consumerAddress | string  | v        | owner address |
| nonce           | string  | v        | request nonce |
| signature       | string  | v        | signed message (or use an `Authorization` auth-token header) |
| serviceId       | string  |          | filter to a single service; omit to list all owned services |
| includeMetrics  | boolean |          | runtime metrics (`runtimeMetrics`) are included by default; pass `false` to omit them |

#### Response (200)

Array of `ServiceJob` (with `userData` stripped; any user-supplied `metadata` is kept — this
path is owner-scoped). Each entry also carries a sanitized
`runtimeMetrics` object — see [The `runtimeMetrics` object](#the-runtimemetrics-object) for its full
structure. Included by default here because this command is already authenticated and owner-scoped
(pass `includeMetrics=false` to omit); the node-wide `serviceList` never returns metrics. Metrics are
best-effort (see [compute.md](compute.md) and `C2D_METRICS_INTERVAL_SECONDS` in [env.md](env.md)).

---

### `HTTP` GET /api/services/serviceList

### `P2P` command: serviceList

#### Description

Node-wide service listing. **Authenticated but NOT owner-scoped** — any authenticated
consumer identity sees every owner's services. By default it returns only the services
**currently holding a resource reservation** (exactly what the engines count against the
shared pools): `Running`/`Restarting`/`Stopping`, the mid-start pipeline states, paid
`Error` (container died, restartable), and explicitly `Stopped` within the paid window.
`Expired` and never-paid jobs hold nothing and are not listed by default.

#### Query Parameters

| name               | type    | required | description                                                                                                                |
| ------------------ | ------- | -------- | -------------------------------------------------------------------------------------------------------------------------- |
| consumerAddress    | string  | v        | caller identity (any consumer)                                                                                             |
| nonce              | string  | v        | request nonce                                                                                                              |
| signature          | string  | v        | signed message (or use an `Authorization` auth-token header)                                                               |
| status             | number  |          | filter to ONE specific `ServiceStatusNumber` (any status, incl. `75` Expired); takes precedence over `includeAllStatuses`  |
| includeAllStatuses | boolean |          | `true` returns services in every status instead of only the resource-holding set                                           |
| fromTimestamp      | string  |          | only services created at/after this moment — ISO date (`2026-01-15T00:00:00Z`) or Unix timestamp (seconds or milliseconds) |

#### Response (200)

Array of `ServiceJob`, **listing-sanitized**: `userData`, `dockerCmd`, `dockerEntrypoint`,
`dockerfile` and `additionalDockerFiles` are stripped (identity, status, resources,
endpoints, payment metadata and the owner's `metadata` are kept). Use the owner-scoped
`serviceStatus` to see a service's own configuration.

---

### `HTTP` POST /api/services/serviceExtend

### `P2P` command: serviceExtend

#### Description

Pay to push the service expiry further out. The total remaining duration must not exceed
`maxDurationSeconds`. Re-checks the environment access list.

#### Request Body

```json
{
  "consumerAddress": "0x...",
  "nonce": "123",
  "signature": "0x...",
  "serviceId": "0x...",
  "additionalDuration": 1800,
  "payment": { "chainId": 8996, "token": "0x..." }
}
```

`additionalDuration` must be a positive number of seconds.

#### Response (200)

The updated `ServiceJob` (advanced `expiresAt`, new entry in `extendPayments`).

---

### `HTTP` POST /api/services/serviceRestart

### `P2P` command: serviceRestart

#### Description

Recreate the service container (no extra charge), keeping the same `expiresAt`, resources and
host ports. Re-checks the environment service gate and access list; rejected if the service has
expired. This is the recommended recovery path after a service lands in `Error` because its
container died on its own (the background health check leaves host ports/network/container
record reserved specifically so restart can reuse them), in addition to recovering from an
explicit `serviceStop` or any other terminal failure.

**Restart is atomic — either all-old or all-new, never a mix of new params over the stored job:**

- **REUSE mode** — the request carries **none** of the container params below. The service
  restarts on exactly its stored spec (image, `userData`, `dockerCmd`, `dockerEntrypoint`). Use
  this to simply bounce a service back to `Running`.
- **RESPEC mode** — the request carries **any** container param. The container is rebuilt
  entirely from the request: `image` becomes **required** and exactly one of `tag`/`checksum`/
  `dockerfile` applies (validated exactly like `serviceStart`). `userData`/`dockerCmd`/
  `dockerEntrypoint` are taken **as-sent** — anything omitted here is empty/unset, it is **not**
  pulled from the stored job. This is the bug-fix flow: publish a fixed image under a new tag,
  then restart re-supplying the full spec (e.g. same `image`, new `tag`).

Because `image` is mandatory whenever any container param is present, you cannot ride a new
`userData`/`dockerCmd` on top of the stored image — a partial change is rejected (400). Payment,
resources and duration are always preserved; only the container spec can change. A service whose
start payment was **never claimed** (escrow lock failed or was refunded) cannot be restarted —
start a new service instead.

#### Request Body

REUSE mode (bounce the service on its stored spec):

```json
{
  "consumerAddress": "0x...",
  "nonce": "123",
  "signature": "0x...",
  "serviceId": "0x..."
}
```

RESPEC mode (restart on a new image spec — `image` required, plus at most one of
`tag`/`checksum`/`dockerfile`):

```json
{
  "consumerAddress": "0x...",
  "nonce": "123",
  "signature": "0x...",
  "serviceId": "0x...",
  "image": "myrepo/myservice",
  "tag": "v2",
  "userData": "<optional ECIES-encrypted hex; the new container env — omitted ⇒ none>",
  "dockerCmd": ["<optional; the new CMD override — omitted ⇒ none>"],
  "dockerEntrypoint": ["<optional; the new ENTRYPOINT override — omitted ⇒ none>"]
}
```

| name                  | type     | required | description                                                                                                              |
| --------------------- | -------- | -------- | ------------------------------------------------------------------------------------------------------------------------ |
| serviceId             | string   | v        | the service to restart                                                                                                   |
| image                 | string   | RESPEC   | base image name (build label when `dockerfile` is set). Required as soon as any container param is present               |
| tag                   | string   |          | pull by `name:tag`; mutually exclusive with `checksum`/`dockerfile`                                                      |
| checksum              | string   |          | pull by digest `sha256:<64 hex>`; mutually exclusive with `tag`/`dockerfile`                                             |
| dockerfile            | string   |          | build from an inline Dockerfile; requires `allowImageBuild` on the environment; mutually exclusive with `tag`/`checksum` |
| additionalDockerFiles | object   |          | extra `filename → content` files for the build context (only with `dockerfile`)                                          |
| userData              | string   |          | ECIES-encrypted (to the node public key) JSON → the container's env-var map                                              |
| dockerCmd             | string[] |          | exact container command (Docker exec-form CMD override)                                                                  |
| dockerEntrypoint      | string[] |          | container ENTRYPOINT override                                                                                            |
| metadata              | object   |          | user labels (≤1 KB JSON). **Not** a container param — independent of REUSE/RESPEC. When present it **replaces** the stored metadata; when omitted the original metadata is kept |

#### Response (200)

The `ServiceJob` with a new `containerId` (same `hostPort` and `expiresAt`; the `image`/`tag`/
`checksum`/`dockerfile`/`containerImage` fields reflect the new spec in RESPEC mode).

#### Response (400)

Not found, expired, payment never claimed, metadata over 1 KB, or an invalid respec — a
container param was sent without `image`, or more than one of `tag`/`checksum`/`dockerfile` was
provided.

#### Response (403)

`dockerfile` was supplied but the environment has `allowImageBuild=false`.

---

### `HTTP` POST /api/services/serviceStop

### `P2P` command: serviceStop

#### Description

Tear down the service container and network. Owner-gated. The paid reservation is kept until
`expiresAt`; optional `release: true` ends the paid window now so the expiry sweep frees it
instead — no refund, no restart.

#### Request Body

```json
{
  "consumerAddress": "0x...",
  "nonce": "123",
  "signature": "0x...",
  "serviceId": "0x...",
  "release": false
}
```

#### Response (200)

The `ServiceJob` with `status: 70` (Stopped).

---

### `HTTP` GET /api/services/serviceStreamableLogs

### `P2P` command: serviceGetStreamableLogs

#### Description

Stream the service container's stdout/stderr logs live. **Authenticated and owner-scoped**
— only the service's owner (`consumerAddress`, proven by signature/nonce or auth token) can
read its logs. Available while the service is `Running` (`40`) or `Error` (`99`) — a crashed
container is kept around until `stop`/`restart`, so its logs remain fetchable for diagnosis.

#### Query Parameters

| name            | type   | required | description                                                                                                                                                                                                                                     |
| --------------- | ------ | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| consumerAddress | string | v        | owner address                                                                                                                                                                                                                                   |
| nonce           | string | v        | request nonce                                                                                                                                                                                                                                   |
| signature       | string | v        | signed message (or use an `Authorization` auth-token header)                                                                                                                                                                                    |
| serviceId       | string | v        | the service to stream logs for                                                                                                                                                                                                                  |
| since           | string |          | lower time bound for returned logs. Either a Unix timestamp in seconds (e.g. `1735689600`), or a relative duration counted back from now (e.g. `30s`, `45m`, `2h`, `7d`). Omit to get the full history since container start, then follow live. |

#### Response (200)

Raw `stdout`/`stderr` byte stream from the container, connection kept open and followed live.
With `since` set, historical output before that point is skipped — useful for a long-lived
service where fetching the full history would otherwise dump days/weeks of buffered logs
before reaching the live tail (e.g. `since=1h` for just the last hour).

#### Response (400)

`since` is present but not a valid Unix timestamp or duration (`<number><s|m|h|d>`).

#### Response (404)

Service not found, or not `Running`/`Error`.

#### Response (401)

Missing/invalid auth, or `consumerAddress` is not the service owner.
