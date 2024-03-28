import { Handler } from './handler.js'
import { P2PCommandResponse } from '../../../@types/OceanNode.js'
import { EncryptCommand, EncryptFileCommand } from '../../../@types/commands.js'
import * as base58 from 'base58-js'
import { Readable } from 'stream'
import { encrypt } from '../../../utils/crypt.js'
import { Storage } from '../../storage/index.js'
import { getConfiguration } from '../../../utils/index.js'
import { EncryptMethod } from '../../../@types/fileObject.js'
import {
  ValidateParams,
  buildInvalidParametersResponse,
  buildInvalidRequestMessage,
  buildRateLimitReachedResponse,
  validateCommandParameters
} from '../../httpRoutes/validateCommands.js'

// for encryption
export const SUPPORTED_ENCRYPTION_ENCODINGS = ['string', 'base58']
export const SUPPORTED_ENCRYPTION_METHODS = [
  EncryptMethod.AES.toString(),
  EncryptMethod.ECIES.toString()
]

export class EncryptHandler extends Handler {
  validate(command: EncryptCommand): ValidateParams {
    const commandValidation = validateCommandParameters(command, ['blob'])
    if (!commandValidation.valid) {
      return commandValidation
    }

    if (!command.encoding) {
      command.encoding = 'string' // defaults to string encoding
    }
    if (!command.encryptionType) {
      command.encryptionType = EncryptMethod.ECIES // defaults to ECIES encryption
    }

    if (!SUPPORTED_ENCRYPTION_ENCODINGS.includes(command.encoding.toLowerCase())) {
      return buildInvalidRequestMessage(
        `Invalid parameter: "encoding" must be one of: ${SUPPORTED_ENCRYPTION_ENCODINGS}`
      )
    }
    if (!SUPPORTED_ENCRYPTION_METHODS.includes(command.encryptionType.toUpperCase())) {
      return buildInvalidRequestMessage(
        `Invalid parameter: "encryptionType" must be one of: ${SUPPORTED_ENCRYPTION_ENCODINGS}`
      )
    }
    return commandValidation
  }

  async handle(task: EncryptCommand): Promise<P2PCommandResponse> {
    if (!(await this.checkRateLimit())) {
      return buildRateLimitReachedResponse()
    }
    const validation = this.validate(task)
    if (!validation.valid) {
      return buildInvalidParametersResponse(validation)
    }
    try {
      // prepare an empty array in case if
      let blobData: Uint8Array = new Uint8Array()
      if (task.encoding.toLowerCase() === 'string') {
        // get bytes from basic blob
        blobData = Uint8Array.from(Buffer.from(task.blob))
      }
      if (task.encoding.toLowerCase() === 'base58') {
        // get bytes from a blob that is encoded in standard base58
        blobData = base58.base58_to_binary(task.blob)
      }
      // do encrypt magic
      const encryptedData = await encrypt(blobData, task.encryptionType)
      return {
        stream: Readable.from('0x' + encryptedData.toString('hex')),
        status: { httpStatus: 200 }
      }
    } catch (error) {
      return {
        stream: null,
        status: { httpStatus: 500, error: 'Unknown error: ' + error.message }
      }
    }
  }
}

export class EncryptFileHandler extends Handler {
  validate(command: EncryptFileCommand): ValidateParams {
    const validateCommand = validateCommandParameters(command, [])
    if (validateCommand.valid) {
      if (!command.encryptionType) {
        command.encryptionType = EncryptMethod.AES // defaults to AES
      }

      if (!command.files && !command.rawData) {
        return buildInvalidRequestMessage(
          'Invalid request: Missing data to encrypt, use one of ["files","rawData"]'
        )
      }

      if (!SUPPORTED_ENCRYPTION_METHODS.includes(command.encryptionType.toUpperCase())) {
        return buildInvalidRequestMessage(
          `Invalid parameter: "encryptionType" must be one of: ${JSON.stringify(
            SUPPORTED_ENCRYPTION_ENCODINGS
          )}`
        )
      }
    }
    return validateCommand
  }

  async handle(task: EncryptFileCommand): Promise<P2PCommandResponse> {
    if (!(await this.checkRateLimit())) {
      return buildRateLimitReachedResponse()
    }
    const validation = this.validate(task)
    if (!validation.valid) {
      return buildInvalidParametersResponse(validation)
    }
    try {
      const config = await getConfiguration()
      const headers = {
        'Content-Type': 'application/octet-stream',
        'X-Encrypted-By': config.keys.peerId.toString(),
        'X-Encrypted-Method': task.encryptionType
      }
      let encryptedContent: Buffer
      if (task.files) {
        const storage = Storage.getStorageClass(task.files)
        encryptedContent = await storage.encryptContent(task.encryptionType)
      } else if (task.rawData !== null) {
        encryptedContent = await encrypt(task.rawData, task.encryptionType)
      }
      return {
        stream: Readable.from(encryptedContent),
        status: {
          httpStatus: 200,
          headers
        }
      }
    } catch (error) {
      return {
        stream: null,
        status: { httpStatus: 500, error: 'Unknown error: ' + error.message }
      }
    }
  }
}
