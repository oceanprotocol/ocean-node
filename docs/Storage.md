# Storage Types

Ocean Node supports four storage backends for assets (e.g. algorithm or data files). Each type is identified by a `type` field on the file object and has its own shape and validation rules.

## Supported types

| Type       | `type` value | Description                          |
| ---------- | ------------- | ------------------------------------ |
| **URL**    | `url`         | File served via HTTP/HTTPS           |
| **IPFS**   | `ipfs`        | File identified by IPFS CID          |
| **Arweave**| `arweave`     | File identified by Arweave transaction ID |
| **S3**     | `s3`          | File in S3-compatible storage (AWS, Ceph, MinIO, etc.) |

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

## S3 storage

Files are stored in S3-compatible object storage. The node uses the AWS SDK and works with Amazon S3, Ceph, MinIO, DigitalOcean Spaces, and other S3-compatible services. Credentials and endpoint are provided on the file object; no node-level S3 config is required.

### File object shape

```json
{
  "type": "s3",
  "s3Access": {
    "endpoint": "https://s3.amazonaws.com",
    "region": "us-east-1",
    "bucket": "my-bucket",
    "objectKey": "path/to/file.zip",
    "accessKeyId": "AKIAIOSFODNN7EXAMPLE",
    "secretAccessKey": "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"
  }
}
```

| Field     | Required | Description |
| --------- | -------- | ----------- |
| `type`    | Yes      | Must be `"s3"` |
| `s3Access` | Yes    | Object with endpoint, bucket, object key, and credentials (see below). |

**`s3Access` fields:**

| Field             | Required | Description |
| ----------------- | -------- | ----------- |
| `endpoint`        | Yes      | S3 endpoint URL (e.g. `https://s3.amazonaws.com`, `https://nyc3.digitaloceanspaces.com`, or `https://my-ceph.example.com`) |
| `bucket`          | Yes      | Bucket name |
| `objectKey`       | Yes      | Object key (path within the bucket) |
| `accessKeyId`     | Yes      | Access key for the S3-compatible API |
| `secretAccessKey` | Yes      | Secret key for the S3-compatible API |
| `region`          | No       | Region (e.g. `us-east-1`). Optional; defaults to `us-east-1` if omitted. Some backends (e.g. Ceph) may ignore it. |
| `forcePathStyle`  | No       | If `true`, use path-style addressing (e.g. `endpoint/bucket/key`). Required for some S3-compatible services (e.g. MinIO). Default `false` (virtual-host style, e.g. `bucket.endpoint/key`, standard for AWS S3). |

### Validation

- `s3Access` must be present.
- Within `s3Access`, `bucket`, `objectKey`, `endpoint`, `accessKeyId`, and `secretAccessKey` must be present and non-empty.
- `region` and `forcePathStyle` are optional; when provided they are used when creating the S3 client.

### Node configuration

- None. All S3 connection details (endpoint, credentials, bucket, key) come from the file object’s `s3Access`.

---

## Summary

- **URL**: flexible HTTP(S) endpoints; optional custom headers and `unsafeURLs` filtering.
- **IPFS**: CID-based; requires `ipfsGateway` in config.
- **Arweave**: transaction-ID-based; requires `arweaveGateway` in config.
- **S3**: S3-compatible object storage (AWS, Ceph, MinIO, etc.); credentials and endpoint in the file object; `region` optional (defaults to `us-east-1`).

The storage implementation lives under `src/components/storage/`. The node selects the backend from the file object’s `type` (case-insensitive) and validates the shape and config before fetching or streaming the file.
