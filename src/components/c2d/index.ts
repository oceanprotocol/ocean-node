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
  did: string,
  serviceId: string,
  oceanNode: OceanNode
) {
  const checksums = {
    files: '',
    container: ''
  }
  try {
    const ddo = await new FindDdoHandler(oceanNode).findAndFormatDdo(did)
    const service = ddo.services.find((service) => service.id === serviceId)
    if (!service) {
      throw new Error('Service not found')
    }
    const decryptedUrlBytes = await decrypt(
      Uint8Array.from(Buffer.from(service.files, 'hex')),
      'ECIES'
    )
    const decryptedFilesString = Buffer.from(decryptedUrlBytes).toString()
    const decryptedFileArray = JSON.parse(decryptedFilesString)

    for (const file of decryptedFileArray.files) {
      const storage = Storage.getStorageClass(file)
      const fileInfo = await storage.getFileInfo({ type: file.type })
      console.log('fileInfo', fileInfo)
      checksums.files = checksums.files.concat(fileInfo[0].contentChecksum)
    }
    checksums.container = createHash('sha256')
      .update(
        ddo.metadata.algorithm.container.entrypoint +
          ddo.metadata.algorithm.container.checksum
      )
      .digest('hex')
    return checksums
  } catch (error) {
    CORE_LOGGER.error(error.message)
    return checksums
  }
}

export function validateAlgoForDataset() {
  throw new Error('Not implemented')
}

export function validateConsumerParameters() {
  throw new Error('Not implemented')
}
