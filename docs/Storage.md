# Storage Types

Ocean Node supports three storage backends for assets (e.g. algorithm or data files). Each type is identified by a `type` field on the file object and has its own shape and validation rules.

## Supported types

| Type     | `type` value | Description                          |
| -------- | ------------- | ------------------------------------ |
| **URL**  | `url`         | File served via HTTP/HTTPS           |
| **IPFS** | `ipfs`        | File identified by IPFS CID          |
| **Arweave** | `arweave`  | File identified by Arweave transaction ID |

All file objects can optionally include encryption metadata: `encryptedBy` and `encryptMethod` (e.g. `AES`, `ECIES`).

---

## URL storage

Files are fetched from a given URL using HTTP GET or POST.

### File object shape

```json
{
  "type": "url",
  "url": "https://example.com/path/to/file.zip",
  "method": "get",
  "headers": {}
}
```

| Field     | Required | Description                                      |
| --------- | -------- | ------------------------------------------------ |
| `type`    | Yes      | Must be `"url"`                                  |
| `url`     | Yes      | Full HTTP/HTTPS URL to the file                  |
| `method`  | Yes      | `"get"` or `"post"`                              |
| `headers` | No       | Optional request headers (key-value object)      |

### Validation

- `url` and `method` must be present.
- `method` must be `get` or `post` (case-insensitive).
- If the node config defines `unsafeURLs` (list of regex patterns), any URL matching a pattern is rejected.
- The URL must look like a real URL (`http://` or `https://`); path-like values are rejected.

### Node configuration

- Optional: `unsafeURLs` – array of regex strings; URLs matching any of them are considered unsafe and rejected.

---

## IPFS storage

Files are resolved via an IPFS gateway using a content identifier (CID).

### File object shape

```json
{
  "type": "ipfs",
  "hash": "QmXoypizjW3WknFiJnKLwHCnL72vedxjQkDDP1mXWo6uco"
}
```

| Field  | Required | Description                    |
| ------ | -------- | ------------------------------ |
| `type` | Yes      | Must be `"ipfs"`               |
| `hash` | Yes      | IPFS content identifier (CID)  |

The node builds the download URL as: `{ipfsGateway}/ipfs/{hash}` (e.g. `https://ipfs.io/ipfs/QmXoy...`).

### Validation

- `hash` (CID) must be present.
- The value must not look like an HTTP(S) URL (use URL storage for gateway URLs).
- The value must not look like a file path.

### Node configuration

- **Required**: `ipfsGateway` – base URL of the IPFS HTTP gateway (e.g. `https://ipfs.io`).

---

## Arweave storage

Files are identified by an Arweave transaction ID and fetched via an Arweave gateway.

### File object shape

```json
{
  "type": "arweave",
  "transactionId": "abc123..."
}
```

| Field           | Required | Description                |
| --------------- | -------- | -------------------------- |
| `type`          | Yes      | Must be `"arweave"`        |
| `transactionId` | Yes      | Arweave transaction ID     |

The node builds the download URL as: `{arweaveGateway}/{transactionId}`.

### Validation

- `transactionId` must be present.
- The value must not look like an HTTP(S) URL (use URL storage for direct URLs).
- The value must not look like a file path.

### Node configuration

- **Required**: `arweaveGateway` – base URL of the Arweave gateway (e.g. `https://arweave.net`).

---

## Summary

- **URL**: flexible HTTP(S) endpoints; optional custom headers and `unsafeURLs` filtering.
- **IPFS**: CID-based; requires `ipfsGateway` in config.
- **Arweave**: transaction-ID-based; requires `arweaveGateway` in config.

The storage implementation lives under `src/components/storage/`. The node selects the backend from the file object’s `type` (case-insensitive) and validates the shape and config before fetching or streaming the file.
