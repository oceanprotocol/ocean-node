import { JsonRpcProvider } from 'ethers'
import { Handler } from './handler.js'
import { checkNonce, NonceResponse } from '../utils/nonceHandler.js'
import { ENVIRONMENT_VARIABLES, PROTOCOL_COMMANDS } from '../../../utils/constants.js'
import { P2PCommandResponse } from '../../../@types/OceanNode.js'
import { verifyProviderFees } from '../utils/feesHandler.js'
import { decrypt } from '../../../utils/crypt.js'
import { FindDdoHandler } from './ddoHandler.js'
import crypto from 'crypto'
import * as ethCrypto from 'eth-crypto'
import { GENERIC_EMOJIS, LOG_LEVELS_STR } from '../../../utils/logging/Logger.js'
import { validateOrderTransaction } from '../utils/validateOrders.js'
import { AssetUtils } from '../../../utils/asset.js'
import { Service } from '../../../@types/DDO/Service.js'
import { ArweaveStorage, IpfsStorage, Storage } from '../../storage/index.js'
import { existsEnvironmentVariable, getConfiguration } from '../../../utils/index.js'
import { checkCredentials } from '../../../utils/credentials.js'
import { CORE_LOGGER } from '../../../utils/logging/common.js'
import { OceanNode } from '../../../OceanNode.js'
import { DownloadCommand, DownloadURLCommand } from '../../../@types/commands.js'
import { EncryptMethod } from '../../../@types/fileObject.js'
import { C2DEngine } from '../../c2d/compute_engines.js'
import {
  buildInvalidParametersResponse,
  buildRateLimitReachedResponse,
  validateCommandParameters,
  ValidateParams
} from '../../httpRoutes/validateCommands.js'
import { DDO } from '../../../@types/DDO/DDO.js'
export const FILE_ENCRYPTION_ALGORITHM = 'aes-256-cbc'

export async function handleDownloadUrlCommand(
  node: OceanNode,
  task: DownloadURLCommand
): Promise<P2PCommandResponse> {
  const encryptFile = !!task.aes_encrypted_key
  CORE_LOGGER.logMessage('DownloadCommand requires file encryption? ' + encryptFile, true)

  try {
    // Determine the type of storage and get a readable stream
    const storage = Storage.getStorageClass(task.fileObject)
    if (
      storage instanceof ArweaveStorage &&
      !existsEnvironmentVariable(ENVIRONMENT_VARIABLES.ARWEAVE_GATEWAY)
    ) {
      CORE_LOGGER.logMessageWithEmoji(
        'Failure executing downloadURL task: Oean-node does not support arweave storage type files! ',
        true,
        GENERIC_EMOJIS.EMOJI_CROSS_MARK,
        LOG_LEVELS_STR.LEVEL_ERROR
      )
      return {
        stream: null,
        status: {
          httpStatus: 501,
          error: 'Error: Oean-node does not support arweave storage type files!'
        }
      }
    } else if (
      storage instanceof IpfsStorage &&
      !existsEnvironmentVariable(ENVIRONMENT_VARIABLES.IPFS_GATEWAY)
    ) {
      CORE_LOGGER.logMessageWithEmoji(
        'Failure executing downloadURL task: Oean-node does not support ipfs storage type files! ',
        true,
        GENERIC_EMOJIS.EMOJI_CROSS_MARK,
        LOG_LEVELS_STR.LEVEL_ERROR
      )
      return {
        stream: null,
        status: {
          httpStatus: 501,
          error: 'Error: Oean-node does not support ipfs storage type files!'
        }
      }
    }
    const inputStream = await storage.getReadableStream()
    const headers: any = {}
    for (const [key, value] of Object.entries(inputStream.headers)) {
      headers[key] = value
    }
    // need to check if content length is already in headers, but we don't know the case
    const objTemp = JSON.parse(JSON.stringify(headers).toLowerCase())
    if (!('Content-Length'.toLowerCase() in objTemp))
      headers['Transfer-Encoding'] = 'chunked'
    if (!('Content-Disposition'.toLowerCase() in objTemp))
      headers['Content-Disposition'] = 'attachment;filename=unknownfile' // TO DO: use did+serviceId+fileIndex
    if (encryptFile) {
      // we parse the string into the object again
      const encryptedObject = ethCrypto.cipher.parse(task.aes_encrypted_key)
      // get the key from configuration
      const config = await getConfiguration()
      const nodePrivateKey = Buffer.from(config.keys.privateKey).toString('hex')
      const decrypted = await ethCrypto.decryptWithPrivateKey(
        nodePrivateKey,
        encryptedObject
      )
      const decryptedPayload = JSON.parse(decrypted)
      // check signature
      // const senderAddress = ethCrypto.recover(
      //  decryptedPayload.signature,
      //  ethCrypto.hash.keccak256(decryptedPayload.message)
      // )
      // Optional, we can also validate the original address of the sender (the client that created the message)
      // this could be part of the /directCommand payload for instance
      // console.log(
      //  'Got message from ' + senderAddress + ' secrets: ' + decryptedPayload.message
      // )
      const secrets = JSON.parse(decryptedPayload.message)

      const cipher = crypto
        .createCipheriv(
          FILE_ENCRYPTION_ALGORITHM,
          Buffer.from(secrets.key, 'hex'),
          Buffer.from(secrets.iv, 'hex')
        )
        .setAutoPadding(true)

      headers['Content-Encoding'] = 'aesgcm'

      return {
        stream: inputStream.stream.pipe(cipher),
        status: {
          httpStatus: inputStream.httpStatus,
          headers
        }
      }
    } else {
      // Download request is not using encryption!
      return {
        stream: inputStream.stream,
        status: {
          httpStatus: inputStream.httpStatus,
          headers
        }
      }
    }
  } catch (err) {
    CORE_LOGGER.logMessageWithEmoji(
      'Failure executing downloadURL task: ' + err.message,
      true,
      GENERIC_EMOJIS.EMOJI_CROSS_MARK,
      LOG_LEVELS_STR.LEVEL_ERROR
    )
    return {
      stream: null,
      status: { httpStatus: 501, error: 'Unknown error: ' + err.message }
    }
  }
}

export function validateFilesStructure(
  ddo: DDO,
  service: Service,
  decriptedFileObject: any
): boolean {
  if (
    decriptedFileObject.nftAddress !== ddo.nftAddress ||
    decriptedFileObject.datatokenAddress !== service.datatokenAddress
  ) {
    return false
  }
  return true
}

export class DownloadHandler extends Handler {
  validate(command: DownloadCommand): ValidateParams {
    return validateCommandParameters(command, [
      'fileIndex',
      'documentId',
      'serviceId',
      'transferTxId',
      'nonce',
      'consumerAddress',
      'signature'
    ])
  }
  // No encryption here yet

  async handle(task: DownloadCommand): Promise<P2PCommandResponse> {
    if (!(await this.checkRateLimit())) {
      return buildRateLimitReachedResponse()
    }
    const validation = this.validate(task)
    if (!validation.valid) {
      return buildInvalidParametersResponse(validation)
    }
    const node = this.getOceanNode()
    // 1. Get the DDO
    const handler: FindDdoHandler = node
      .getCoreHandlers()
      .getHandler(PROTOCOL_COMMANDS.FIND_DDO) as FindDdoHandler
    const ddo = await handler.findAndFormatDdo(task.documentId)

    if (ddo) {
      CORE_LOGGER.logMessage('DDO for asset found: ' + ddo, true)
    } else {
      CORE_LOGGER.logMessage(
        'No DDO for asset found. Cannot proceed with download.',
        true
      )
      return {
        stream: null,
        status: {
          httpStatus: 500,
          error: 'No DDO found for asset'
        }
      }
    }

    // 2. Validate ddo and credentials
    if (!ddo.chainId || !ddo.nftAddress || !ddo.metadata) {
      CORE_LOGGER.logMessage('Error: DDO malformed or disabled', true)
      return {
        stream: null,
        status: {
          httpStatus: 500,
          error: 'Error: DDO malformed or disabled'
        }
      }
    }

    // check credentials
    if (ddo.credentials) {
      const accessGranted = checkCredentials(ddo.credentials, task.consumerAddress)
      if (!accessGranted) {
        CORE_LOGGER.logMessage(`Error: Access to asset ${ddo.id} was denied`, true)
        return {
          stream: null,
          status: {
            httpStatus: 500,
            error: `Error: Access to asset ${ddo.id} was denied`
          }
        }
      }
    }

    // 3. Validate nonce and signature
    const nonceCheckResult: NonceResponse = await checkNonce(
      this.getOceanNode().getDatabase().nonce,
      task.consumerAddress,
      parseInt(task.nonce),
      task.signature,
      ddo.id
    )

    if (!nonceCheckResult.valid) {
      CORE_LOGGER.logMessage(
        'Invalid nonce or signature, unable to proceed with download: ' +
          nonceCheckResult.error,
        true
      )
      return {
        stream: null,
        status: {
          httpStatus: 500,
          error: nonceCheckResult.error
        }
      }
    }
    // from now on, we need blockchain checks
    const config = await getConfiguration()
    const { rpc } = config.supportedNetworks[ddo.chainId]
    let provider
    try {
      provider = new JsonRpcProvider(rpc)
    } catch (e) {
      return {
        stream: null,
        status: {
          httpStatus: 500,
          error: 'JsonRpcProvider ERROR'
        }
      }
    }
    if (!rpc) {
      CORE_LOGGER.logMessage(
        `Cannot proceed with download. RPC not configured for this chain ${ddo.chainId}`,
        true
      )
      return {
        stream: null,
        status: {
          httpStatus: 500,
          error: `Cannot proceed with download. RPC not configured for this chain ${ddo.chainId}`
        }
      }
    }
    let service: Service = AssetUtils.getServiceById(ddo, task.serviceId)
    if (!service) service = AssetUtils.getServiceByIndex(ddo, Number(task.serviceId))
    if (!service) throw new Error('Cannot find service')
    // 4. Check service type
    const serviceType = service.type
    if (serviceType === 'compute') {
      // only compute envs are allowed to download compute assets
      // get all compute envs
      const computeAddrs: string[] = []
      const config = await getConfiguration()
      const { c2dClusters } = config

      for (const cluster of c2dClusters) {
        const engine = C2DEngine.getC2DClass(cluster)
        const environments = await engine.getComputeEnvironments(ddo.chainId)
        for (const env of environments)
          computeAddrs.push(env.consumerAddress.toLowerCase())
      }
      //
      if (!computeAddrs.includes(task.consumerAddress.toLowerCase())) {
        const msg = 'Not allowed to download this asset of type compute'
        CORE_LOGGER.logMessage(msg)
        return {
          stream: null,
          status: {
            httpStatus: 500,
            error: msg
          }
        }
      }
    }
    // 5. check that the provider fee transaction is valid
    const validFee = await verifyProviderFees(
      task.transferTxId,
      task.consumerAddress,
      provider,
      service,
      null,
      null
    )
    if (!validFee.isValid) {
      return {
        stream: null,
        status: {
          httpStatus: 500,
          error: 'ERROR checking fees'
        }
      }
    }
    // 6. Call the validateOrderTransaction function to check order transaction
    const paymentValidation = await validateOrderTransaction(
      task.transferTxId,
      task.consumerAddress,
      provider,
      ddo.nftAddress,
      service.datatokenAddress,
      AssetUtils.getServiceIndexById(ddo, task.serviceId),
      service.timeout
    )
    if (paymentValidation.isValid) {
      CORE_LOGGER.logMessage(
        `Valid payment transaction. Result: ${paymentValidation.message}`,
        true
      )
    } else {
      CORE_LOGGER.logMessage(
        `Invalid payment transaction: ${paymentValidation.message}`,
        true
      )
      return {
        stream: null,
        status: {
          httpStatus: 500,
          error: paymentValidation.message
        }
      }
    }

    try {
      // 6. Decrypt the url
      const decryptedUrlBytes = await decrypt(
        Uint8Array.from(Buffer.from(service.files, 'hex')),
        EncryptMethod.ECIES
      )
      // Convert the decrypted bytes back to a string
      const decryptedFilesString = Buffer.from(decryptedUrlBytes).toString()
      const decryptedFileData = JSON.parse(decryptedFilesString)
      const decriptedFileObject: any = decryptedFileData.files[task.fileIndex]
      if (!validateFilesStructure(ddo, service, decryptedFileData)) {
        CORE_LOGGER.error(
          'Unauthorized download operation. Decrypted "nftAddress" and "datatokenAddress" do not match the original DDO'
        )
        return {
          stream: null,
          status: {
            httpStatus: 403,
            error: 'Failed to download asset, unauthorized operation!'
          }
        }
      }

      // 7. Proceed to download the file
      return await handleDownloadUrlCommand(node, {
        fileObject: decriptedFileObject,
        aes_encrypted_key: task.aes_encrypted_key,
        command: PROTOCOL_COMMANDS.DOWNLOAD_URL
      })
    } catch (e) {
      CORE_LOGGER.logMessage('decryption error' + e, true)
      return {
        stream: null,
        status: {
          httpStatus: 500,
          error: 'Failed to decrypt'
        }
      }
    }
  }
}
