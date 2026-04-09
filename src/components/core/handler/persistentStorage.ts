import { Readable } from 'stream'
import type {
  PersistentStorageCreateBucketCommand,
  PersistentStorageDeleteFileCommand,
  PersistentStorageGetBucketsCommand,
  PersistentStorageGetFileObjectCommand,
  PersistentStorageListFilesCommand,
  PersistentStorageUploadFileCommand
} from '../../../@types/commands.js'
import {
  PersistentStorageAccessDeniedError,
  type PersistentStorageFactory
} from '../../persistentStorage/PersistentStorageFactory.js'
import type { P2PCommandResponse } from '../../../@types/OceanNode.js'
import { getAddress } from 'ethers'
import { checkAddressOnAccessList } from '../../../utils/accessList.js'

import { CORE_LOGGER } from '../../../utils/logging/common.js'
import {
  buildInvalidRequestMessage,
  validateCommandParameters,
  type ValidateParams
} from '../../httpRoutes/validateCommands.js'
import { CommandHandler } from './handler.js'

function requirePersistentStorage(handler: CommandHandler): PersistentStorageFactory {
  const node = handler.getOceanNode() as any
  if (!node.getPersistentStorage) {
    throw new Error('Persistent storage is not available on this node')
  }
  const storage = node.getPersistentStorage()
  if (!storage) {
    throw new Error('Persistent storage is not configured or disabled')
  }
  return storage
}

export class PersistentStorageCreateBucketHandler extends CommandHandler {
  validate(command: PersistentStorageCreateBucketCommand): ValidateParams {
    const base = validateCommandParameters(command, [
      'consumerAddress',
      'signature',
      'nonce',
      'accessLists'
    ])
    if (!base.valid) return base
    if (!Array.isArray(command.accessLists)) {
      return buildInvalidRequestMessage(
        'Invalid parameter: "accessLists" must be an array of objects'
      )
    }
    return { valid: true }
  }

  async handle(task: PersistentStorageCreateBucketCommand): Promise<P2PCommandResponse> {
    const validationResponse = await this.verifyParamsAndRateLimits(task)
    if (this.shouldDenyTaskHandling(validationResponse)) return validationResponse

    const isAuthRequestValid = await this.validateTokenOrSignature(
      task.authorization,
      task.consumerAddress,
      task.nonce,
      task.signature,
      task.command
    )
    if (isAuthRequestValid.status.httpStatus !== 200) return isAuthRequestValid

    try {
      const storage = requirePersistentStorage(this)
      const node = this.getOceanNode()
      const config = node.getConfig()
      const isAllowedCreate = await checkAddressOnAccessList(
        task.consumerAddress,
        config.persistentStorage?.accessLists,
        node
      )
      if (!isAllowedCreate) {
        return {
          stream: null,
          status: { httpStatus: 403, error: 'You are not allowed to create new buckets' }
        }
      }

      let ownerNormalized: string
      try {
        ownerNormalized = getAddress(task.consumerAddress)
      } catch {
        return {
          stream: null,
          status: { httpStatus: 400, error: 'Invalid parameter: "consumerAddress"' }
        }
      }

      const result = await storage.createNewBucket(task.accessLists, ownerNormalized)
      return {
        stream: Readable.from(JSON.stringify(result)),
        status: { httpStatus: 200, error: null }
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      CORE_LOGGER.error(`PersistentStorageCreateBucketHandler error: ${message}`)
      return { stream: null, status: { httpStatus: 500, error: message } }
    }
  }
}

export class PersistentStorageGetBucketsHandler extends CommandHandler {
  validate(command: PersistentStorageGetBucketsCommand): ValidateParams {
    const base = validateCommandParameters(command, [
      'consumerAddress',
      'signature',
      'nonce',
      'chainId',
      'owner'
    ])
    if (!base.valid) return base
    if (typeof command.chainId !== 'number') {
      return buildInvalidRequestMessage('Invalid parameter: "chainId" must be a number')
    }
    if (!command.owner || typeof command.owner !== 'string') {
      return buildInvalidRequestMessage(
        'Invalid parameter: "owner" must be a non-empty string'
      )
    }
    return { valid: true }
  }

  async handle(task: PersistentStorageGetBucketsCommand): Promise<P2PCommandResponse> {
    const validationResponse = await this.verifyParamsAndRateLimits(task)
    if (this.shouldDenyTaskHandling(validationResponse)) return validationResponse

    const isAuthRequestValid = await this.validateTokenOrSignature(
      task.authorization,
      task.consumerAddress,
      task.nonce,
      task.signature,
      task.command
    )
    if (isAuthRequestValid.status.httpStatus !== 200) return isAuthRequestValid

    let ownerNormalized: string
    // let consumerNormalized: string
    try {
      ownerNormalized = getAddress(task.owner)
      // consumerNormalized = getAddress(task.consumerAddress)
    } catch {
      return {
        stream: null,
        status: {
          httpStatus: 400,
          error: 'Invalid parameter: "owner" or "consumerAddress"'
        }
      }
    }

    try {
      const storage = requirePersistentStorage(this)
      // const node = this.getOceanNode()
      const rows = await storage.listBuckets(ownerNormalized)

      return {
        stream: Readable.from(JSON.stringify(rows)),
        status: { httpStatus: 200, error: null }
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      CORE_LOGGER.error(`PersistentStorageGetBucketsHandler error: ${message}`)
      return { stream: null, status: { httpStatus: 500, error: message } }
    }
  }
}

export class PersistentStorageListFilesHandler extends CommandHandler {
  validate(command: PersistentStorageListFilesCommand): ValidateParams {
    const base = validateCommandParameters(command, [
      'consumerAddress',
      'signature',
      'nonce',
      'bucketId'
    ])
    if (!base.valid) return base
    if (!command.bucketId || typeof command.bucketId !== 'string') {
      return buildInvalidRequestMessage('Invalid parameter: "bucketId" must be a string')
    }
    return { valid: true }
  }

  async handle(task: PersistentStorageListFilesCommand): Promise<P2PCommandResponse> {
    const validationResponse = await this.verifyParamsAndRateLimits(task)
    if (this.shouldDenyTaskHandling(validationResponse)) return validationResponse

    const isAuthRequestValid = await this.validateTokenOrSignature(
      task.authorization,
      task.consumerAddress,
      task.nonce,
      task.signature,
      task.command
    )
    if (isAuthRequestValid.status.httpStatus !== 200) return isAuthRequestValid

    try {
      const storage = requirePersistentStorage(this)
      const result = await storage.listFiles(task.bucketId, task.consumerAddress)
      return {
        stream: Readable.from(JSON.stringify(result)),
        status: { httpStatus: 200, error: null }
      }
    } catch (e) {
      if (e instanceof PersistentStorageAccessDeniedError) {
        return {
          stream: null,
          status: { httpStatus: 403, error: e.message }
        }
      }
      const message = e instanceof Error ? e.message : String(e)
      CORE_LOGGER.error(`PersistentStorageListFilesHandler error: ${message}`)
      return { stream: null, status: { httpStatus: 500, error: message } }
    }
  }
}

export class PersistentStorageGetFileObjectHandler extends CommandHandler {
  validate(command: PersistentStorageGetFileObjectCommand): ValidateParams {
    const base = validateCommandParameters(command, [
      'consumerAddress',
      'signature',
      'nonce',
      'bucketId',
      'fileName'
    ])
    if (!base.valid) return base
    return { valid: true }
  }

  async handle(task: PersistentStorageGetFileObjectCommand): Promise<P2PCommandResponse> {
    const validationResponse = await this.verifyParamsAndRateLimits(task)
    if (this.shouldDenyTaskHandling(validationResponse)) return validationResponse

    const isAuthRequestValid = await this.validateTokenOrSignature(
      task.authorization,
      task.consumerAddress,
      task.nonce,
      task.signature,
      task.command
    )
    if (isAuthRequestValid.status.httpStatus !== 200) return isAuthRequestValid

    try {
      const storage = requirePersistentStorage(this)
      const obj = await storage.getFileObject(
        task.bucketId,
        task.fileName,
        task.consumerAddress
      )
      return {
        stream: Readable.from(JSON.stringify(obj)),
        status: { httpStatus: 200, error: null }
      }
    } catch (e) {
      if (e instanceof PersistentStorageAccessDeniedError) {
        return {
          stream: null,
          status: { httpStatus: 403, error: e.message }
        }
      }
      const message = e instanceof Error ? e.message : String(e)
      if (message.toLowerCase().includes('file not found')) {
        return { stream: null, status: { httpStatus: 404, error: message } }
      }
      CORE_LOGGER.error(`PersistentStorageGetFileObjectHandler error: ${message}`)
      return { stream: null, status: { httpStatus: 500, error: message } }
    }
  }
}

export class PersistentStorageUploadFileHandler extends CommandHandler {
  validate(command: PersistentStorageUploadFileCommand): ValidateParams {
    const base = validateCommandParameters(command, [
      'consumerAddress',
      'signature',
      'nonce',
      'bucketId',
      'fileName'
    ])
    if (!base.valid) return base
    return { valid: true }
  }

  async handle(task: PersistentStorageUploadFileCommand): Promise<P2PCommandResponse> {
    const validationResponse = await this.verifyParamsAndRateLimits(task)
    if (this.shouldDenyTaskHandling(validationResponse)) return validationResponse

    const isAuthRequestValid = await this.validateTokenOrSignature(
      task.authorization,
      task.consumerAddress,
      task.nonce,
      task.signature,
      task.command
    )
    if (isAuthRequestValid.status.httpStatus !== 200) return isAuthRequestValid

    try {
      const storage = requirePersistentStorage(this)
      if (!task.stream) {
        return {
          stream: null,
          status: { httpStatus: 403, error: 'Upload stream error' }
        }
      }
      const result = await storage.uploadFile(
        task.bucketId,
        task.fileName,
        task.stream,
        task.consumerAddress
      )
      return {
        stream: Readable.from(JSON.stringify(result)),
        status: { httpStatus: 200, error: null }
      }
    } catch (e) {
      if (e instanceof PersistentStorageAccessDeniedError) {
        return {
          stream: null,
          status: { httpStatus: 403, error: e.message }
        }
      }
      const message = e instanceof Error ? e.message : String(e)
      CORE_LOGGER.error(`PersistentStorageUploadFileHandler error: ${message}`)
      return { stream: null, status: { httpStatus: 500, error: message } }
    }
  }
}

export class PersistentStorageDeleteFileHandler extends CommandHandler {
  validate(command: PersistentStorageDeleteFileCommand): ValidateParams {
    const base = validateCommandParameters(command, [
      'consumerAddress',
      'signature',
      'nonce',
      'chainId',
      'bucketId',
      'fileName'
    ])
    if (!base.valid) return base
    return { valid: true }
  }

  async handle(task: PersistentStorageDeleteFileCommand): Promise<P2PCommandResponse> {
    const validationResponse = await this.verifyParamsAndRateLimits(task)
    if (this.shouldDenyTaskHandling(validationResponse)) return validationResponse

    const isAuthRequestValid = await this.validateTokenOrSignature(
      task.authorization,
      task.consumerAddress,
      task.nonce,
      task.signature,
      task.command
    )
    if (isAuthRequestValid.status.httpStatus !== 200) return isAuthRequestValid

    try {
      const storage = requirePersistentStorage(this)
      await storage.deleteFile(task.bucketId, task.fileName, task.consumerAddress)
      return {
        stream: Readable.from(JSON.stringify({ success: true })),
        status: { httpStatus: 200, error: null }
      }
    } catch (e) {
      if (e instanceof PersistentStorageAccessDeniedError) {
        return {
          stream: null,
          status: { httpStatus: 403, error: e.message }
        }
      }
      const message = e instanceof Error ? e.message : String(e)
      CORE_LOGGER.error(`PersistentStorageDeleteFileHandler error: ${message}`)
      return { stream: null, status: { httpStatus: 500, error: message } }
    }
  }
}
