# Ocean Node Api

---

## Validate DDO

### `POST` /directCommand

#### Description

returns an empty object if it is valid otherwise an array with error

#### Parameters

| name       | type   | required | description                                       |
|------------|--------|----------|---------------------------------------------------|
| command    | string | v        | command name                                      |
| node       | string |          | if not present it means current node              |
| id         | string | v        | document id or did                                |
| chainId    | number | v        | chain id of network on which document is provided |
| nftAddress | string | v        | address of nft token                              |

#### Example

```json
{
  "command": "validateDDO",
  "node": "PeerId",
  "txId": "0x123",
  "chainId": 123,
  "eventIndex": 123
}
```

#### Response

```
{}
```

---

## File Info

### `POST` /directCommand

#### Description

returns file information

#### Parameters

| name      | type   | required | description                              |
|-----------|--------|----------|------------------------------------------|
| command   | string | v        | command name                             |
| node      | string |          | if not present it means current node     |
| type      | string |          | type of storage `url or arweave or ipfs` |
| did       | string |          | document id or did                       |
| serviceId | number |          | service id of services list              |
| fileIndex | number |          | file index in files array                |
| file      | object |          | file data                                |
| checksum  | number |          | index in transaction events list         |

#### Example

```json
{
  "command": "fileInfo",
  "node": "PeerId",
  "txId": "0x123",
  "chainId": 123,
  "eventIndex": 123
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

### `POST` /directCommand

#### Description

returns a message about successful addition to the reindexing queue

#### Parameters

| name       | type   | required | description                                          |
|------------|--------|----------|------------------------------------------------------|
| command    | string | v        | command name                                         |
| node       | string |          | if not present it means current node                 |
| txId       | string | v        | id of transaction for reindexing                     |
| chainId    | number | v        | chain id of network on which transaction is provided |
| eventIndex | number |          | index in transaction events list                     |

#### Example

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

### `POST` /directCommand

#### Description

returns calculated provider fees for DDO with service id

#### Parameters

| name      | type   | required | description                          |
|-----------|--------|----------|--------------------------------------|
| command   | string | v        | command name                         |
| node      | string |          | if not present it means current node |
| ddo       | object | v        | document object                      |
| serviceId | string | v        | service id of services list          |

#### Example

```json
{
  "command": "getFees",
  "node": "PeerId",
  "ddo": {
    "@context": [
      "https://w3id.org/did/v1"
    ],
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

### `POST` /directCommand

#### Description

returns list of providers from which ddo can be obtained

#### Parameters

| name    | type   | required | description                          |
|---------|--------|----------|--------------------------------------|
| command | string | v        | command name                         |
| node    | string |          | if not present it means current node |
| id      | string | v        | document id or did                   |

#### Example

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

### `POST` /directCommand

#### Description

returns status of node

#### Parameters

| name    | type   | required | description                          |
|---------|--------|----------|--------------------------------------|
| command | string | v        | command name                         |
| node    | string |          | if not present it means current node |

#### Example

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

### `POST` /directCommand

#### Description

returns search result for query

#### Parameters

| name           | type   | required | description                                            |
|----------------|--------|----------|--------------------------------------------------------|
| command        | string | v        | command name                                           |
| node           | string |          | if not present it means current node                   |
| query          | object | v        | query parameters                                       |
| query.q        | object | v        | text to search for in database                         |
| query.query_by | object | v        | one or more field names that should be queried against |

#### Example

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

### `POST` /directCommand

#### Description

returns document by id

#### Parameters

| name    | type   | required | description                          |
|---------|--------|----------|--------------------------------------|
| command | string | v        | command name                         |
| node    | string |          | if not present it means current node |
| id      | string | v        | document id or did                   |

#### Example

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

### `POST` /directCommand

#### Description

returns encrypted blob

#### Parameters

| name           | type   | required | description                          |
|----------------|--------|----------|--------------------------------------|
| command        | string | v        | command name                         |
| node           | string |          | if not present it means current node |
| blob           | string | v        | blob data                            |
| encoding       | string | v        | data encoding `string or base58`     |
| encryptionType | string | v        | encrypt method `AES or ECIES`        |

#### Example

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

### `POST` /directCommand

#### Description

returns stored nonce for an address

#### Parameters

| name    | type   | required | description                          |
|---------|--------|----------|--------------------------------------|
| command | string | v        | command name                         |
| node    | string |          | if not present it means current node |
| address | string | v        | consumer address                     |

#### Example

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

### `POST` /directCommand

#### Description

returns encrypted document

#### Parameters

| name              | type   | required | description                                                                                   |
|-------------------|--------|----------|-----------------------------------------------------------------------------------------------|
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

#### Example

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

### `POST` /directCommand

#### Description

returns a file stream of the requested file

#### Parameters

| name              | type   | required | description                                                                              |
|-------------------|--------|----------|------------------------------------------------------------------------------------------|
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

#### Example

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

### `POST` /directCommand

#### Description

returns OK

#### Parameters

| name    | type   | required | description                          |
|---------|--------|----------|--------------------------------------|
| command | string | v        | command name                         |
| node    | string |          | if not present it means current node |

#### Example

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
