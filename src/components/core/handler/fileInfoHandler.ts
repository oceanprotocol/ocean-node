import { Readable } from 'stream'
import { P2PCommandResponse } from '../../../@types/index.js'
import {
  FileObjectType,
  StorageObject,
  isPersistentStorageType
} from '../../../@types/fileObject.js'
import { OceanNodeConfig } from '../../../@types/OceanNode.js'
import { FileInfoCommand } from '../../../@types/commands.js'
import { CORE_LOGGER } from '../../../utils/logging/common.js'
import { Storage } from '../../storage/index.js'
import { CommandHandler } from './handler.js'
import { validateDDOIdentifier } from './ddoHandler.js'
import {
  ValidateParams,
  buildInvalidRequestMessage,
  validateCommandParameters
} from '../../httpRoutes/validateCommands.js'
import { getFile } from '../../../utils/file.js'

async function formatMetadata(
  file: StorageObject,
  config: OceanNodeConfig,
  consumerAddress?: string
): Promise<{
  valid: boolean
  contentLength: string
  contentType: string
  checksum?: string
  name: string
  type: string
}> {
  // Persistent-storage files are ACL-gated: only resolve real metadata when a
  // consumerAddress is supplied (the backend then enforces the bucket ACL). Without it,
  // return a generic entry instead of querying the backend, to avoid leaking size/existence.
  if (isPersistentStorageType((file as { type?: string })?.type) && !consumerAddress) {
    return {
      valid: true,
      contentLength: '',
      contentType: 'application/octet-stream',
      name: '',
      type: FileObjectType.NODE_PERSISTENT_STORAGE
    }
  }
  const storage = Storage.getStorageClass(file, config, consumerAddress)
  const fileInfo = await storage.fetchSpecificFileMetadata(file, false)
  CORE_LOGGER.logMessage(
    `Metadata for file: ${fileInfo.contentLength} ${fileInfo.contentType}`
  )
  return fileInfo
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

    const matchesRegex = (value: string, regex: RegExp): boolean => regex.test(value)
    if (command.did && !matchesRegex(command.did, /^did:op/)) {
      return buildInvalidRequestMessage('Invalid Request: invalid did!')
    }
    if (command.type && !Object.values(FileObjectType).includes(command.type)) {
      return buildInvalidRequestMessage(
        'Invalid Request: type must be one of ' + Object.values(FileObjectType).join(', ')
      )
    }
    // persistent storage files are ACL-gated: a consumerAddress is required so the bucket
    // ACL can be enforced. Check both the top-level command type AND the embedded file type
    // (normalized for casing), since handle() routes getStorageClass on file.type.
    if (
      (isPersistentStorageType(command.type) ||
        isPersistentStorageType(command.file?.type)) &&
      !command.consumerAddress
    ) {
      return buildInvalidRequestMessage(
        'Invalid Request: consumerAddress is required for nodePersistentStorage files'
      )
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
      const config = oceanNode.getConfig()
      let fileInfo = []

      if (task.file && task.type) {
        const storage = Storage.getStorageClass(task.file, config, task.consumerAddress)

        fileInfo = await storage.getFileInfo({
          type: task.type,
          fileIndex: task.fileIndex
        })
      } else if (task.did && task.serviceId) {
        const fileArray = await getFile(task.did, task.serviceId, oceanNode)
        if (task.fileIndex) {
          const fileMetadata = await formatMetadata(
            fileArray[task.fileIndex],
            config,
            task.consumerAddress
          )
          fileInfo.push(fileMetadata)
        } else {
          for (const file of fileArray) {
            const fileMetadata = await formatMetadata(file, config, task.consumerAddress)
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
