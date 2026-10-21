import { CommandHandler } from './handler.js'
import { MetadataStates, PROTOCOL_COMMANDS } from '../../../utils/constants.js'
import { P2PCommandResponse } from '../../../@types/OceanNode.js'
import { ProviderFees } from '../utils/feesHandler.js'
import { FindDdoHandler } from './ddoHandler.js'
import crypto from 'crypto'
import { validateOrderTransaction } from '../utils/validateOrders.js'
import {
  AssetUtils,
  getFilesObjectFromConfidentialEVM,
  isConfidentialChainDDO,
  isDataTokenTemplate4,
  isERC20Template4Active
} from '../../../utils/asset.js'
import { Storage } from '../../storage/index.js'
import { isPolicyServerConfigured } from '../../../utils/index.js'
import { checkCredentials } from '../../../utils/credentials.js'
import { CORE_LOGGER } from '../../../utils/logging/common.js'
import { errorSummary, redactUrls } from '../../../utils/logging/redact.js'
import { OceanNode } from '../../../OceanNode.js'
import { DownloadCommand, DownloadURLCommand } from '../../../@types/commands.js'
import { EncryptMethod, isPersistentStorageType } from '../../../@types/fileObject.js'

import {
  validateCommandParameters,
  ValidateParams
} from '../../httpRoutes/validateCommands.js'
import { sanitizeServiceFiles } from '../../../utils/util.js'
import { OrdableAssetResponse } from '../../../@types/Asset.js'
import { PolicyServer } from '../../policyServer/index.js'
import { Asset, Credentials, DDO, DDOManager, Service } from '@oceanprotocol/ddo-js'
export const FILE_ENCRYPTION_ALGORITHM = 'aes-256-cbc'

export function isOrderingAllowedForAsset(asset: Asset): OrdableAssetResponse {
  if (!asset) {
    return {
      isOrdable: false,
      reason: `Asset provided is either null, either undefined ${asset}`
    }
  } else if (
    !asset.indexedMetadata?.nft ||
    ![MetadataStates.ACTIVE, MetadataStates.UNLISTED].includes(
      asset.indexedMetadata.nft.state
    )
  ) {
    return {
      isOrdable: false,
      reason:
        'Nft not present in the asset or the state is different than ACTIVE or UNLISTED.'
    }
  }

  return {
    isOrdable: true,
    reason: ''
  }
}

export async function handleDownloadUrlCommand(
  node: OceanNode,
  task: DownloadURLCommand
): Promise<P2PCommandResponse> {
  const encryptFile = !!task.aes_encrypted_key
  CORE_LOGGER.debug('DownloadCommand requires file encryption? ' + encryptFile)
  const config = node.getConfig()
  try {
    // Persistent-storage files are only available within compute jobs, never via download.
    if (isPersistentStorageType((task.fileObject as { type?: string })?.type)) {
      return {
        stream: null,
        status: {
          httpStatus: 403,
          error:
            'Persistent storage files cannot be downloaded; they are only available within compute jobs'
        }
      }
    }
    // Determine the type of storage and get a readable stream
    const storage = Storage.getStorageClass(task.fileObject, config)

    // Validate storage configuration (checks if gateways are configured)
    const [isValid, validationError] = storage.validate()
    if (!isValid) {
      CORE_LOGGER.debug(
        `Failure executing downloadURL task: ${redactUrls(String(validationError))}`
      )
      return {
        stream: null,
        status: {
          httpStatus: 501,
          error: `Error: ${validationError}`
        }
      }
    }
    const fileMetadata = await storage.fetchSpecificFileMetadata(task.fileObject, true)
    const inputStream = await storage.getReadableStream()
    const headers: any = {}
    for (const [key, value] of Object.entries(inputStream.headers)) {
      headers[key] = value
    }
    // need to check if content length is already in headers, but we don't know the case
    const objTemp = JSON.parse(JSON.stringify(headers)?.toLowerCase())
    if (!('Content-Length'?.toLowerCase() in objTemp))
      headers['Transfer-Encoding'] = 'chunked'
    // ensure that the right content length is set in the headers
    headers['Content-Length'.toLowerCase()] = fileMetadata.contentLength

    if (!('Content-Disposition'?.toLowerCase() in objTemp))
      headers['Content-Disposition'.toLowerCase()] =
        `attachment;filename=${fileMetadata.name}`
    if (encryptFile) {
      // we parse the string into the object again

      const decrypted = await node
        .getKeyManager()
        .ethCryptoDecryptWithPrivateKey(task.aes_encrypted_key)
      const decryptedPayload = JSON.parse(decrypted)
      // check signature
      // const senderAddress = ethCrypto.recover(
      //  decryptedPayload.signature,
      //  ethCrypto.hash.keccak256(decryptedPayload.message)
      // )
      // Optional, we can also validate the original address of the sender (the client that created the message)
      // this could be part of the /directCommand payload for instance
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
    // errorSummary: storage errors carry the decrypted file URL
    CORE_LOGGER.warn(
      `Download failed (storage=${(task.fileObject as { type?: string })?.type}): ${errorSummary(err)}`
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
    decriptedFileObject.nftAddress?.toLowerCase() !== ddo.nftAddress?.toLowerCase() ||
    decriptedFileObject.datatokenAddress?.toLowerCase() !==
      service.datatokenAddress?.toLowerCase()
  ) {
    return false
  }
  return true
}

export class DownloadHandler extends CommandHandler {
  validate(command: DownloadCommand): ValidateParams {
    return validateCommandParameters(command, [
      'fileIndex',
      'documentId',
      'serviceId',
      'transferTxId'
    ])
  }
  // No encryption here yet

  async handle(task: DownloadCommand): Promise<P2PCommandResponse> {
    const validationResponse = await this.verifyParamsAndRateLimits(task)
    if (this.shouldDenyTaskHandling(validationResponse)) {
      return validationResponse
    }
    const isAuthRequestValid = await this.validateTokenOrSignature(
      task.authorization,
      task.consumerAddress,
      task.nonce,
      task.signature,
      task.command
    )
    if (isAuthRequestValid.status.httpStatus !== 200) {
      return isAuthRequestValid
    }

    const node = this.getOceanNode()
    // 1. Get the DDO
    const handler: FindDdoHandler = node
      .getCoreHandlers()
      .getHandler(PROTOCOL_COMMANDS.FIND_DDO) as FindDdoHandler
    const ddo = await handler.findAndFormatDdo(task.documentId)

    if (ddo) {
      CORE_LOGGER.debug(`DDO found for asset ${ddo.id}`)
    } else {
      CORE_LOGGER.debug(
        `No DDO found for asset ${task.documentId}. Cannot proceed with download.`
      )
      return {
        stream: null,
        status: {
          httpStatus: 500,
          error: 'No DDO found for asset'
        }
      }
    }
    const ddoInstance = DDOManager.getDDOClass(ddo)
    const {
      chainId: ddoChainId,
      nftAddress,
      metadata,
      credentials
    } = ddoInstance.getDDOFields()
    const policyServer = new PolicyServer()

    const isOrdable = isOrderingAllowedForAsset(ddo)
    if (!isOrdable.isOrdable) {
      CORE_LOGGER.debug(`Download ${ddo.id}: ${isOrdable.reason}`)
      return {
        stream: null,
        status: {
          httpStatus: 500,
          error: isOrdable.reason
        }
      }
    }

    // 2. Validate ddo and credentials
    if (!ddoChainId || !nftAddress || !metadata) {
      CORE_LOGGER.debug(`Error: DDO ${ddo.id} malformed or disabled`)
      return {
        stream: null,
        status: {
          httpStatus: 500,
          error: 'Error: DDO malformed or disabled'
        }
      }
    }

    // Initialize blockchain early (needed for credential checks with accessList)
    const config = node.getConfig()
    const { chainId } = config.supportedNetworks[ddoChainId]
    let provider
    let blockchain
    let oceanNode: OceanNode
    try {
      oceanNode = this.getOceanNode()
      blockchain = oceanNode.getBlockchain(chainId)
      if (!blockchain) {
        return {
          stream: null,
          status: {
            httpStatus: 400,
            error: `Download handler: Blockchain instance not available for chain ${chainId}`
          }
        }
      }
      const { ready, error } = await blockchain.isNetworkReady()
      if (!ready) {
        return {
          stream: null,
          status: {
            httpStatus: 400,
            error: `Download handler: ${error}`
          }
        }
      }
      provider = await blockchain.getProvider()
    } catch (e) {
      CORE_LOGGER.error(`Download: RPC error on chain ${chainId}: ${errorSummary(e)}`)
      return {
        stream: null,
        status: {
          httpStatus: 500,
          error: 'JsonRpcProvider ERROR'
        }
      }
    }

    // check credentials (DDO level)
    let accessGrantedDDOLevel: boolean
    if (credentials) {
      // if POLICY_SERVER_URL exists, then ocean-node will NOT perform any checks.
      // It will just use the existing code and let PolicyServer decide.
      if (isPolicyServerConfigured()) {
        const response = await policyServer.checkDownload(
          ddoInstance.getDid(),
          ddo,
          task.serviceId,
          task.consumerAddress,
          task.policyServer
        )
        accessGrantedDDOLevel = response.success
      } else {
        accessGrantedDDOLevel = await checkCredentials(
          task.consumerAddress,
          credentials as Credentials,
          await blockchain.getSigner()
        )
      }
      if (!accessGrantedDDOLevel) {
        CORE_LOGGER.debug(`Error: Access to asset ${ddoInstance.getDid()} was denied`)
        return {
          stream: null,
          status: {
            httpStatus: 403,
            error: `Error: Access to asset ${ddoInstance.getDid()} was denied`
          }
        }
      }
    }

    let service = AssetUtils.getServiceById(ddo, task.serviceId)
    if (!service) service = AssetUtils.getServiceByIndex(ddo, Number(task.serviceId))
    if (!service) throw new Error('Cannot find service')

    // check credentials on service level
    // if using a policy server and we are here it means that access was granted (they are merged/assessed together)
    if (service.credentials) {
      let accessGrantedServiceLevel: boolean
      if (isPolicyServerConfigured()) {
        // we use the previous check or we do it again
        // (in case there is no DDO level credentials and we only have Service level ones)
        const response = await policyServer.checkDownload(
          ddoInstance.getDid(),
          ddo,
          service.id,
          task.consumerAddress,
          task.policyServer
        )
        accessGrantedServiceLevel = accessGrantedDDOLevel || response.success
      } else {
        accessGrantedServiceLevel = await checkCredentials(
          task.consumerAddress,
          service.credentials,
          await blockchain.getSigner()
        )
      }

      if (!accessGrantedServiceLevel) {
        CORE_LOGGER.debug(`Error: Access to service with id ${service.id} was denied`)
        return {
          stream: null,
          status: {
            httpStatus: 403,
            error: `Error: Access to service with id ${service.id} was denied`
          }
        }
      }
    }

    // 4. Check service type
    const serviceType = service.type
    if (serviceType === 'compute') {
      // only compute envs are allowed to download compute assets
      // get all compute envs
      const computeAddrs: string[] = []

      const c2dEngines = oceanNode.getC2DEngines()
      if (!c2dEngines) {
        const msg =
          'Compute engines are not configured on this node; cannot validate compute download'
        CORE_LOGGER.debug(msg)
        return {
          stream: null,
          status: {
            httpStatus: 503,
            error: msg
          }
        }
      }
      const environments = await c2dEngines.fetchEnvironments(ddo.chainId)
      for (const env of environments)
        computeAddrs.push(env.consumerAddress?.toLowerCase())

      if (!computeAddrs.includes(task.consumerAddress?.toLowerCase())) {
        const msg = 'Not allowed to download this asset of type compute'
        CORE_LOGGER.debug(msg)
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
    const fees = new ProviderFees(node)
    const validFee = await fees.verifyProviderFees(
      task.transferTxId,
      task.consumerAddress,
      provider,
      service
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
      service.timeout,
      await blockchain.getSigner()
    )

    if (paymentValidation.isValid) {
      CORE_LOGGER.debug(`Valid payment transaction. Result: ${paymentValidation.message}`)
    } else {
      CORE_LOGGER.debug(`Invalid payment transaction: ${paymentValidation.message}`)
      return {
        stream: null,
        status: {
          httpStatus: 500,
          error: paymentValidation.message
        }
      }
    }

    try {
      // 7. Decrypt the url

      let filesObject: string = null
      let decriptedFileObject: any = null
      let decryptedFileData: any = null
      // check if confidential EVM
      const confidentialEVM = isConfidentialChainDDO(BigInt(ddo.chainId), service)
      // check that files is missing and template 4 is active on the chain
      if (confidentialEVM) {
        const signer = await blockchain.getSigner()
        const isTemplate4 = await isDataTokenTemplate4(service.datatokenAddress, signer)

        if (!isTemplate4 || !(await isERC20Template4Active(ddo.chainId, signer))) {
          const errorMsg =
            'Cannot decrypt DDO files, Template 4 is not active for confidential EVM!'
          CORE_LOGGER.debug(errorMsg)
          return {
            stream: null,
            status: {
              httpStatus: 403,
              error: errorMsg
            }
          }
        } else {
          // TODO decrypt using Oasis SDK
          CORE_LOGGER.debug(
            'Downloading from Confidential EVM, try get filesObject from Smart Contract'
          )

          const serviceIndex = AssetUtils.getServiceIndexById(ddo, task.serviceId)
          const consumerMessage = String(ddo.id + task.nonce)
          filesObject = await getFilesObjectFromConfidentialEVM(
            serviceIndex,
            service.datatokenAddress,
            signer,
            task.consumerAddress,
            task.signature,
            consumerMessage
          )

          decryptedFileData = JSON.parse(filesObject)
          decriptedFileObject = decryptedFileData.files[task.fileIndex]
        }
      } else {
        // non confidential EVM
        filesObject = service.files
        const uint8ArrayHex = Uint8Array.from(
          Buffer.from(sanitizeServiceFiles(filesObject), 'hex')
        )
        const decryptedUrlBytes = await oceanNode
          .getKeyManager()
          .decrypt(uint8ArrayHex, EncryptMethod.ECIES)
        // Convert the decrypted bytes back to a string
        const decryptedFilesString = Buffer.from(decryptedUrlBytes).toString()
        decryptedFileData = JSON.parse(decryptedFilesString)
        decriptedFileObject = decryptedFileData.files[task.fileIndex]
      }

      if (decriptedFileObject?.url && task.userData) {
        const url = new URL(decriptedFileObject.url)
        const userDataObj =
          typeof task.userData === 'string' ? JSON.parse(task.userData) : task.userData
        for (const [key, value] of Object.entries(userDataObj)) {
          url.searchParams.append(key, String(value))
        }
        decriptedFileObject.url = url.toString()
        CORE_LOGGER.debug(
          `Appended ${Object.keys(userDataObj).length} userData params to file url`
        )
      }

      if (!validateFilesStructure(ddo, service, decryptedFileData)) {
        CORE_LOGGER.warn(
          `Unauthorized download operation for ${ddo.id}. Decrypted "nftAddress" and "datatokenAddress" do not match the original DDO`
        )
        return {
          stream: null,
          status: {
            httpStatus: 403,
            error: 'Failed to download asset, unauthorized operation!'
          }
        }
      }

      // 8. Proceed to download the file
      return await handleDownloadUrlCommand(node, {
        fileObject: decriptedFileObject,
        aes_encrypted_key: task.aes_encrypted_key,
        command: PROTOCOL_COMMANDS.DOWNLOAD
      })
    } catch (e) {
      CORE_LOGGER.warn(
        `Decryption error for ${ddo.id} service ${task.serviceId}: ${errorSummary(e)}`
      )
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
