import { Readable } from 'stream'
import urlJoin from 'url-join'
import { P2PCommandResponse } from '../../../@types/index.js'
import {
  ArweaveFileObject,
  IpfsFileObject,
  UrlFileObject
} from '../../../@types/fileObject.js'
import { OceanNodeConfig } from '../../../@types/OceanNode.js'
import { FileInfoCommand } from '../../../@types/commands.js'
import { CORE_LOGGER } from '../../../utils/logging/common.js'
import { Storage } from '../../storage/index.js'
import { CommandHandler } from './handler.js'
import { validateDDOIdentifier } from './ddoHandler.js'
import { fetchFileMetadata } from '../../../utils/asset.js'
import {
  ValidateParams,
  buildInvalidRequestMessage,
  validateCommandParameters
} from '../../httpRoutes/validateCommands.js'
import { getFile } from '../../../utils/file.js'
import { getConfiguration } from '../../../utils/index.js'

async function formatMetadata(
  file: ArweaveFileObject | IpfsFileObject | UrlFileObject,
  config: OceanNodeConfig
) {
  const url =
    file.type === 'url'
      ? (file as UrlFileObject).url
      : file.type === 'arweave'
        ? urlJoin(config.arweaveGateway, (file as ArweaveFileObject).transactionId)
        : file.type === 'ipfs'
          ? urlJoin(config.ipfsGateway, (file as IpfsFileObject).hash)
          : null
  const headers = file.type === 'url' ? (file as UrlFileObject).headers : undefined

  const { contentLength, contentType, contentChecksum } = await fetchFileMetadata(
    url,
    'get',
    false,
    headers ? headers[0] : undefined
  )
  CORE_LOGGER.logMessage(`Metadata for file: ${contentLength} ${contentType}`)

  return {
    valid: true,
    contentLength,
    contentType,
    checksum: contentChecksum,
    name: new URL(url).pathname.split('/').pop() || '',
    type: file.type
  }
}
export class FileInfoHandler extends CommandHandler {
  validate(command: FileInfoCommand): ValidateParams {
    let validation = validateCommandParameters(command, []) // all optional? weird
    if (validation.valid) {
      if (command.did) {
        validation = validateDDOIdentifier(command.did)
        if (validation.valid && !command.serviceId) {
          validation.valid = false
          validation.reason = 'Invalid Request: matching "serviceId" not specified!'
        }
      } else if (
        !command.checksum &&
        !command.did &&
        !command.file &&
        !command.fileIndex &&
        !command.serviceId &&
        !command.type
      ) {
        return buildInvalidRequestMessage('Invalid Request: no fields are present!')
      }
    }
    return validation
  }

  async handle(task: FileInfoCommand): Promise<P2PCommandResponse> {
    const validationResponse = await this.verifyParamsAndRateLimits(task)
    if (this.shouldDenyTaskHandling(validationResponse)) {
      return validationResponse
    }
    try {
      const oceanNode = this.getOceanNode()
      const config = await getConfiguration()
      let fileInfo = []

      if (task.file && task.type) {
        const storage = Storage.getStorageClass(task.file, config)

        fileInfo = await storage.getFileInfo({
          type: task.type,
          fileIndex: task.fileIndex
        })
      } else if (task.did && task.serviceId) {
        const fileArray = await getFile(task.did, task.serviceId, oceanNode)
        if (task.fileIndex) {
          const fileMetadata = await formatMetadata(fileArray[task.fileIndex], config)
          fileInfo.push(fileMetadata)
        } else {
          for (const file of fileArray) {
            const fileMetadata = await formatMetadata(file, config)
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
