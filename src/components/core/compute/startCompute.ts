import { Readable } from 'stream'
import { P2PCommandResponse } from '../../../@types/index.js'
import { CORE_LOGGER } from '../../../utils/logging/common.js'
import { CommandHandler } from '../handler/handler.js'
import { ComputeStartCommand, FreeComputeStartCommand } from '../../../@types/commands.js'
import { getAlgoChecksums, validateAlgoForDataset } from './utils.js'
import {
  ValidateParams,
  buildInvalidRequestMessage,
  validateCommandParameters
} from '../../httpRoutes/validateCommands.js'
import { isAddress } from 'ethers'
import {
  AssetUtils,
  getFilesObjectFromConfidentialEVM,
  isConfidentialChainDDO,
  isDataTokenTemplate4,
  isERC20Template4Active
} from '../../../utils/asset.js'
import { EncryptMethod } from '../../../@types/fileObject.js'
import { decrypt } from '../../../utils/crypt.js'
import { verifyProviderFees } from '../utils/feesHandler.js'
import { Blockchain } from '../../../utils/blockchain.js'
import { validateOrderTransaction } from '../utils/validateOrders.js'
import { getConfiguration } from '../../../utils/index.js'
import { sanitizeServiceFiles } from '../../../utils/util.js'
import { FindDdoHandler } from '../handler/ddoHandler.js'
import { ProviderFeeValidation } from '../../../@types/Fees.js'
import { isOrderingAllowedForAsset } from '../handler/downloadHandler.js'
import { checkNonce, NonceResponse, getNonceAsNumber } from '../utils/nonceHandler.js'

export class ComputeStartHandler extends CommandHandler {
  validate(command: ComputeStartCommand): ValidateParams {
    const commandValidation = validateCommandParameters(command, [
      'consumerAddress',
      'signature',
      'nonce',
      'environment',
      'algorithm',
      'datasets'
    ])
    if (commandValidation.valid) {
      if (!isAddress(command.consumerAddress)) {
        return buildInvalidRequestMessage(
          'Parameter : "consumerAddress" is not a valid web3 address'
        )
      }
    }
    return commandValidation
  }

  async handle(task: ComputeStartCommand): Promise<P2PCommandResponse> {
    const validationResponse = await this.verifyParamsAndRateLimits(task)
    if (this.shouldDenyTaskHandling(validationResponse)) {
      return validationResponse
    }
    try {
      // split compute env (which is already in hash-envId format) and get the hash
      // then get env which might contain dashes as well
      const eIndex = task.environment.indexOf('-')
      const hash = task.environment.slice(0, eIndex)
      const envId = task.environment.slice(eIndex + 1)
      let engine
      try {
        engine = await this.getOceanNode().getC2DEngines().getC2DByHash(hash)
      } catch (e) {
        return {
          stream: null,
          status: {
            httpStatus: 500,
            error: 'Invalid C2D Environment'
          }
        }
      }

      try {
        const env = await engine.getComputeEnvironment(null, task.environment)
        if (!env) {
          return {
            stream: null,
            status: {
              httpStatus: 500,
              error: 'Invalid C2D Environment'
            }
          }
        }
        task.resources = await engine.checkAndFillMissingResources(
          task.resources,
          env,
          false
        )
        await engine.checkIfResourcesAreAvailable(task.resources, env, true)
      } catch (e) {
        return {
          stream: null,
          status: {
            httpStatus: 400,
            error: e
          }
        }
      }
      const node = this.getOceanNode()
      const { algorithm } = task
      let foundValidCompute = null

      const algoChecksums = await getAlgoChecksums(
        task.algorithm.documentId,
        task.algorithm.serviceId,
        this.getOceanNode()
      )
      if (!algoChecksums.container || !algoChecksums.files) {
        CORE_LOGGER.error(`Error retrieveing algorithm checksums!`)
        return {
          stream: null,
          status: {
            httpStatus: 500,
            error: `Error retrieveing algorithm checksums!`
          }
        }
      }
      // check algo
      for (const elem of [...[task.algorithm], ...task.datasets]) {
        console.log(elem)
        const result: any = { validOrder: false }
        if ('documentId' in elem && elem.documentId) {
          result.did = elem.documentId
          result.serviceId = elem.documentId
          const ddo = await new FindDdoHandler(node).findAndFormatDdo(elem.documentId)
          if (!ddo) {
            const error = `DDO ${elem.documentId} not found`
            return {
              stream: null,
              status: {
                httpStatus: 500,
                error
              }
            }
          }
          const isOrdable = isOrderingAllowedForAsset(ddo)
          if (!isOrdable.isOrdable) {
            CORE_LOGGER.error(isOrdable.reason)
            return {
              stream: null,
              status: {
                httpStatus: 500,
                error: isOrdable.reason
              }
            }
          }
          const service = AssetUtils.getServiceById(ddo, elem.serviceId)
          if (!service) {
            const error = `Cannot find service ${elem.serviceId} in DDO ${elem.documentId}`
            return {
              stream: null,
              status: {
                httpStatus: 500,
                error
              }
            }
          }

          const config = await getConfiguration()
          const { rpc, network, chainId, fallbackRPCs } =
            config.supportedNetworks[ddo.chainId]
          const blockchain = new Blockchain(rpc, network, chainId, fallbackRPCs)
          const { ready, error } = await blockchain.isNetworkReady()
          if (!ready) {
            return {
              stream: null,
              status: {
                httpStatus: 400,
                error: `Start Compute : ${error}`
              }
            }
          }

          const signer = blockchain.getSigner()
          // let's see if we can access this asset
          // check if oasis evm or similar
          const confidentialEVM = isConfidentialChainDDO(ddo.chainId, service)
          let canDecrypt = false
          try {
            if (!confidentialEVM) {
              await decrypt(
                Uint8Array.from(Buffer.from(sanitizeServiceFiles(service.files), 'hex')),
                EncryptMethod.ECIES
              )
              canDecrypt = true
            } else {
              // TODO 'Start compute on confidential EVM!'
              const isTemplate4 = await isDataTokenTemplate4(
                service.datatokenAddress,
                signer
              )
              if (isTemplate4 && (await isERC20Template4Active(ddo.chainId, signer))) {
                // we need to get the proper data for the signature
                const consumeData =
                  task.consumerAddress +
                  task.datasets[0].documentId +
                  getNonceAsNumber(task.consumerAddress)
                // call smart contract to decrypt
                const serviceIndex = AssetUtils.getServiceIndexById(ddo, service.id)
                const filesObject = await getFilesObjectFromConfidentialEVM(
                  serviceIndex,
                  service.datatokenAddress,
                  signer,
                  task.consumerAddress,
                  task.signature, // we will need to have a signature verification
                  consumeData
                )
                if (filesObject != null) {
                  canDecrypt = true
                }
              }
            }
          } catch (e) {
            // do nothing
            CORE_LOGGER.error('Could not decrypt DDO files Object: ' + e.message)
          }
          if (service.type === 'compute' && !canDecrypt) {
            const error = `Service ${elem.serviceId} from DDO ${elem.documentId} cannot be used in compute on this provider`
            return {
              stream: null,
              status: {
                httpStatus: 500,
                error
              }
            }
          }
          if (ddo.metadata.type !== 'algorithm') {
            const validAlgoForDataset = await validateAlgoForDataset(
              task.algorithm.documentId,
              algoChecksums,
              ddo,
              ddo.services[0].id,
              node
            )
            if (!validAlgoForDataset) {
              return {
                stream: null,
                status: {
                  httpStatus: 400,
                  error: `Algorithm ${task.algorithm.documentId} not allowed to run on the dataset: ${ddo.id}`
                }
              }
            }
          }

          const provider = blockchain.getProvider()
          result.datatoken = service.datatokenAddress
          result.chainId = ddo.chainId

          const env = await engine.getComputeEnvironment(ddo.chainId, task.environment)
          if (!('transferTxId' in elem) || !elem.transferTxId) {
            const error = `Missing transferTxId for DDO ${elem.documentId}`
            return {
              stream: null,
              status: {
                httpStatus: 500,
                error
              }
            }
          }

          // search for that compute env and see if it has access to dataset
          const paymentValidation = await validateOrderTransaction(
            elem.transferTxId,
            env.consumerAddress,
            provider,
            ddo.nftAddress,
            service.datatokenAddress,
            AssetUtils.getServiceIndexById(ddo, service.id),
            service.timeout,
            blockchain.getSigner()
          )
          if (paymentValidation.isValid === false) {
            const error = `TxId Service ${elem.transferTxId} is not valid for DDO ${elem.documentId} and service ${service.id}`
            return {
              stream: null,
              status: {
                httpStatus: 500,
                error
              }
            }
          }
          result.validOrder = elem.transferTxId
          // start with assumption than we need new providerfees
          const validFee: ProviderFeeValidation =
            foundValidCompute === null
              ? await verifyProviderFees(
                  elem.transferTxId,
                  task.consumerAddress,
                  provider,
                  service,
                  task.environment,
                  0
                )
              : {
                  isValid: false,
                  isComputeValid: false,
                  message: false,
                  validUntil: 0
                }

          if (validFee.isComputeValid === true) {
            CORE_LOGGER.logMessage(
              `Found a valid compute providerFee ${elem.transferTxId}`,
              true
            )
            foundValidCompute = {
              txId: elem.transferTxId,
              chainId: ddo.chainId,
              validUntil: validFee.validUntil
            }
          }
          if (!('meta' in algorithm) && ddo.metadata.type === 'algorithm') {
            const { entrypoint, image, tag, checksum } = ddo.metadata.algorithm.container
            const container = { entrypoint, image, tag, checksum }
            algorithm.meta = {
              language: ddo.metadata.algorithm.language,
              version: ddo.metadata.algorithm.version,
              container
            }
            if ('format' in ddo.metadata.algorithm) {
              algorithm.meta.format = ddo.metadata.algorithm.format
            }
          }
        }
      }
      if (!foundValidCompute) {
        CORE_LOGGER.logMessage(`Cannot find a valid compute providerFee`, true)
        return {
          stream: null,
          status: {
            httpStatus: 400,
            error: `Invalid compute environment: ${task.environment}`
          }
        }
      }
      // TODO - hardcoded values.
      //  - validate providerFees -> will generate chainId & agreementId & validUntil
      const { chainId } = foundValidCompute
      const agreementId = foundValidCompute.txId
      const { validUntil } = foundValidCompute

      const response = await engine.startComputeJob(
        task.datasets,
        algorithm,
        task.output,
        envId,
        task.consumerAddress,
        validUntil,
        chainId,
        agreementId,
        task.resources
      )

      CORE_LOGGER.logMessage(
        'ComputeStartCommand Response: ' + JSON.stringify(response, null, 2),
        true
      )

      return {
        stream: Readable.from(JSON.stringify(response)),
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

export class FreeComputeStartHandler extends CommandHandler {
  validate(command: ComputeStartCommand): ValidateParams {
    const commandValidation = validateCommandParameters(command, [
      'algorithm',
      'datasets',
      'consumerAddress',
      'signature',
      'nonce',
      'environment'
    ])
    if (commandValidation.valid) {
      if (!isAddress(command.consumerAddress)) {
        return buildInvalidRequestMessage(
          'Parameter : "consumerAddress" is not a valid web3 address'
        )
      }
    }
    return commandValidation
  }

  async handle(task: FreeComputeStartCommand): Promise<P2PCommandResponse> {
    const validationResponse = await this.verifyParamsAndRateLimits(task)
    if (this.shouldDenyTaskHandling(validationResponse)) {
      return validationResponse
    }
    const thisNode = this.getOceanNode()
    // Validate nonce and signature
    const nonceCheckResult: NonceResponse = await checkNonce(
      thisNode.getDatabase().nonce,
      task.consumerAddress,
      parseInt(task.nonce),
      task.signature,
      String(task.nonce)
    )

    if (!nonceCheckResult.valid) {
      CORE_LOGGER.logMessage(
        'Invalid nonce or signature, unable to proceed: ' + nonceCheckResult.error,
        true
      )
      return {
        stream: null,
        status: {
          httpStatus: 500,
          error:
            'Invalid nonce or signature, unable to proceed: ' + nonceCheckResult.error
        }
      }
    }
    let engine = null
    let validUntil = null
    try {
      // split compute env (which is already in hash-envId format) and get the hash
      // then get env which might contain dashes as well
      const eIndex = task.environment.indexOf('-')
      const hash = task.environment.slice(0, eIndex)
      // const envId = task.environment.slice(eIndex + 1)
      try {
        engine = await thisNode.getC2DEngines().getC2DByHash(hash)
      } catch (e) {
        return {
          stream: null,
          status: {
            httpStatus: 500,
            error: 'Invalid C2D Environment'
          }
        }
      }
      if (engine === null) {
        return {
          stream: null,
          status: {
            httpStatus: 500,
            error: 'Invalid C2D Environment'
          }
        }
      }
      try {
        const env = await engine.getComputeEnvironment(null, task.environment)
        if (!env) {
          return {
            stream: null,
            status: {
              httpStatus: 500,
              error: 'Invalid C2D Environment'
            }
          }
        }

        task.resources = await engine.checkAndFillMissingResources(
          task.resources,
          env,
          true
        )
        await engine.checkIfResourcesAreAvailable(task.resources, env, true)
        if (task.validUntil) {
          validUntil = env.free.maxJobDuration
            ? Math.min(task.validUntil, env.free.maxJobDuration)
            : task.validUntil
        } else {
          if (env.free.maxJobDuration) validUntil = env.free.maxJobDuration
        }
      } catch (e) {
        console.error(e)
        return {
          stream: null,
          status: {
            httpStatus: 400,
            error: String(e)
          }
        }
      }
      // console.log(task.resources)
      /*
      return {
        stream: null,
        status: {
          httpStatus: 200,
          error: null
        }
      } */
      const response = await engine.startComputeJob(
        task.datasets,
        task.algorithm,
        task.output,
        task.environment,
        task.consumerAddress,
        validUntil,
        null,
        null,
        task.resources
      )

      CORE_LOGGER.logMessage(
        'FreeComputeStartCommand Response: ' + JSON.stringify(response, null, 2),
        true
      )

      return {
        stream: Readable.from(JSON.stringify(response)),
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
