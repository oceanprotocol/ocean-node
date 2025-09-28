import { OceanNode } from '../../../OceanNode.js'
import { AlgoChecksums } from '../../../@types/C2D/C2D.js'
import {
  ArweaveFileObject,
  IpfsFileObject,
  UrlFileObject
} from '../../../@types/fileObject.js'
import { getFile } from '../../../utils/file.js'
import urlJoin from 'url-join'
import { fetchFileMetadata } from '../../../utils/asset.js'

import { CORE_LOGGER } from '../../../utils/logging/common.js'
import { createHash } from 'crypto'
import { FindDdoHandler } from '../../core/handler/ddoHandler.js'
import { DDOManager, VersionedDDO } from '@oceanprotocol/ddo-js'

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
  oceanNode: OceanNode
): Promise<AlgoChecksums> {
  const checksums: AlgoChecksums = {
    files: '',
    container: ''
  }
  try {
    const algoDDO = await new FindDdoHandler(oceanNode).findAndFormatDdo(algoDID)
    if (!algoDDO) {
      CORE_LOGGER.error(`Algorithm with id: ${algoDID} not found!`)
      return checksums
    }
    const fileArray = await getFile(algoDDO, algoServiceId, oceanNode)
    for (const file of fileArray) {
      const url =
        file.type === 'url'
          ? (file as UrlFileObject).url
          : file.type === 'arweave'
          ? urlJoin(
              process.env.ARWEAVE_GATEWAY,
              (file as ArweaveFileObject).transactionId
            )
          : file.type === 'ipfs'
          ? urlJoin(process.env.IPFS_GATEWAY, (file as IpfsFileObject).hash)
          : null

      const { contentChecksum } = await fetchFileMetadata(url, 'get', false)
      checksums.files = checksums.files.concat(contentChecksum)
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
          if ('serviceId' in Object.keys(algo)) {
            const serviceIdMatch =
              algo.serviceId === '*' || algo.serviceId === algoChecksums.serviceId
            return didMatch && filesMatch && containerMatch && serviceIdMatch
          }

          return didMatch && filesMatch && containerMatch
        })

      // Check if algorithm publisher is trusted
      let isPublisherTrusted = true
      if (hasTrustedPublishers) {
        if (!publishers.includes('*')) {
          const algoDDO = await new FindDdoHandler(oceanNode).findAndFormatDdo(algoDID)
          if (!algoDDO) return false
          const algoInstance = DDOManager.getDDOClass(algoDDO)
          const { nftAddress } = algoInstance.getDDOFields()

          isPublisherTrusted = publishers
            .map((addr: string) => addr?.toLowerCase())
            .includes(nftAddress?.toLowerCase())
        }
      }

      return isAlgoTrusted && isPublisherTrusted
    }

    return compute.allowRawAlgorithm
  } catch (error) {
    CORE_LOGGER.error(error.message)
    return false
  }
}
