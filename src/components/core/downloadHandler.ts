import crypto from 'crypto'
import { JsonRpcProvider } from 'ethers'
import {
  DownloadTask,
  DownloadURLCommand,
  ENVIRONMENT_VARIABLES,
  PROTOCOL_COMMANDS
} from '../../utils/constants.js'
import { P2PCommandResponse } from '../../@types/OceanNode.js'
import { OceanP2P, P2P_CONSOLE_LOGGER } from '../P2P/index.js'
import * as ethCrypto from 'eth-crypto'
import { GENERIC_EMOJIS, LOG_LEVELS_STR } from '../../utils/logging/Logger.js'
import { validateOrderTransaction } from './validateTransaction.js'
import { checkNonce, NonceResponse } from './nonceHandler.js'
import { AssetUtils } from '../../utils/asset.js'
import { Service } from '../../@types/DDO/Service'
import { findAndFormatDdo } from './ddoHandler.js'
import { checkFee } from './feesHandler.js'
import { decrypt } from '../../utils/crypt.js'
import { ArweaveStorage, IpfsStorage, Storage } from '../../components/storage/index.js'
import { existsEnvironmentVariable } from '../../utils/index.js'
import { checkCredentials } from '../../utils/credentials.js'
export const FILE_ENCRYPTION_ALGORITHM = 'aes-256-cbc'

export async function handleDownload(
  task: DownloadTask,
  node: OceanP2P
): Promise<P2PCommandResponse> {
  P2P_CONSOLE_LOGGER.logMessage(
    'Download Request recieved with arguments: ' +
      task.fileIndex +
      task.documentId +
      task.serviceId +
      task.transferTxId +
      task.nonce +
      task.consumerAddress +
      task.signature,
    true
  )
  // 1. Get the DDO
  const ddo = await findAndFormatDdo(node, task.documentId)

  if (ddo) {
    P2P_CONSOLE_LOGGER.logMessage('DDO for asset found: ' + ddo, true)
  } else {
    P2P_CONSOLE_LOGGER.logMessage(
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
    P2P_CONSOLE_LOGGER.logMessage('Error: DDO malformed or disabled', true)
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
      P2P_CONSOLE_LOGGER.logMessage(`Error: Access to asset ${ddo.id} was denied`, true)
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
    node,
    task.consumerAddress,
    parseInt(task.nonce),
    task.signature,
    ddo.id
  )

  if (!nonceCheckResult.valid) {
    P2P_CONSOLE_LOGGER.logMessage(
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

  // 4. check that the provider fee transaction is valid
  if (task.feeTx && task.feeData) {
    let feeValidation
    try {
      feeValidation = await checkFee(task.feeTx, task.feeData)
    } catch (e) {
      return {
        stream: null,
        status: {
          httpStatus: 500,
          error: 'ERROR checking fees'
        }
      }
    }
    if (feeValidation) {
      // Log the provider fee response for debugging purposes
      P2P_CONSOLE_LOGGER.logMessage(`Valid provider fee transaction`, true)
    } else {
      return {
        stream: null,
        status: {
          httpStatus: 500,
          error: 'Invalid provider fee transaction'
        }
      }
    }
  }

  // 5. Call the validateOrderTransaction function to check order transaction
  const config = node.getConfig()
  const { rpc } = config.supportedNetworks[ddo.chainId]

  if (!rpc) {
    P2P_CONSOLE_LOGGER.logMessage(
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

  let service: Service = AssetUtils.getServiceById(ddo, task.serviceId)
  if (!service) service = AssetUtils.getServiceByIndex(ddo, Number(task.serviceId))
  if (!service) throw new Error('Cannot find service')
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
    P2P_CONSOLE_LOGGER.logMessage(
      `Valid payment transaction. Result: ${paymentValidation.message}`,
      true
    )
  } else {
    P2P_CONSOLE_LOGGER.logMessage(
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
      'ECIES'
    )
    // Convert the decrypted bytes back to a string
    const decryptedFilesString = Buffer.from(decryptedUrlBytes).toString()
    const decryptedFileArray = JSON.parse(decryptedFilesString)
    // 7. Proceed to download the file
    return await handleDownloadURLCommand(node, {
      command: PROTOCOL_COMMANDS.DOWNLOAD_URL,
      fileObject: decryptedFileArray.files[task.fileIndex],
      aes_encrypted_key: task.aes_encrypted_key
    })
  } catch (e) {
    P2P_CONSOLE_LOGGER.logMessage('decryption error' + e, true)
    return {
      stream: null,
      status: {
        httpStatus: 500,
        error: 'Failed to decrypt'
      }
    }
  }
}

// No encryption here yet
export async function handleDownloadURLCommand(
  node: OceanP2P,
  task: DownloadURLCommand
): Promise<P2PCommandResponse> {
  const encryptFile = !!task.aes_encrypted_key
  P2P_CONSOLE_LOGGER.logMessage(
    'DownloadCommand requires file encryption? ' + encryptFile,
    true
  )

  try {
    // Determine the type of storage and get a readable stream
    const storage = Storage.getStorageClass(task.fileObject)
    if (
      storage instanceof ArweaveStorage &&
      !existsEnvironmentVariable(ENVIRONMENT_VARIABLES.ARWEAVE_GATEWAY)
    ) {
      P2P_CONSOLE_LOGGER.logMessageWithEmoji(
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
      P2P_CONSOLE_LOGGER.logMessageWithEmoji(
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
      const nodePrivateKey = Buffer.from(node.getConfig().keys.privateKey).toString('hex')
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
    P2P_CONSOLE_LOGGER.logMessageWithEmoji(
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
