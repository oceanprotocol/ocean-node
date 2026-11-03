# Storage Types

Ocean Node supports five storage backends for assets (e.g. algorithm or data files). Each type is identified by a `type` field on the file object and has its own shape and validation rules.

## Supported types

| Type        | `type` value | Description                                            |
| ----------- | ------------ | ------------------------------------------------------ |
| **URL**     | `url`        | File served via HTTP/HTTPS                             |
| **IPFS**    | `ipfs`       | File identified by IPFS CID                            |
| **Arweave** | `arweave`    | File identified by Arweave transaction ID              |
| **S3**      | `s3`         | File in S3-compatible storage (AWS, Ceph, MinIO, etc.) |
| **FTP**     | `ftp`        | File served via FTP or FTPS                            |

All file objects can optionally include encryption metadata: `encryptedBy` and `encryptMethod` (e.g. `AES`, `ECIES`).

---

## Private network protection (SSRF)

File objects are supplied by remote callers, and `fileInfo` needs no signature, so the node
treats every `url`, `ftp` and `s3` target as untrusted:

- Hosts that are, or resolve to, a non-public address are refused: loopback, RFC 1918
  private ranges, link-local (`169.254.0.0/16`, which includes the cloud metadata
  endpoints), CGNAT (`100.64.0.0/10`), multicast, broadcast, unspecified and other reserved
  ranges, plus their IPv6 equivalents (`::1`, `fc00::/7`, `fe80::/10`, IPv4-mapped and
  translated addresses). `localhost` names and IP literals in any encoding (decimal, hex,
  octal, bracketed IPv6) are rejected when the file object is validated.
- DNS names are checked at connect time, against every address they resolve to, and the
  check runs again for every redirect, so a public name that resolves to an internal
  address (DNS rebinding) or a public URL that redirects to one is also refused.
- `unsafeURLs` (env `UNSAFE_URLS`) adds regular expressions on top of the built-in list of
  cloud metadata endpoints; operator entries extend the defaults, they do not replace them.
- `allowedPrivateUrlRanges` (env `ALLOWED_PRIVATE_URL_RANGES`) lists CIDRs or single IPs
  that may be contacted although they are private, for example a LAN object store:
  `["10.0.5.20/32"]`.

A rejected file object fails validation with `URL points to a private, loopback or reserved
network address`; a DNS name blocked at connect time fails the request itself.

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

| Field     | Required | Description                                 |
| --------- | -------- | ------------------------------------------- |
| `type`    | Yes      | Must be `"url"`                             |
| `url`     | Yes      | Full HTTP/HTTPS URL to the file             |
| `method`  | Yes      | `"get"` or `"post"`                         |
| `headers` | No       | Optional request headers (key-value object) |

### Validation

- `url` and `method` must be present.
- `method` must be `get` or `post` (case-insensitive).
- Any URL matching one of the `unsafeURLs` regex patterns (built-in defaults plus operator entries) is rejected.
- The URL must look like a real URL (`http://` or `https://`); path-like values are rejected.
- The host must not be a private, loopback or reserved address (see [Private network protection](#private-network-protection-ssrf)); the same check runs on every DNS answer and redirect when the file is fetched.

### Node configuration

- Optional: `unsafeURLs` – array of regex strings added to the built-in defaults; URLs matching any of them are considered unsafe and rejected.
- Optional: `allowedPrivateUrlRanges` – array of CIDRs / IPs exempt from the private-address check.

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

| Field  | Required | Description                   |
| ------ | -------- | ----------------------------- |
| `type` | Yes      | Must be `"ipfs"`              |
| `hash` | Yes      | IPFS content identifier (CID) |

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

| Field           | Required | Description            |
| --------------- | -------- | ---------------------- |
| `type`          | Yes      | Must be `"arweave"`    |
| `transactionId` | Yes      | Arweave transaction ID |

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

| Field      | Required | Description                                                            |
| ---------- | -------- | ---------------------------------------------------------------------- |
| `type`     | Yes      | Must be `"s3"`                                                         |
| `s3Access` | Yes      | Object with endpoint, bucket, object key, and credentials (see below). |

**`s3Access` fields:**

| Field             | Required | Description                                                                                                                                                                                                      |
| ----------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `endpoint`        | Yes      | S3 endpoint URL (e.g. `https://s3.amazonaws.com`, `https://nyc3.digitaloceanspaces.com`, or `https://my-ceph.example.com`)                                                                                       |
| `bucket`          | Yes      | Bucket name                                                                                                                                                                                                      |
| `objectKey`       | Yes      | Object key (path within the bucket)                                                                                                                                                                              |
| `accessKeyId`     | Yes      | Access key for the S3-compatible API                                                                                                                                                                             |
| `secretAccessKey` | Yes      | Secret key for the S3-compatible API                                                                                                                                                                             |
| `region`          | No       | Region (e.g. `us-east-1`). Optional; defaults to `us-east-1` if omitted. Some backends (e.g. Ceph) may ignore it.                                                                                                |
| `forcePathStyle`  | No       | If `true`, use path-style addressing (e.g. `endpoint/bucket/key`). Required for some S3-compatible services (e.g. MinIO). Default `false` (virtual-host style, e.g. `bucket.endpoint/key`, standard for AWS S3). |

### Validation

- `s3Access` must be present.
- Within `s3Access`, `bucket`, `objectKey`, `endpoint`, `accessKeyId`, and `secretAccessKey` must be present and non-empty.
- `region` and `forcePathStyle` are optional; when provided they are used when creating the S3 client.
- The `endpoint` host must not be a private, loopback or reserved address (see [Private network protection](#private-network-protection-ssrf)); DNS names are checked when the client connects.

### Node configuration

- All S3 connection details (endpoint, credentials, bucket, key) come from the file object’s `s3Access`.
- Optional: `allowedPrivateUrlRanges` – array of CIDRs / IPs exempt from the private-address check.

---

## FTP storage

Files are fetched or uploaded via FTP or FTPS. The node uses a single `url` field containing the full FTP(S) URL (including optional credentials). Functionality mirrors URL storage: stream download, file metadata (size; content-type is `application/octet-stream`), and upload via STOR.

### File object shape

```json
{
  "type": "ftp",
  "url": "ftp://user:password@ftp.example.com:21/path/to/file.zip"
}
```

For FTPS (TLS):

```json
{
  "type": "ftp",
  "url": "ftps://user:password@secure.example.com:990/pub/data.csv"
}
```

| Field  | Required | Description                                                                                                                                                          |
| ------ | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `type` | Yes      | Must be `"ftp"`                                                                                                                                                      |
| `url`  | Yes      | Full FTP or FTPS URL. Supports `ftp://` and `ftps://`. May include credentials as `ftp://user:password@host:port/path`. Default port is 21 for FTP and 990 for FTPS. |

### Validation

- `url` must be present.
- URL must use protocol `ftp://` or `ftps://`.
- Any URL matching one of the `unsafeURLs` regex patterns (built-in defaults plus operator entries) is rejected.
- The host must not be a private, loopback or reserved address (see [Private network protection](#private-network-protection-ssrf)). DNS names are resolved and checked before connecting, and the control connection is made to the vetted address (the host name is kept as TLS server name for FTPS).

### Node configuration

- Optional: `unsafeURLs` – array of regex strings added to the built-in defaults; URLs matching any of them are considered unsafe and rejected (same as URL storage).
- Optional: `allowedPrivateUrlRanges` – array of CIDRs / IPs exempt from the private-address check.

### Upload

FTPStorage supports `upload(filename, stream)`. If the file object’s `url` ends with `/`, the filename is appended to form the remote path; otherwise the URL is used as the full target path. Uses FTP STOR command.

---

## C2D result upload to remote storage

Compute-to-Data jobs can upload their output archive to a remote backend instead of keeping it only on local node disk.

Alternatively, results can be stored as individual files in a node persistent-storage bucket via the `outputBucketId` start parameter — see [persistent storage](./persistentStorage.md#using-a-bucket-for-compute-job-outputs). The two options are mutually exclusive.

### How it works

1. You build a `ComputeOutput` JSON object with:
   - `remoteStorage`: one of the storage objects from this document (`url`, `s3`, `ftp`, etc.)
   - optional `encryption`: currently only `AES` is accepted, with a hex key
2. You ECIES-encrypt that JSON into a string and send it in the compute command as `output`.
3. When the job finishes:
   - if `output` is present and remote storage supports upload, Ocean Node uploads the ZIP archive remotely
   - otherwise, Ocean Node falls back to local `outputs.zip` behavior

### `ComputeOutput` shape

```json
{
  "remoteStorage": {
    "type": "s3",
    "s3Access": {
      "endpoint": "https://s3.amazonaws.com",
      "region": "us-east-1",
      "bucket": "my-c2d-results",
      "objectKey": "jobs/result.tar",
      "accessKeyId": "AKIA...",
      "secretAccessKey": "..."
    }
  },
  "encryption": {
    "encryptMethod": "AES",
    "key": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
  }
}
```

Notes:

- `output` itself is **not plain JSON** in the compute request; it must be an ECIES-encrypted string.
- `encryption.key` must be at least 32 bytes (64 hex chars).
- `encryption.encryptMethod` must be `AES` if provided.

### End-to-end example

#### 1) Create plaintext output instructions

```json
{
  "remoteStorage": {
    "type": "ftp",
    "url": "ftp://user:password@ftp.example.com:21/results/"
  },
  "encryption": {
    "encryptMethod": "AES",
    "key": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
  }
}
```

#### 2) Encrypt the JSON

You can use `POST /api/services/encrypt` to encrypt the JSON string for Ocean Node:

```bash
curl -X POST "https://<node>/api/services/encrypt?consumerAddress=<0xAddress>&nonce=<nonce>&signature=<signature>" \
  -H "Content-Type: text/plain" \
  --data-raw '{"remoteStorage":{"type":"ftp","url":"ftp://user:password@ftp.example.com:21/results/"},"encryption":{"encryptMethod":"AES","key":"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"}}'
```

The response is the encrypted blob (hex string).  
If your encrypt response includes `0x` prefix, remove it before sending as compute `output` (compute handlers decode `output` as raw hex bytes).

#### 3) Send compute command with `output`

Example for `freeStartCompute`:

```json
{
  "command": "freeStartCompute",
  "consumerAddress": "0x...",
  "signature": "0x...",
  "nonce": "123",
  "environment": "<env-id>",
  "datasets": [],
  "algorithm": {
    "meta": {
      "rawcode": "print('hello')",
      "container": {
        "image": "python",
        "tag": "3.10",
        "entrypoint": "python",
        "checksum": "..."
      }
    }
  },
  "output": "<ecies-encrypted-output-string>"
}
```

### Uploaded filename and fallback behavior

- For remote upload, Ocean Node writes: `outputs-<clusterHash>-<jobId>.zip`. ZIP conversion happens before optional encryption. Explicit destination keys are used as supplied; choose a `.zip` key when configuring a new upload.
- If `output` is missing/empty, or chosen storage does not support upload, Ocean Node stores output locally (`outputs.zip`). Historical `outputs.tar` files remain downloadable.
- If remote upload fails, job status is set to `ResultsUploadFailed`.

---

## Summary

- **URL**: flexible HTTP(S) endpoints; optional custom headers and `unsafeURLs` filtering.
- **IPFS**: CID-based; requires `ipfsGateway` in config.
- **Arweave**: transaction-ID-based; requires `arweaveGateway` in config.
- **S3**: S3-compatible object storage (AWS, Ceph, MinIO, etc.); credentials and endpoint in the file object; `region` optional (defaults to `us-east-1`).
- **FTP**: FTP/FTPS URLs; stream download, metadata (size), and upload via STOR; optional `unsafeURLs` filtering.

The storage implementation lives under `src/components/storage/`. The node selects the backend from the file object’s `type` (case-insensitive) and validates the shape and config before fetching or streaming the file.
