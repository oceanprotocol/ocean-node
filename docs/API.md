# Ocean Node Api

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

#### Request

```
string
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

## Advertise Did

### `HTTP` GET /advertiseDid/?did=did:op:123"

#### Description

returns empty if advertising did around peers was successful

#### Query Parameters

| name | type   | required | description        |
| ---- | ------ | -------- | ------------------ |
| did  | string | v        | document id or did |

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

## Get Ocean Peers

### `HTTP` GET /getOceanPeers

#### Description

returns list of ocean node peers

#### Response

```
["PeerId", "PeerId", "PeerId"]
```

---

## Validate DDO

### `HTTP` POST /directCommand

### `P2P` command: validateDDO

#### Description

returns an empty object if it is valid otherwise an array with error

#### Parameters

| name       | type   | required | description                                       |
| ---------- | ------ | -------- | ------------------------------------------------- |
| command    | string | v        | command name                                      |
| node       | string |          | if not present it means current node              |
| id         | string | v        | document id or did                                |
| chainId    | number | v        | chain id of network on which document is provided |
| nftAddress | string | v        | address of nft token                              |

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

## Echo

### `HTTP` POST /directCommand

### `P2P` command: echo

#### Description

returns OK

#### Parameters

| name    | type   | required | description                          |
| ------- | ------ | -------- | ------------------------------------ |
| command | string | v        | command name                         |
| node    | string |          | if not present it means current node |

#### Request

```json
{
  "command": "echo",
  "node": "PeerId"
}
```

#### Response

```
OK
```

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

### `HTTP` POST /PolicyServerPassthrough

### `P2P` command: PolicyServerPassthrough

#### Description

Forwards request to PolicyServer (if any)

#### Parameters

| name                    | type   | required | description                                    |
| ----------------------- | ------ | -------- | ---------------------------------------------- |
| command                 | string | v        | command name                                   |
| node                    | string |          | if not present it means current node           |
| policyServerPassthrough | any    |          | command and params for PolicyServer (see docs) |

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
