import { JsonRpcProvider } from 'ethers'
import { DownloadTask, PROTOCOL_COMMANDS } from '../../../utils/constants.js'
import { Handler } from './handler.js'
import { OceanNodeConfig, P2PCommandResponse } from '../../../@types/OceanNode.js'
import { P2P_CONSOLE_LOGGER } from '../../P2P/index.js'
import { validateOrderTransaction } from '../validateTransaction.js'
import { checkNonce, NonceResponse } from './nonceHandler.js'
import { AssetUtils } from '../../../utils/asset.js'
import { Service } from '../../../@types/DDO/Service.js'
import { findAndFormatDdo } from './ddoHandler.js'
import { checkFee } from './feesHandler.js'
import { decrypt } from '../../../utils/crypt.js'
import { Database } from '../../database/index.js'
import { DownloadUrlHandler } from './downloadUrlHandler.js'
export const FILE_ENCRYPTION_ALGORITHM = 'aes-256-cbc'

export class DownloadHandler extends Handler {
  public constructor(task: any, config: OceanNodeConfig, db: Database) {
    super(task, config, db)
    if (!this.isDownloadCommand(task)) {
      throw new Error(`Task has not DownloadCommand type. It has ${typeof task}`)
    }
  }

  isDownloadCommand(obj: any): obj is DownloadTask {
    return (
      typeof obj === 'object' &&
      obj !== null &&
      'fileIndex' in obj &&
      'documentId' in obj &&
      'serviceId' in obj &&
      'transferTxId' in obj &&
      'nonce' in obj &&
      'consumerAddress' in obj &&
      'signature' in obj
    )
  }

  async handle(): Promise<P2PCommandResponse> {
    const task = this.getTask()
    const node = this.getP2PNode()
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
          httpStatus: 500
        },
        error: 'No DDO found for asset'
      }
    }

    // 2. Validate nonce and signature
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
          httpStatus: 500
        },
        error: nonceCheckResult.error
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
            httpStatus: 500
          },
          error: 'ERROR checking fees'
        }
      }
      if (feeValidation) {
        // Log the provider fee response for debugging purposes
        P2P_CONSOLE_LOGGER.logMessage(`Valid provider fee transaction`, true)
      } else {
        return {
          stream: null,
          status: {
            httpStatus: 500
          },
          error: 'Invalid provider fee transaction'
        }
      }
    }

    // 5. Call the validateOrderTransaction function to check order transaction
    const config = node.getConfig()
    const { rpc } = config.supportedNetworks[ddo.chainId]

    let provider
    try {
      provider = new JsonRpcProvider(rpc)
    } catch (e) {
      return {
        stream: null,
        status: {
          httpStatus: 500
        },
        error: 'JsonRpcProvider ERROR'
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
          httpStatus: 500
        },
        error: paymentValidation.message
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
      const downloadHandler = new DownloadUrlHandler(
        {
          command: PROTOCOL_COMMANDS.DOWNLOAD_URL,
          fileObject: decryptedFileArray.files[task.fileIndex],
          aes_encrypted_key: task.aes_encrypted_key
        },
        config
      )
      return await downloadHandler.handle()
    } catch (e) {
      P2P_CONSOLE_LOGGER.logMessage('decryption error' + e, true)
      return {
        stream: null,
        status: {
          httpStatus: 500
        },
        error: 'Failed to decrypt'
      }
    }
  }
}
