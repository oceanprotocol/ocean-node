import { OceanNode } from '../../../OceanNode.js'
import {
  AlgoChecksums,
  ComputeAlgorithm,
  ComputeOutput
} from '../../../@types/C2D/C2D.js'
import { OceanNodeConfig } from '../../../@types/OceanNode.js'
import {
  StorageObject,
  EncryptMethod,
  isPersistentStorageType
} from '../../../@types/fileObject.js'
import { getFile } from '../../../utils/file.js'
import { Storage } from '../../storage/index.js'

import { CORE_LOGGER } from '../../../utils/logging/common.js'
import { errorSummary } from '../../../utils/logging/redact.js'
import { createHash } from 'crypto'
import { FindDdoHandler } from '../../core/handler/ddoHandler.js'
import { DDOManager, VersionedDDO } from '@oceanprotocol/ddo-js'

import { P2PCommandResponse } from '../../../@types/index.js'

export function generateUniqueID(jobStructure: any): string {
  const timestamp =
    BigInt(Date.now()) * 1_000_000n + (process.hrtime.bigint() % 1_000_000n)
  const random = Math.random()
  const jobId = createHash('sha256')
    .update(JSON.stringify(jobStructure) + timestamp.toString() + random.toString())
    .digest('hex')
  return jobId
}

export async function getAlgoChecksums(
  algoDID: string | undefined,
  algoServiceId: string | undefined,
  oceanNode: OceanNode,
  config: OceanNodeConfig,
  consumerAddress?: string,
  // Optional already-resolved algorithm DDO. Passing it guarantees the checksums
  // validated here are computed from the SAME DDO that bindAlgorithmContainerToDDO
  // binds the container from (one fetch, no cross-version drift).
  resolvedAlgoDDO?: any
): Promise<AlgoChecksums> {
  const checksums: AlgoChecksums = {
    files: '',
    container: '',
    serviceId: algoServiceId
  }
  // Raw-code algorithms have no DDO to resolve - skip the lookup (no error logs, no DB hit)
  if (!algoDID) {
    return checksums
  }
  try {
    const algoDDO =
      resolvedAlgoDDO ?? (await new FindDdoHandler(oceanNode).findAndFormatDdo(algoDID))
    if (!algoDDO) {
      CORE_LOGGER.debug(`Algorithm with id: ${algoDID} not found!`)
      return checksums
    }
    const fileArray = await getFile(algoDDO, algoServiceId, oceanNode)
    for (const file of fileArray) {
      // persistent storage checksums require a consumerAddress (ACL); guard so a
      // missing consumer errors instead of silently producing an empty checksum
      if (isPersistentStorageType((file as any)?.type) && !consumerAddress) {
        throw new Error(
          'Unable to compute checksum for persistent storage algorithm file: missing consumerAddress'
        )
      }
      const storage = Storage.getStorageClass(
        file as StorageObject,
        config,
        consumerAddress
      )
      const fileInfo = await storage.fetchSpecificFileMetadata(
        file as StorageObject,
        true // force checksum
      )
      checksums.files = checksums.files.concat(fileInfo.checksum)
    }

    const ddoInstance = DDOManager.getDDOClass(algoDDO)
    const { metadata } = ddoInstance.getDDOFields()
    checksums.container = createHash('sha256')
      .update(
        metadata.algorithm.container.entrypoint + metadata.algorithm.container.checksum
      )
      .digest('hex')
    return checksums
  } catch (error) {
    CORE_LOGGER.error(
      `Fetching algorithm checksums failed for ${algoDID}: ${errorSummary(error)}`
    )
    return checksums
  }
}

/**
 * Binds the algorithm container to its published DDO.
 *
 * SECURITY: the trusted-algorithm checks (publisherTrustedAlgorithms /
 * publisherTrustedAlgorithmPublishers in `validateAlgoForDataset`) validate
 * checksums computed from the algorithm's DDO (see `getAlgoChecksums`), but the
 * container that actually RUNS is read from `algorithm.meta.container`
 * (see `getAlgorithmImage` in compute_engine_docker). Nothing otherwise binds
 * the two. If a client-supplied `meta.container` were trusted for a published
 * algorithm, a consumer could pass a trusted `documentId`+`serviceId` (so the
 * checksum check passes) together with a DIFFERENT image and run arbitrary code
 * on the dataset, exfiltrating `/data/inputs` through `/data/outputs`.
 *
 * Therefore, whenever the algorithm is a PUBLISHED one (`documentId` present)
 * and its DDO is of type `algorithm`, the container meta MUST be taken from the
 * DDO and any client-supplied `meta.container` ignored. The validated checksums
 * and the executed container then come from the same source. This mutates the
 * passed `algorithm` in place and is a no-op for raw-code algorithms.
 *
 * Field ownership decision:
 *  - DDO-OWNED: EVERYTHING under the DDO's `metadata.algorithm` - the whole
 *    `container` (entrypoint, image, tag, checksum and any DDO-declared
 *    `consumerParameters`), `language`, `version`, `format`, etc. We copy the
 *    DDO's `metadata.algorithm` wholesale rather than cherry-picking a handful of
 *    fields, because the security property is "everything comes from the DDO,
 *    nothing from the client" - a field-allowlist would silently drop legitimate
 *    published fields (e.g. container.consumerParameters) AND risk re-opening the
 *    hole if the allowlist ever misses a field getAlgorithmImage reads.
 *  - CLIENT-OWNED (left untouched, they live OUTSIDE `meta`): `transferTxId`,
 *    `serviceId`, `documentId`, `algocustomdata`, `userdata`, `envs`. `meta` is
 *    rebuilt from scratch (deep-cloned from the DDO, never spread from the client
 *    value) so NO client field survives for a published algorithm.
 *  - STRIPPED from the bound `meta` even though they come from the DDO: `rawcode`,
 *    `container.dockerfile` and `container.additionalDockerFiles`. These are NOT
 *    covered by the trusted-algorithm checksums (containerSectionChecksum only hashes
 *    entrypoint+checksum; filesChecksum only covers the service files), so leaving them
 *    in would let a published algorithm's code/image change without changing the trusted
 *    checksums. `rawcode` in particular IS a standard algorithm DDO field
 *    (MetadataAlgorithm.rawcode), so structuredClone would preserve it - we delete it (and
 *    the dockerfile build fields) so a bound algorithm always runs its checksummed service
 *    files via its pinned, checksummed image. (See the delete block below for the exact
 *    execution paths each field drives.)
 *  - DROPPED for a published algorithm: `fileObject`. It is client-owned and lives
 *    OUTSIDE `meta`, but it is the algorithm CODE file that resolveComputeFileObject
 *    executes (it wins over documentId+serviceId). Since the checksums are computed
 *    from the DDO's service files, leaving a client `fileObject` would validate the
 *    DDO's code but run the client's. We delete it so a bound algorithm's code also
 *    comes from the DDO service. (Raw-code algorithms keep it - they never reach here.)
 *
 * `resolvedAlgoDDO` lets callers that already fetched the algorithm DDO (the
 * compute handlers, via getAlgoChecksums / the asset-validation loop) pass it in,
 * so the container bound here and the checksums validated elsewhere come from ONE
 * fetch and can never be two different DDO versions.
 *
 * This mirrors ocean-provider's original
 * `if algorithm_did and not algo_data.get("meta")` behavior, but authoritative:
 * the DDO always wins for a published algorithm, not only when meta was omitted.
 *
 * Returns a discriminated outcome so callers can react:
 *  - 'bound'   : a published algorithm DDO was resolved and its container bound.
 *  - 'skipped' : nothing to bind - a raw-code/unpublished algorithm (no documentId,
 *                client meta is legitimate and governed by `allowRawAlgorithm`).
 *  - 'invalid' : the documentId could not be bound to a usable published algorithm -
 *                either it did NOT resolve to any DDO, or it resolved to a DDO that is
 *                NOT a usable algorithm (not type `algorithm`, or an algorithm with no
 *                container). In every case the client meta is left untouched and the
 *                caller MUST reject the request (HTTP 400) - we must not run a
 *                client-supplied container/code under a documentId we cannot verify.
 */
export type BindAlgorithmOutcome = 'bound' | 'skipped' | 'invalid'

export async function bindAlgorithmContainerToDDO(
  algorithm: ComputeAlgorithm,
  oceanNode: OceanNode,
  resolvedAlgoDDO?: any
): Promise<BindAlgorithmOutcome> {
  // Raw-code / unpublished algorithms have no DDO: their client meta is
  // legitimate and governed by the dataset's `allowRawAlgorithm` flag.
  if (!algorithm?.documentId) {
    return 'skipped'
  }
  const algoDDO =
    resolvedAlgoDDO ??
    (await new FindDdoHandler(oceanNode).findAndFormatDdo(algorithm.documentId))
  if (!algoDDO) {
    // documentId was supplied but its DDO could not be resolved. We cannot verify what
    // container/code this "published" algorithm should run, so the client-supplied meta /
    // fileObject MUST NOT be trusted. Reject authoritatively (caller -> HTTP 400) instead
    // of returning 'skipped' and relying on downstream checks (the paid checksum gate / the
    // trust check) to catch it - the free path has no checksum gate, and a wildcard trusted
    // list would otherwise let a client container run under an unresolvable documentId.
    return 'invalid'
  }
  const ddoInstance = DDOManager.getDDOClass(algoDDO)
  const { metadata } = ddoInstance.getDDOFields() as any
  if (metadata?.type !== 'algorithm' || !metadata.algorithm?.container) {
    // Resolved but NOT a usable algorithm asset - reject instead of silently leaving
    // the client's meta.container in place.
    return 'invalid'
  }
  // Deep-clone so we take a faithful, DDO-owned snapshot and never alias (or later
  // mutate) the cached DDO object.
  algorithm.meta = structuredClone(metadata.algorithm)
  // SECURITY: strip build / raw-execution fields from the bound meta. These are NOT covered
  // by the trusted-algorithm checksums - `containerSectionChecksum` only hashes
  // (container.entrypoint + container.checksum) and `filesChecksum` only covers the DDO
  // service files - so if they survived the clone, a published algorithm's executed code or
  // image could change WITHOUT changing the checksums the dataset owner trusts. structuredClone
  // copies whatever the DDO carries, and `rawcode` IS part of the standard algorithm DDO
  // schema (MetadataAlgorithm.rawcode), so "the DDO never contains them" is not a safe
  // assumption - we remove them explicitly:
  //  - `rawcode`: uploadData writes meta.rawcode verbatim as the algorithm instead of the
  //    checksummed service files, AND the paid checksum gate (enforceAlgoChecksums) treats any
  //    rawcode as a raw algorithm and skips the checksum requirement entirely.
  //  - `container.dockerfile` / `container.additionalDockerFiles`: getAlgorithmImage +
  //    buildImage build a LOCAL image from the dockerfile instead of pulling the checksummed
  //    image.
  // A published (bound) algorithm must therefore always run its checksummed service files via
  // its pinned, checksummed image. Raw code and dockerfile builds remain available only to
  // raw/unpublished algorithms (no documentId, 'skipped' above), governed by allowRawAlgorithm.
  delete (algorithm.meta as any).rawcode
  if (algorithm.meta.container) {
    delete (algorithm.meta.container as any).dockerfile
    delete (algorithm.meta.container as any).additionalDockerFiles
  }
  // SECURITY: the container is not the only thing read from the client - the algorithm
  // CODE file is resolved by resolveComputeFileObject (uploadData), which honors a
  // client-supplied `fileObject` BEFORE falling back to documentId+serviceId. The
  // trusted-algorithm checksums are computed from the DDO's service files, so a published
  // algorithm that still carried a client `fileObject` would validate the DDO's files but
  // EXECUTE the client's code - the same bypass class as the container. Drop it so the
  // bound (published) algorithm resolves its code from the DDO service (documentId +
  // serviceId) only. Raw-code/unpublished algorithms keep their fileObject (early return
  // above), governed by the dataset's allowRawAlgorithm.
  delete algorithm.fileObject
  return 'bound'
}

export async function validateAlgoForDataset(
  algoDID: string,
  algoChecksums: {
    files: string
    container: string
    serviceId?: string
  },
  ddoInstance: VersionedDDO,
  datasetServiceId: string,
  oceanNode: OceanNode
) {
  try {
    const { services } = ddoInstance.getDDOFields() as any
    const datasetService = services.find(
      (service: any) => service.id === datasetServiceId
    )
    if (!datasetService) {
      throw new Error('Dataset service not found')
    }
    if (datasetService.type === 'access') {
      return true
    }
    const { compute } = datasetService
    if (datasetService.type !== 'compute' || !compute) {
      throw new Error('Service not compute')
    }
    const publishers = compute.publisherTrustedAlgorithmPublishers || []
    const algorithms = compute.publisherTrustedAlgorithms || []

    // If no restrictions are set, deny by default
    const hasTrustedPublishers = publishers.length > 0
    const hasTrustedAlgorithms = algorithms.length > 0
    if (!hasTrustedPublishers && !hasTrustedAlgorithms) return false

    if (algoDID) {
      // Check if algorithm is explicitly trusted
      const isAlgoTrusted =
        hasTrustedAlgorithms &&
        algorithms.some((algo: any) => {
          const didMatch = algo.did === '*' || algo.did === algoDID
          const filesMatch =
            algo.filesChecksum === '*' || algo.filesChecksum === algoChecksums.files
          const containerMatch =
            algo.containerSectionChecksum === '*' ||
            algo.containerSectionChecksum === algoChecksums.container
          if ('serviceId' in algo) {
            const serviceIdMatch =
              algo.serviceId === '*' || algo.serviceId === algoChecksums.serviceId
            return didMatch && filesMatch && containerMatch && serviceIdMatch
          }

          return didMatch && filesMatch && containerMatch
        })

      // Check if algorithm publisher is trusted
      let isPublisherTrusted = false
      if (hasTrustedPublishers) {
        if (!publishers.includes('*')) {
          const algoDDO = await new FindDdoHandler(oceanNode).findAndFormatDdo(algoDID)
          if (!algoDDO) return false
          const algoInstance = DDOManager.getDDOClass(algoDDO)
          const { nftAddress } = algoInstance.getDDOFields()

          isPublisherTrusted = publishers
            .map((addr: string) => addr?.toLowerCase())
            .includes(nftAddress?.toLowerCase())
        } else {
          isPublisherTrusted = true
        }
      }

      return isAlgoTrusted || isPublisherTrusted
    }

    return compute.allowRawAlgorithm
  } catch (error) {
    CORE_LOGGER.error(
      `validateAlgoForDataset (dataset ${ddoInstance?.getDid?.()}, algo ${algoDID}): ${error.message}`
    )
    return false
  }
}

// checks if the encrypted string sent by the user is a valid ComputeOutput object
export async function validateOutput(
  node: OceanNode,
  output: string,
  config: OceanNodeConfig
): Promise<P2PCommandResponse> {
  // null output is valid, because it's optional
  if (!output) {
    return {
      status: {
        httpStatus: 200,
        error: null,
        headers: null
      },
      stream: null
    }
  }

  try {
    const decrypted = await node
      .getKeyManager()
      .decrypt(Buffer.from(output, 'hex'), EncryptMethod.ECIES)

    const obj = JSON.parse(decrypted.toString()) as ComputeOutput
    const storage = Storage.getStorageClass(obj.remoteStorage, config)

    const hasUploadSupport =
      storage.hasUpload && 'upload' in storage && typeof storage.upload === 'function'

    // Only validate output-encryption semantics if backend can actually upload results.
    if (!hasUploadSupport) {
      return {
        status: {
          httpStatus: 400,
          error: `Storage class has no support for upload`,
          headers: null
        },
        stream: null
      }
    }
    const [isValidStorage, storageValidationError] = storage.validate()
    if (!isValidStorage) {
      return {
        status: {
          httpStatus: 400,
          error: storageValidationError || 'Invalid remote storage configuration',
          headers: null
        },
        stream: null
      }
    }
    if (obj.encryption && !obj.encryption.key) {
      return {
        status: {
          httpStatus: 400,
          error: `Encryption required, but no key`,
          headers: null
        },
        stream: null
      }
    }
    if (obj.encryption && obj.encryption.encryptMethod !== EncryptMethod.AES) {
      return {
        status: {
          httpStatus: 400,
          error: `Only AES encryption is supported`,
          headers: null
        },
        stream: null
      }
    }
    if (obj.encryption?.key) {
      const keyBytes = Buffer.from(obj.encryption.key, 'hex')
      if (keyBytes.length < 32) {
        return {
          status: {
            httpStatus: 400,
            error: `AES key must be at least 32 bytes (64 hex chars), got ${keyBytes.length} bytes`,
            headers: null
          },
          stream: null
        }
      }
    }

    return {
      status: {
        httpStatus: 200,
        error: null,
        headers: null
      },
      stream: null
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    return {
      status: {
        httpStatus: 400,
        error: `Invalid output: ${message}`,
        headers: null
      },
      stream: null
    }
  }
}

export async function validateOutputBucket(
  node: OceanNode,
  outputBucketId: string,
  output: string,
  consumerAddress: string
): Promise<P2PCommandResponse> {
  const success: P2PCommandResponse = {
    status: {
      httpStatus: 200,
      error: null,
      headers: null
    },
    stream: null
  }
  const failure = (httpStatus: number, error: string): P2PCommandResponse => ({
    status: {
      httpStatus,
      error,
      headers: null
    },
    stream: null
  })

  if (!outputBucketId) {
    return success
  }
  if (output) {
    return failure(400, 'output and outputBucketId are mutually exclusive')
  }
  const persistentStorage = node.getPersistentStorage()
  if (!persistentStorage) {
    return failure(400, 'Persistent storage is not enabled on this node')
  }
  try {
    persistentStorage.validateBucket(outputBucketId)
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    return failure(400, message)
  }
  try {
    await persistentStorage.assertConsumerAllowedForBucket(
      consumerAddress,
      outputBucketId
    )
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    return failure(403, message)
  }
  return success
}
