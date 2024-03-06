import { Readable } from 'stream'
import urlJoin from 'url-join'
import { P2PCommandResponse } from '../../@types'
import {
  ArweaveFileObject,
  EncryptMethod,
  IpfsFileObject,
  UrlFileObject
} from '../../@types/fileObject.js'
import { FileInfoCommand } from '../../@types/commands.js'
import { CORE_LOGGER } from '../../utils/logging/common.js'
import { ArweaveStorage, IpfsStorage, UrlStorage } from '../storage/index.js'
import { Handler } from './handler.js'
import { decrypt } from '../../utils/crypt.js'
import { Service } from '../../@types/DDO/Service.js'
import { FindDdoHandler } from './ddoHandler.js'
import { AssetUtils, fetchFileMetadata } from '../../utils/asset.js'
import { OceanNode } from '../../OceanNode.js'

async function getFile(
  did: string,
  serviceId: string,
  node: OceanNode
): Promise<UrlFileObject[] | ArweaveFileObject[] | IpfsFileObject[]> {
  try {
    // 1. Get the DDO
    const ddo = await new FindDdoHandler(node).findAndFormatDdo(did)
    // 2. Get the service
    const service: Service = AssetUtils.getServiceById(ddo, serviceId)
    if (!service) {
      const msg = `Service with id ${serviceId} not found`
      CORE_LOGGER.error(msg)
      throw new Error(msg)
    }
    // 3. Decrypt the url
    const decryptedUrlBytes = await decrypt(
      Uint8Array.from(Buffer.from(service.files, 'hex')),
      EncryptMethod.ECIES
    )
    CORE_LOGGER.logMessage(`URL decrypted for Service ID: ${serviceId}`)

    // Convert the decrypted bytes back to a string
    const decryptedFilesString = Buffer.from(decryptedUrlBytes).toString()
    const decryptedFileArray = JSON.parse(decryptedFilesString)
    return decryptedFileArray.files
  } catch (error) {
    const msg = 'Error occured while requesting the files: ' + error.message
    CORE_LOGGER.error(msg)
    throw new Error(msg)
  }
}

async function formatMetadata(file: ArweaveFileObject | IpfsFileObject | UrlFileObject) {
  CORE_LOGGER.logMessage(`Starting formatMetadata for file: ${JSON.stringify(file)}`)

  const url =
    file.type === 'url'
      ? (file as UrlFileObject).url
      : file.type === 'arweave'
      ? urlJoin(process.env.ARWEAVE_GATEWAY, (file as ArweaveFileObject).transactionId)
      : file.type === 'ipfs'
      ? (file as IpfsFileObject).hash
      : null

  const { contentLength, contentType } = await fetchFileMetadata(url)
  CORE_LOGGER.logMessage(`Metadata for file: ${contentLength} ${contentType}`)

  return {
    valid: true,
    contentLength,
    contentType,
    name: new URL(url).pathname.split('/').pop() || '',
    type: file.type
  }
}
export class FileInfoHandler extends Handler {
  async handle(task: FileInfoCommand): Promise<P2PCommandResponse> {
    try {
      CORE_LOGGER.logMessage(
        'File Info Request recieved with arguments: ' + JSON.stringify(task, null, 2),
        true
      )
      const oceanNode = this.getOceanNode()
      let fileInfo = []

      if (task.file && task.type) {
        const storage =
          task.type === 'url'
            ? new UrlStorage(task.file as UrlFileObject)
            : task.type === 'arweave'
            ? new ArweaveStorage(task.file as ArweaveFileObject)
            : task.type === 'ipfs'
            ? new IpfsStorage(task.file as IpfsFileObject)
            : null

        fileInfo = await storage.getFileInfo({
          type: task.type,
          fileIndex: task.fileIndex
        })
      } else if (task.did && task.serviceId) {
        const fileArray = await getFile(task.did, task.serviceId, oceanNode)

        if (task.fileIndex) {
          const fileMetadata = await formatMetadata(fileArray[task.fileIndex])
          fileInfo.push(fileMetadata)
        } else {
          for (const file of fileArray) {
            const fileMetadata = await formatMetadata(file)
            fileInfo.push(fileMetadata)
          }
        }
      } else {
        const errorMessage =
          'Invalid arguments. Please provide either file && Type OR did && serviceId'
        CORE_LOGGER.error(errorMessage)
        return {
          stream: null,
          status: {
            httpStatus: 400,
            error: errorMessage
          }
        }
      }
      CORE_LOGGER.logMessage(
        'File Info Response: ' + JSON.stringify(fileInfo, null, 2),
        true
      )

      return {
        stream: Readable.from(JSON.stringify(fileInfo)),
        status: {
          httpStatus: 200
        }
      }
    } catch (error) {
      CORE_LOGGER.error(error.message)
      return {
        stream: null,
        status: {
          httpStatus: 500,
          error: error.message
        }
      }
    }
  }
}
