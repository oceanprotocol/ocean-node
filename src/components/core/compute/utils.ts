import { OceanNode } from '../../../OceanNode.js'
import { AlgoChecksums, ComputeOutput } from '../../../@types/C2D/C2D.js'
import { OceanNodeConfig } from '../../../@types/OceanNode.js'
import { StorageObject, EncryptMethod } from '../../../@types/fileObject.js'
import { getFile } from '../../../utils/file.js'
import { Storage } from '../../storage/index.js'

import { CORE_LOGGER } from '../../../utils/logging/common.js'
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
  algoDID: string,
  algoServiceId: string,
  oceanNode: OceanNode,
  config: OceanNodeConfig
): Promise<AlgoChecksums> {
  const checksums: AlgoChecksums = {
    files: '',
    container: '',
    serviceId: algoServiceId
  }
  try {
    const algoDDO = await new FindDdoHandler(oceanNode).findAndFormatDdo(algoDID)
    if (!algoDDO) {
      CORE_LOGGER.error(`Algorithm with id: ${algoDID} not found!`)
      return checksums
    }
    const fileArray = await getFile(algoDDO, algoServiceId, oceanNode)
    for (const file of fileArray) {
      const storage = Storage.getStorageClass(file as StorageObject, config)
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
    CORE_LOGGER.error(`Fetching algorithm checksums failed: ${error.message}`)
    return checksums
  }
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
    CORE_LOGGER.error(error.message)
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
