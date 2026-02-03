import { CommandHandler } from './handler.js'
import { P2PCommandResponse } from '../../../@types/OceanNode.js'
import { EncryptCommand, EncryptFileCommand } from '../../../@types/commands.js'
import * as base58 from 'base58-js'
import { Readable } from 'stream'
import { Storage } from '../../storage/index.js'
import { getConfiguration, isPolicyServerConfigured } from '../../../utils/index.js'
import { PolicyServer } from '../../policyServer/index.js'
import { EncryptMethod } from '../../../@types/fileObject.js'
import {
  ValidateParams,
  buildInvalidRequestMessage,
  validateCommandParameters
} from '../../httpRoutes/validateCommands.js'
import { CORE_LOGGER } from '../../../utils/logging/common.js'

// for encryption
export const SUPPORTED_ENCRYPTION_ENCODINGS = ['string', 'base58']
export const SUPPORTED_ENCRYPTION_METHODS = [
  EncryptMethod.AES.toString(),
  EncryptMethod.ECIES.toString()
]

export class EncryptHandler extends CommandHandler {
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

    if (!SUPPORTED_ENCRYPTION_ENCODINGS.includes(command.encoding?.toLowerCase())) {
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
    const validationResponse = await this.verifyParamsAndRateLimits(task)

    if (this.shouldDenyTaskHandling(validationResponse)) {
      return validationResponse
    }
    const isAuthRequestValid = await this.validateTokenOrSignature(
      task.authorization,
      task.consumerAddress,
      task.nonce,
      task.signature,
      String(task.nonce)
    )
    if (isAuthRequestValid.status.httpStatus !== 200) {
      return isAuthRequestValid
    }

    if (isPolicyServerConfigured()) {
      const policyServer = new PolicyServer()
      const response = await policyServer.checkEncrypt(
        task.consumerAddress,
        task.policyServer
      )
      if (!response) {
        CORE_LOGGER.logMessage(
          `Error: Encrypt for ${task.consumerAddress} was denied`,
          true
        )
        return {
          stream: null,
          status: {
            httpStatus: 403,
            error: `Error: Encrypt for ${task.consumerAddress} was denied`
          }
        }
      }
    }
    try {
      const oceanNode = this.getOceanNode()
      // prepare an empty array in case if
      let blobData: Uint8Array = new Uint8Array()
      if (task.encoding?.toLowerCase() === 'string') {
        // get bytes from basic blob
        blobData = Uint8Array.from(Buffer.from(task.blob))
      }
      if (task.encoding?.toLowerCase() === 'base58') {
        // get bytes from a blob that is encoded in standard base58
        blobData = base58.base58_to_binary(task.blob)
      }
      // do encrypt magic
      const encryptedData = await oceanNode
        .getKeyManager()
        .encrypt(blobData, task.encryptionType)
      return {
        stream: Readable.from('0x' + encryptedData.toString('hex')),
        status: { httpStatus: 200 }
      }
    } catch (error) {
      CORE_LOGGER.error(`Error while encrypting data: ${error} `)
      return {
        stream: null,
        status: { httpStatus: 500, error: 'Unknown error: ' + error.message }
      }
    }
  }
}

export class EncryptFileHandler extends CommandHandler {
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
    const validationResponse = await this.verifyParamsAndRateLimits(task)
    if (this.shouldDenyTaskHandling(validationResponse)) {
      return validationResponse
    }
    const isAuthRequestValid = await this.validateTokenOrSignature(
      task.authorization,
      task.consumerAddress,
      task.nonce,
      task.signature,
      String(task.nonce)
    )
    if (isAuthRequestValid.status.httpStatus !== 200) {
      return isAuthRequestValid
    }

    if (isPolicyServerConfigured()) {
      const policyServer = new PolicyServer()
      const response = await policyServer.checkEncryptFile(
        task.consumerAddress,
        task.policyServer,
        task.files
      )
      if (!response) {
        CORE_LOGGER.logMessage(
          `Error: EncryptFile for ${task.consumerAddress} was denied`,
          true
        )
        return {
          stream: null,
          status: {
            httpStatus: 403,
            error: `Error: EncryptFile for ${task.consumerAddress} was denied`
          }
        }
      }
    }

    try {
      const oceanNode = this.getOceanNode()
      const config = await getConfiguration()
      const headers = {
        'Content-Type': 'application/octet-stream',
        'X-Encrypted-By': oceanNode.getKeyManager().getPeerId().toString(),
        'X-Encrypted-Method': task.encryptionType
      }
      let encryptedContent: Readable
      if (task.files) {
        const storage = Storage.getStorageClass(task.files, config)
        const stream = await storage.getReadableStream()
        if (stream.stream) {
          encryptedContent = await oceanNode
            .getKeyManager()
            .encryptStream(stream.stream, task.encryptionType)
        } else {
          return {
            stream: null,
            status: { httpStatus: 500, error: 'Cannot fetch files' }
          }
        }
      } else if (task.rawData !== null) {
        const cont = await oceanNode
          .getKeyManager()
          .encrypt(task.rawData, task.encryptionType)
        encryptedContent = Readable.from(cont)
      }
      return {
        stream: encryptedContent,
        status: {
          httpStatus: 200,
          headers
        }
      }
    } catch (error) {
      CORE_LOGGER.error(`Error while encrypting file: ${error} `)
      return {
        stream: null,
        status: { httpStatus: 500, error: 'Unknown error: ' + error.message }
      }
    }
  }
}
