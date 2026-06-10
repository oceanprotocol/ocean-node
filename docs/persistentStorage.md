# Persistent Storage

This document describes Ocean Node **Persistent Storage** at a high level: what it is, how it is structured, how access control works, and how to use it via **P2P commands** and **HTTP endpoints**.

---

## What it is

Persistent Storage is a simple bucket + file store intended for **long-lived artifacts** that Ocean Node needs to keep across requests and across restarts, and to reference later (e.g. as file objects for compute).

Key primitives:

- **Bucket**: a logical container for files.
- **File**: binary content stored inside a bucket.
- **Bucket registry**: a local SQLite table that stores bucket metadata (owner, access lists, createdAt).

---

## Architecture (high level)

### Components

- **Handlers (protocol layer)**: `src/components/core/handler/persistentStorage.ts`
  - Implements protocol commands such as create bucket, list files, upload, delete, and get buckets.
  - Validates auth (token or signature) and applies high-level authorization checks.

- **Persistent storage backends (storage layer)**: `src/components/persistentStorage/*`
  - `PersistentStorageFactory`: shared functionality (SQLite bucket registry, access list checks).
  - `PersistentStorageLocalFS`: local filesystem backend.
  - `PersistentStorageS3`: stub for future S3-compatible backend.

- **HTTP routes (HTTP interface)**: `src/components/httpRoutes/persistentStorage.ts`
  - Exposes REST-ish endpoints under `/api/services/persistentStorage/...` that call the same handlers.

### Data storage

Persistent Storage uses two stores:

1. **Bucket registry (SQLite)**

- File: `databases/persistentStorage.sqlite`
- Table: `persistent_storage_buckets`
- Columns:
  - `bucketId` (primary key)
  - `owner` (address, stored as a string)
  - `accessListJson` (JSON-encoded access list array)
  - `createdAt` (unix timestamp)

2. **Backend data**

- `localfs`: writes file bytes to the configured folder under `buckets/<bucketId>/<fileName>`.
- `s3`: not implemented yet.

---

## Ownership and access control

### Ownership

Every bucket has a single **owner** address, stored in the bucket registry.

- When a bucket is created, the node sets:
  - `owner = consumerAddress` (normalized via `ethers.getAddress`)

### Bucket access list

Each bucket stores an **AccessList[]** (per-chain list(s) of access list contract addresses):

```ts
export interface AccessList {
  [chainId: string]: string[]
}
```

This access list is used to decide whether a given `consumerAddress` is allowed to interact with a bucket.

### Where checks happen

Access checks happen at two levels:

1. **Backend enforcement** (required)

- Backend operations `listFiles`, `uploadFile`, `deleteFile`, and `getFileObject` all require `consumerAddress`.
- The base class helper `assertConsumerAllowedForBucket(consumerAddress, bucketId)` loads the bucket ACL and throws `PersistentStorageAccessDeniedError` if the consumer is not allowed.

2. **Handler enforcement** (command-specific)

- `createBucket`: additionally checks the node-level allow list `config.persistentStorage.accessLists` (who can create buckets at all).
- `getBuckets`: queries registry rows filtered by `owner` and then:
  - if `consumerAddress === owner`: returns all buckets for that owner
  - else: filters buckets by the bucket ACL

### Error behavior

- Backends throw `PersistentStorageAccessDeniedError` when forbidden.
- Handlers translate that into **HTTP 403** / `status.httpStatus = 403`.

---

## Features

### Supported today

- **Create bucket**
  - Creates a bucket id (UUID), persists it in SQLite with `owner` and `accessListJson`, and creates a local directory (localfs).

- **List buckets (by owner)**
  - Returns buckets from the registry filtered by `owner` (mandatory arg).
  - Applies ACL filtering for non-owners.

- **Upload file**
  - Writes a stream to the backend.
  - Enforces bucket ACL.

- **List files**
  - Returns file metadata (`name`, `size`, `lastModified`) for a bucket.
  - Enforces bucket ACL.

- **Delete file**
  - Deletes the named file from the bucket.
  - Enforces bucket ACL.

- **getFileObject**
  - Returns fileObject format for c2d use
  - Enforces bucket ACL.

### Not implemented yet

- **S3 backend**
  - `PersistentStorageS3` exists as a placeholder and currently throws “not implemented”.

---

## Configuration

Persistent storage is controlled by `persistentStorage` in node config.

Key fields:

- `enabled`: boolean
- `type`: `"localfs"` or `"s3"`
- `accessLists`: AccessList[] — node-level allow list to create buckets
- `options`:
  - localfs: `{ "folder": "/path/to/storage" }`
  - s3: `{ endpoint, objectKey, accessKeyId, secretAccessKey, ... }` (future)

---

## Usage

Flow is:

- create bucket (or use existing bucket)
- list files
- upload file if needed
- GetFileObject to get object needed for c2d reference
- start c2d job using fileObject for datasets

### P2P commands

All persistent storage operations are implemented as protocol commands in the handler:

- `persistentStorageCreateBucket`
- `persistentStorageGetBuckets`
- `persistentStorageListFiles`
- `persistentStorageGetFileObject`
- `persistentStorageUploadFile`
- `persistentStorageDeleteFile`

Each command requires authentication (token or signature) based on Ocean Node’s auth configuration.

### HTTP endpoints

HTTP routes are available under `/api/services/persistentStorage/...` and call the same handlers. See `docs/API.md` for the full parameter lists and examples.

At a glance:

- `POST /api/services/persistentStorage/buckets`
- `GET /api/services/persistentStorage/buckets`
- `GET /api/services/persistentStorage/buckets/:bucketId/files`
- `GET /api/services/persistentStorage/buckets/:bucketId/files/:fileName/object`
- `POST /api/services/persistentStorage/buckets/:bucketId/files/:fileName`
- `DELETE /api/services/persistentStorage/buckets/:bucketId/files/:fileName`

Upload uses the raw request body as bytes and forwards it to the handler as a stream.

---

## Using a bucket for compute job outputs

Compute jobs (free and paid) can store their results directly in a persistent storage bucket instead of the default `outputs.tar` archive. Pass the bucket id as `outputBucketId` in the start compute command:

```json
{
  "command": "freeStartCompute",
  "...": "...",
  "outputBucketId": "a4ad237d-dfd8-404c-a5d6-b8fc3a1f66d3"
}
```

How it works:

- The bucket directory is bind-mounted **read-write** at `/data/outputs` inside the job container, so everything the algorithm writes there lands directly in the bucket as **individual files** (no archive, no copy step). Files appear in the bucket as the job writes them.
- No local `outputs.tar` is produced and the job's results index contains no `output` entry; logs (`imageLog`, `configurationLog`, `algorithmLog`) behave as usual. Results are retrieved via the persistent storage list/get APIs.
- The consumer starting the job must be the bucket owner or on the bucket access list, otherwise the start request is rejected with `403`.
- `outputBucketId` is **mutually exclusive** with the `output` (remote storage upload) parameter — sending both returns `400`.
- Files keep the names the algorithm gives them; writing an existing name **overwrites** it, so pipelines can re-run jobs with stable filenames.
- Nested directories created by the algorithm under `/data/outputs` are not visible through the bucket API (bucket filenames are flat); algorithms should write top-level files.

### Chaining jobs

Because results are regular bucket files, they can feed the next compute job without any intermediate download — use the standard `nodePersistentStorage` file object as a dataset:

```json
{
  "command": "freeStartCompute",
  "...": "...",
  "datasets": [
    {
      "fileObject": {
        "type": "nodePersistentStorage",
        "bucketId": "a4ad237d-dfd8-404c-a5d6-b8fc3a1f66d3",
        "fileName": "result-from-previous-job.csv"
      }
    }
  ],
  "outputBucketId": "a4ad237d-dfd8-404c-a5d6-b8fc3a1f66d3"
}
```

---

## Limitations and notes

- The bucket registry is local to the node (SQLite file). If you run multiple nodes, each node’s registry is independent unless you externalize/replicate it.
- `listBuckets(owner)` requires `owner` and only returns buckets that were created with that owner recorded.
- Filenames in `localfs` are constrained (no path separators) to avoid path traversal.
