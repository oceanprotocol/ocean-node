import { OceanNode } from '../../OceanNode.js'
import { CORE_LOGGER } from '../../utils/logging/common.js'
import { createHash } from 'crypto'
import { FindDdoHandler } from '../core/handler/ddoHandler.js'
import { getConfiguration } from '../../utils/config.js'
import { ComputeGetEnvironmentsHandler } from '../core/compute/index.js'
import { PROTOCOL_COMMANDS } from '../../utils/constants.js'
import { streamToObject } from '../../utils/util.js'
import { Readable } from 'stream'
import {
  ArweaveFileObject,
  IpfsFileObject,
  UrlFileObject
} from '../../@types/fileObject.js'
import { AlgoChecksums } from '../../@types/C2D.js'
import { DDO } from '../../@types/DDO/DDO.js'
import { getFile } from '../../utils/file.js'
import urlJoin from 'url-join'
import { fetchFileMetadata } from '../../utils/asset.js'

export async function checkC2DEnvExists(
  envId: string,
  oceanNode: OceanNode
): Promise<boolean> {
  const config = await getConfiguration()
  const { supportedNetworks } = config
  for (const supportedNetwork of Object.keys(supportedNetworks)) {
    const getEnvironmentsTask = {
      command: PROTOCOL_COMMANDS.COMPUTE_GET_ENVIRONMENTS,
      chainId: parseInt(supportedNetwork)
    }
    const response = await new ComputeGetEnvironmentsHandler(oceanNode).handle(
      getEnvironmentsTask
    )
    if (response.status.httpStatus === 200) {
      const computeEnvironments = await streamToObject(response.stream as Readable)
      for (const computeEnvironment of computeEnvironments[parseInt(supportedNetwork)]) {
        if (computeEnvironment.id === envId) {
          return true
        }
      }
    }
  }
  return false
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

    checksums.container = createHash('sha256')
      .update(
        algoDDO.metadata.algorithm.container.entrypoint +
          algoDDO.metadata.algorithm.container.checksum
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
  },
  datasetDDO: DDO,
  datasetServiceId: string,
  oceanNode: OceanNode
) {
  try {
    const datasetService = datasetDDO.services.find(
      (service) => service.id === datasetServiceId
    )
    if (!datasetService) {
      throw new Error('Dataset service not found')
    }
    const { compute } = datasetService
    if (datasetService.type !== 'compute' || !compute) {
      throw new Error('Service not compute')
    }

    if (algoDID) {
      if (
        // if not set allow them all
        !compute.publisherTrustedAlgorithms &&
        !compute.publisherTrustedAlgorithmPublishers
      ) {
        return true
      }
      // if is set only allow if match
      if (compute.publisherTrustedAlgorithms) {
        const trustedAlgo = compute.publisherTrustedAlgorithms.find(
          (algo) => algo.did === algoDID
        )
        if (trustedAlgo) {
          return (
            trustedAlgo.filesChecksum === algoChecksums.files &&
            trustedAlgo.containerSectionChecksum === algoChecksums.container
          )
        }
        return false
      }
      if (compute.publisherTrustedAlgorithmPublishers) {
        const algoDDO = await new FindDdoHandler(oceanNode).findAndFormatDdo(algoDID)
        if (algoDDO) {
          return compute.publisherTrustedAlgorithmPublishers
            .map((address) => address?.toLowerCase())
            .includes(algoDDO.nftAddress?.toLowerCase())
        }
        return false
      }
      return true
    }

    return compute.allowRawAlgorithm
  } catch (error) {
    CORE_LOGGER.error(error.message)
    return false
  }
}
