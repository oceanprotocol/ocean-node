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
import { findAndFormatDdo } from './ddoHandler.js'
import { calculateFee, checkFee } from './feesHandler.js'
import { decrypt } from '../../utils/crypt.js'
import { ArweaveStorage, IpfsStorage, Storage } from '../../components/storage/index.js'
import { existsEnvironmentVariable } from '../../utils/index.js'
export const FILE_ENCRYPTION_ALGORITHM = 'aes-256-cbc'

export async function handleDownload(
  task: DownloadTask,
  node: OceanP2P
): Promise<P2PCommandResponse> {
  // 1. Get the DDO
  const ddo = await findAndFormatDdo(node, task.documentId)

  if (ddo) {
    P2P_CONSOLE_LOGGER.logMessage('DDO for asset found: ' + ddo, true)
  } else {
    P2P_CONSOLE_LOGGER.logMessage(
      'No DDO for asset found. Cannot proceed with download.',
      true
    )
    throw new Error('No DDO found for asset')
  }

  // 2. Validate nonce and signature
  const nonceCheckResult: NonceResponse = await checkNonce(
    node,
    task.consumerAddress,
    parseInt(task.nonce),
    task.signature
  )

  if (!nonceCheckResult.valid) {
    P2P_CONSOLE_LOGGER.logMessage(
      'Invalid nonce or signature, unable to proceed with download: ' +
        nonceCheckResult.error,
      true
    )
    throw new Error(nonceCheckResult.error)
  }

  // 4. check that the provider fee transaction is valid
  let feeValidation
  try {
    feeValidation = await checkFee(task.feeTx, task.feeData)
  } catch (e) {
    throw new Error('ERROR checking fees')
  }
  if (feeValidation) {
    // Log the provider fee response for debugging purposes
    P2P_CONSOLE_LOGGER.logMessage(`Valid provider fee transaction`, true)
  } else {
    throw new Error('Invalid provider fee transaction')
  }

  // 5. Call the validateOrderTransaction function to check order transaction
  const config = node.getConfig()
  const { rpc } = config.supportedNetworks[ddo.chainId]

  let provider
  try {
    provider = new JsonRpcProvider(rpc)
  } catch (e) {
    throw new Error('JsonRpcProvider ERROR')
  }

  const paymentValidation = await validateOrderTransaction(
    task.transferTxId,
    task.consumerAddress,
    provider,
    ddo.nftAddress,
    ddo.services[task.serviceIndex].datatokenAddress,
    task.serviceIndex,
    ddo.services[task.serviceIndex].timeout
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
    throw new Error(paymentValidation.message)
  }

  try {
    // 6. Decrypt the url
    const encryptedFilesString = ddo.services[task.serviceIndex].files
    const encryptedFilesBuffer = Buffer.from(encryptedFilesString, 'base64')

    // Ensure that encryptedFilesBuffer is of type Buffer
    if (!Buffer.isBuffer(encryptedFilesBuffer)) {
      throw new Error('Encrypted data is not a Buffer')
    }

    // Call the decrypt function with the appropriate algorithm
    const decryptedUrlBytes = await decrypt(encryptedFilesBuffer, 'ECIES')

    // Convert the decrypted bytes back to a string
    const decryptedFilesString = Buffer.from(decryptedUrlBytes).toString()
    const decryptedFileObject = JSON.parse(decryptedFilesString)

    // 7. Proceed to download the file
    return await handleDownloadURLCommand(node, {
      command: PROTOCOL_COMMANDS.DOWNLOAD_URL,
      fileObject: decryptedFileObject,
      aes_encrypted_key: task.aes_encrypted_key
    })
  } catch (e) {
    P2P_CONSOLE_LOGGER.logMessage('decryption error' + e, true)
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

      return {
        stream: inputStream.pipe(cipher),
        status: {
          httpStatus: 200,
          headers: {
            'Content-Disposition': "attachment; filename='syslog'", // TODO: the filename must come from somewhere else?
            'Content-Type': 'application/octet-stream',
            'Content-Encoding': 'aesgcm',
            'Transfer-Encoding': 'chunked'
          }
        }
      }
    } else {
      // Download request is not using encryption!
      return {
        stream: inputStream,
        status: {
          httpStatus: 200,
          headers: {
            'Content-Disposition': "attachment; filename='syslog'",
            'Content-Type': 'application/octet-stream',
            'Transfer-Encoding': 'chunked'
          }
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
