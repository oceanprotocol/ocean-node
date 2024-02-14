import { OceanNode } from '../../OceanNode.js'
import { CORE_LOGGER } from '../../utils/logging/common.js'
import { createHash } from 'crypto'
import { FindDdoHandler } from '../core/ddoHandler.js'
import { decrypt } from '../../utils/crypt.js'
import { Storage } from '../storage/index.js'
import { getConfiguration } from '../../utils/config.js'
import { GetEnvironmentsHandler } from '../core/compute.js'
import { PROTOCOL_COMMANDS } from '../../utils/constants.js'
import { streamToObject } from '../../utils/util.js'
import { Readable } from 'stream'

export async function checkC2DEnvExists(envId: string, oceanNode: OceanNode) {
  const config = await getConfiguration()
  const { supportedNetworks } = config
  for (const supportedNetwork of Object.keys(supportedNetworks)) {
    const getEnvironmentsTask = {
      command: PROTOCOL_COMMANDS.GET_COMPUTE_ENVIRONMENTS,
      chainId: parseInt(supportedNetwork)
    }
    const response = await new GetEnvironmentsHandler(oceanNode).handle(
      getEnvironmentsTask
    )
    if (response.status.httpStatus === 200) {
      const computeEnvironments = await streamToObject(response.stream as Readable)
      for (const computeEnvironment of computeEnvironments) {
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
) {
  const checksums = {
    files: '',
    container: ''
  }
  try {
    const algoDDO = await new FindDdoHandler(oceanNode).findAndFormatDdo(algoDID)
    if (!algoDDO) {
      throw new Error('Algorithm DDO not found')
    }
    const algorithmService = algoDDO.services.find(
      (service) => service.id === algoServiceId
    )
    if (!algorithmService) {
      throw new Error('Algorithm service not found')
    }
    const decryptedUrlBytes = await decrypt(
      Uint8Array.from(Buffer.from(algorithmService.files, 'hex')),
      'ECIES'
    )
    const decryptedFilesString = Buffer.from(decryptedUrlBytes).toString()
    const decryptedFileArray = JSON.parse(decryptedFilesString)

    for (const file of decryptedFileArray.files) {
      const storage = Storage.getStorageClass(file)
      const fileInfo = await storage.getFileInfo({ type: file.type }, true)
      checksums.files = checksums.files.concat(fileInfo[0].contentChecksum)
    }
    checksums.container = createHash('sha256')
      .update(
        algoDDO.metadata.algorithm.container.entrypoint +
          algoDDO.metadata.algorithm.container.checksum
      )
      .digest('hex')
    return checksums
  } catch (error) {
    CORE_LOGGER.error(error.message)
    return checksums
  }
}

export async function validateAlgoForDataset(
  algoDID: string,
  algoChecksums: {
    files: string
    container: string
  },
  datasetDID: string,
  datasetServiceId: string,
  oceanNode: OceanNode
) {
  try {
    const datasetDDO = await new FindDdoHandler(oceanNode).findAndFormatDdo(datasetDID)
    if (!datasetDDO) {
      throw new Error('Dataset DDO not found')
    }
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
        compute.publisherTrustedAlgorithms === undefined &&
        compute.publisherTrustedAlgorithmPublishers === undefined
      ) {
        return true
      }
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
          return compute.publisherTrustedAlgorithmPublishers.includes(algoDDO.nftAddress)
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
