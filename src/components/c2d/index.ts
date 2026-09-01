import { deleteKeysFromObject, sanitizeServiceFiles } from '../../utils/util.js'

import { BaseFileObject, EncryptMethod } from '../../@types/fileObject.js'
import { CORE_LOGGER } from '../../utils/logging/common.js'
import { DBComputeJob } from '../../@types/index.js'
import type {
  ContainerMetricsSnapshot,
  DBComputeJobMetadata,
  PublicComputeJob
} from '../../@types/C2D/C2D.js'
import { OceanNode } from '../../OceanNode.js'
export { C2DEngine } from './compute_engine_base.js'

// Max JSON-serialized size of the user-supplied `metadata` bag carried by a compute job
// (DBComputeJob) or a service job (ServiceJob). Metadata is meant for small labels/tags,
// not payloads.
export const MAX_JOB_METADATA_SIZE = 1024

// Validates the user-supplied metadata (untrusted HTTP/P2P input) against the
// DBComputeJobMetadata contract — a flat object of string/number/boolean values — and the
// MAX_JOB_METADATA_SIZE cap. Single source of truth shared by the request handlers (which
// turn a false into a 400) and the engine guard below, so the two paths cannot drift.
//   - undefined/null → valid ("absent"; the compute routes pass `null` for no metadata).
//   - anything else must be a plain object (not an array) whose values are all scalars.
//   - then the JSON-serialized form must be within the size cap.
export function isJobMetadataSizeValid(metadata?: DBComputeJobMetadata): boolean {
  if (metadata === undefined || metadata === null) return true
  if (typeof metadata !== 'object' || Array.isArray(metadata)) return false
  const scalar = (v: unknown) =>
    typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean'
  if (!Object.values(metadata).every(scalar)) return false
  return JSON.stringify(metadata).length <= MAX_JOB_METADATA_SIZE
}

// Message used for every metadata rejection (shape or size), so the engine throw and the
// handlers' 400 responses stay identical.
export const INVALID_JOB_METADATA_MESSAGE =
  'Invalid metadata: expected an object of string/number/boolean values, at most 1 KB'

// Throwing guard for the engine paths (compute startComputeJob + service create/restart) —
// defense-in-depth behind the handlers' fail-fast 400. Throws when isJobMetadataSizeValid
// is false so the two paths cannot drift.
export function validateJobMetadataSize(metadata?: DBComputeJobMetadata): void {
  if (!isJobMetadataSizeValid(metadata)) {
    throw new Error(INVALID_JOB_METADATA_MESSAGE)
  }
}

export async function decryptFilesObject(
  serviceFiles: any
): Promise<BaseFileObject | null> {
  const node = OceanNode.getInstance()

  try {
    // 2. Decrypt the url
    const decryptedUrlBytes = await node
      .getKeyManager()
      .decrypt(
        Uint8Array.from(Buffer.from(sanitizeServiceFiles(serviceFiles), 'hex')),
        EncryptMethod.ECIES
      )

    // 3. Convert the decrypted bytes back to a string
    const decryptedFilesString = Buffer.from(decryptedUrlBytes).toString()
    const decryptedFileArray = JSON.parse(decryptedFilesString)

    return decryptedFileArray.files[0]
  } catch (err) {
    CORE_LOGGER.error('Error decrypting files object: ' + err.message)
    return null
  }
}

// Returns a runtime-metrics snapshot safe to expose in a response: drops the internal `prev`
// accumulator (delta bookkeeping meaningless to callers). Returns undefined for a missing snapshot.
export function sanitizePublicMetrics(
  snapshot: ContainerMetricsSnapshot | undefined
): ContainerMetricsSnapshot | undefined {
  if (!snapshot) return undefined
  const { prev, ...pub } = snapshot
  return pub as ContainerMetricsSnapshot
}

// Maps a DBComputeJob to the public ComputeJob shape by stripping node-internal fields.
//
// By DEFAULT `runtimeMetrics` is stripped — this same default-shape is serialized into the
// on-chain escrow claim proof (compute_engine_docker.ts), which MUST stay deterministic and
// metrics-free. Pass { includeMetrics: true } ONLY on the authenticated owner status path to
// keep a sanitized snapshot; never for the proof.
export function omitDBComputeFieldsFromComputeJob(
  dbCompute: DBComputeJob,
  opts: { includeMetrics?: boolean } = {}
): PublicComputeJob {
  const keysToOmit = [
    'clusterHash',
    'configlogURL',
    'publishlogURL',
    'algologURL',
    'outputsURL',
    'algorithm',
    'assets',
    'isRunning',
    'isStarted',
    'containerImage',
    'encryptedDockerRegistryAuth',
    'output',
    'outputBucketId'
  ]
  if (!opts.includeMetrics) keysToOmit.push('runtimeMetrics')
  const job = deleteKeysFromObject(dbCompute, keysToOmit) as PublicComputeJob
  if (opts.includeMetrics && dbCompute.runtimeMetrics) {
    job.runtimeMetrics = sanitizePublicMetrics(dbCompute.runtimeMetrics)
  }
  return job
}
