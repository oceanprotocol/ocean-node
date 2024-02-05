import { OceanNode } from '../../OceanNode.js'
import { CORE_LOGGER } from '../../utils/logging/common.js'
import { createHash } from 'crypto'
import { getAddress } from 'ethers'
import { FindDdoHandler } from '../core/ddoHandler.js'
import { decrypt } from '../../utils/crypt.js'
import { fetchFileMetadata } from '../../utils/asset.js'
import { Storage } from '../storage/index.js'

export function checkEnvironmentExists() {
  throw new Error('Not implemented')
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

function checkString(value: any) {
  return typeof value === 'string' || value instanceof String
}

function checkTypeString(value: any) {
  return ['text', 'number', 'boolean', 'select'].includes(value)
}

function checkBoolean(value: any) {
  return typeof value === 'boolean' || value instanceof Boolean
}

function checkNumber(value: any) {
  return typeof value === 'number' || value instanceof Number
}

export function validateConsumerParameters(consumerParameters: any) {
  const validation = {
    valid: true,
    message: ''
  }
  try {
    for (const consumerParameter of consumerParameters) {
      if (!checkString(consumerParameter.name)) {
        throw new Error("value of 'name' parameter is not a string")
      }
      if (!checkString(consumerParameter.type)) {
        throw new Error("value of 'type' parameter is not a string")
      }
      if (!checkTypeString(consumerParameter.type)) {
        throw new Error("'type' parameter is not text, number, boolean, select")
      }
      if (!checkString(consumerParameter.label)) {
        throw new Error("value of 'label' parameter is not a string")
      }
      if (!checkBoolean(consumerParameter.required)) {
        throw new Error("value of 'required' parameter is not a boolean")
      }
      if (!checkString(consumerParameter.description)) {
        throw new Error("value of 'description' parameter is not a string")
      }
      if (
        !checkBoolean(consumerParameter.default) &&
        !checkNumber(consumerParameter.default) &&
        !checkString(consumerParameter.default)
      ) {
        throw new Error("value of 'description' parameter is not a string")
      }
      if (
        !checkString(consumerParameter.default) &&
        consumerParameter.type === 'select'
      ) {
        throw new Error("value of 'default' parameter is not a string")
      }
      if (consumerParameter.options) {
        if (!Array.isArray(consumerParameter.options)) {
          throw new Error("value of 'options' must be an array")
        }
        for (const option of consumerParameter.options) {
          if (Object.keys(option).length !== 1) {
            throw new Error("object of 'option' must containing a single key")
          }
        }
      }
    }
    return validation
  } catch (error) {
    CORE_LOGGER.error(error.message)
    validation.valid = false
    validation.message = error.message
    return validation
  }
}
