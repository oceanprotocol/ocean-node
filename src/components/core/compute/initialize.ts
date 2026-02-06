import { Readable } from 'stream'
import { P2PCommandResponse, dockerRegistryAuth } from '../../../@types/OceanNode.js'
import { C2DClusterType } from '../../../@types/C2D/C2D.js'
import { CORE_LOGGER } from '../../../utils/logging/common.js'
import { CommandHandler } from '../handler/handler.js'
import { ComputeInitializeCommand } from '../../../@types/commands.js'
import { ProviderComputeInitializeResults } from '../../../@types/Fees.js'
import {
  AssetUtils,
  getFilesObjectFromConfidentialEVM,
  isConfidentialChainDDO,
  isDataTokenTemplate4,
  isERC20Template4Active
} from '../../../utils/asset.js'
import { verifyProviderFees, createProviderFee } from '../utils/feesHandler.js'

import { validateOrderTransaction } from '../utils/validateOrders.js'
import { EncryptMethod } from '../../../@types/fileObject.js'

import {
  ValidateParams,
  buildInvalidRequestMessage,
  validateCommandParameters
} from '../../httpRoutes/validateCommands.js'
import { isAddress } from 'ethers'
import {
  DockerRegistryAuthSchema,
  getConfiguration,
  isPolicyServerConfigured
} from '../../../utils/index.js'
import { sanitizeServiceFiles } from '../../../utils/util.js'
import { FindDdoHandler } from '../handler/ddoHandler.js'
import { isOrderingAllowedForAsset } from '../handler/downloadHandler.js'
import { getNonceAsNumber } from '../utils/nonceHandler.js'
import { getAlgorithmImage } from '../../c2d/compute_engine_docker.js'

import { Credentials, DDOManager } from '@oceanprotocol/ddo-js'
import { checkCredentials } from '../../../utils/credentials.js'
import { PolicyServer } from '../../policyServer/index.js'
import { generateUniqueID, getAlgoChecksums, validateAlgoForDataset } from './utils.js'

export class ComputeInitializeHandler extends CommandHandler {
  validate(command: ComputeInitializeCommand): ValidateParams {
    const validation = validateCommandParameters(command, [
      'datasets',
      'algorithm',
      'payment',
      'consumerAddress',
      'environment'
      // we might also need a "signature" (did + nonce) for confidential evm template 4
    ])
    if (validation.valid) {
      if (command.consumerAddress && !isAddress(command.consumerAddress)) {
        return buildInvalidRequestMessage(
          'Parameter : "consumerAddress" is not a valid web3 address'
        )
      }
      if (!command.payment.chainId || !command.payment.token) {
        return buildInvalidRequestMessage('Invalid payment options')
      }
      if (command.maxJobDuration && parseInt(String(command.maxJobDuration)) <= 0) {
        return buildInvalidRequestMessage('Invalid maxJobDuration')
      }

      return validation
    }

    return validation
  }

  async handle(task: ComputeInitializeCommand): Promise<P2PCommandResponse> {
    const validationResponse = await this.verifyParamsAndRateLimits(task)
    if (this.shouldDenyTaskHandling(validationResponse)) {
      return validationResponse
    }
    if (!task.queueMaxWaitTime) {
      task.queueMaxWaitTime = 0
    }
    let engine
    let env
    let resourcesNeeded
    try {
      const node = this.getOceanNode()
      const config = await getConfiguration()
      try {
        // split compute env (which is already in hash-envId format) and get the hash
        // then get env which might contain dashes as well
        const eIndex = task.environment.indexOf('-')
        const hash = task.environment.slice(0, eIndex)
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

      const algoChecksums = await getAlgoChecksums(
        task.algorithm.documentId,
        task.algorithm.serviceId,
        node,
        config
      )

      const isRawCodeAlgorithm = task.algorithm.meta?.rawcode
      const hasValidChecksums = algoChecksums.container && algoChecksums.files

      if (!isRawCodeAlgorithm && !hasValidChecksums) {
        const errorMessage =
          'Failed to retrieve algorithm checksums. Both container and files checksums are required.'
        CORE_LOGGER.error(errorMessage)
        return {
          stream: null,
          status: {
            httpStatus: 500,
            error: errorMessage
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
        env = await engine.getComputeEnvironment(task.payment.chainId, task.environment)
        if (!env) {
          return {
            stream: null,
            status: {
              httpStatus: 500,
              error: 'Invalid C2D Environment'
            }
          }
        }
        if (!task.maxJobDuration || task.maxJobDuration > env.maxJobDuration) {
          task.maxJobDuration = env.maxJobDuration
        }
        resourcesNeeded = await engine.checkAndFillMissingResources(
          task.payment.resources,
          env,
          false
        )
      } catch (e) {
        return {
          stream: null,
          status: {
            httpStatus: 500,
            error: String(e)
          }
        }
      }
      // check if we have the required token as payment method
      const prices = engine.getEnvPricesForToken(
        env,
        task.payment.chainId,
        task.payment.token
      )
      if (!prices) {
        return {
          stream: null,
          status: {
            httpStatus: 500,
            error: `This compute env does not accept payments on chain: ${task.payment.chainId} using token ${task.payment.token}`
          }
        }
      }

      const escrowAddress = engine.escrow.getEscrowContractAddressForChain(
        task.payment.chainId
      )
      if (!escrowAddress) {
        return {
          stream: null,
          status: {
            httpStatus: 500,
            error: `Cannot handle payments on chainId: ${task.payment.chainId}`
          }
        }
      }
      // let's calculate payment needed based on resources request and maxJobDuration
      const cost = engine.calculateResourcesCost(
        resourcesNeeded,
        env,
        task.payment.chainId,
        task.payment.token,
        task.maxJobDuration
      )
      const allFees: ProviderComputeInitializeResults = {
        algorithm: null,
        datasets: [],
        payment: {
          escrowAddress,
          payee: env.consumerAddress,
          chainId: task.payment.chainId,
          minLockSeconds: engine.escrow.getMinLockTime(
            task.maxJobDuration + task.queueMaxWaitTime
          ),
          token: task.payment.token,
          amount: await engine.escrow.getPaymentAmountInWei(
            cost,
            task.payment.chainId,
            task.payment.token
          )
        }
      }

      // check algo
      let index = 0
      const policyServer = new PolicyServer()
      for (const elem of [...[task.algorithm], ...task.datasets]) {
        const result: any = { validOrder: false }
        if ('documentId' in elem && elem.documentId) {
          result.did = elem.documentId
          result.serviceId = elem.serviceId
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
          const ddoInstance = DDOManager.getDDOClass(ddo)
          const {
            chainId: ddoChainId,
            nftAddress,
            credentials,
            metadata
          } = ddoInstance.getDDOFields()
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
          if (metadata.type !== 'algorithm') {
            const index = task.datasets.findIndex(
              (d) => d.documentId === ddoInstance.getDid()
            )
            const safeIndex = index === -1 ? 0 : index
            const validAlgoForDataset = await validateAlgoForDataset(
              task.algorithm.documentId,
              algoChecksums,
              ddoInstance,
              task.datasets[safeIndex].serviceId,
              node
            )
            if (!validAlgoForDataset) {
              return {
                stream: null,
                status: {
                  httpStatus: 400,
                  error: `Algorithm ${
                    task.algorithm.documentId
                  } not allowed to run on the dataset: ${ddoInstance.getDid()}`
                }
              }
            }
          }
          const config = await getConfiguration()
          const { chainId } = config.supportedNetworks[ddoChainId]
          const oceanNode = this.getOceanNode()
          const blockchain = oceanNode.getBlockchain(chainId)
          if (!blockchain) {
            return {
              stream: null,
              status: {
                httpStatus: 400,
                error: `Initialize Compute: Blockchain instance not available for chain ${chainId}`
              }
            }
          }
          const { ready, error } = await blockchain.isNetworkReady()
          if (!ready) {
            return {
              stream: null,
              status: {
                httpStatus: 400,
                error: `Initialize Compute: ${error}`
              }
            }
          }
          // check credentials (DDO level)
          let accessGrantedDDOLevel: boolean
          if (credentials) {
            // if POLICY_SERVER_URL exists, then ocean-node will NOT perform any checks.
            // It will just use the existing code and let PolicyServer decide.
            if (isPolicyServerConfigured()) {
              const response = await policyServer.checkStartCompute(
                ddoInstance.getDid(),
                ddo,
                elem.serviceId,
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
              CORE_LOGGER.logMessage(
                `Error: Access to asset ${ddoInstance.getDid()} was denied`,
                true
              )
              return {
                stream: null,
                status: {
                  httpStatus: 403,
                  error: `Error: Access to asset ${ddoInstance.getDid()} was denied`
                }
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
          // check credentials on service level
          // if using a policy server and we are here it means that access was granted (they are merged/assessed together)
          if (service.credentials) {
            let accessGrantedServiceLevel: boolean
            if (isPolicyServerConfigured()) {
              // we use the previous check or we do it again
              // (in case there is no DDO level credentials and we only have Service level ones)
              const response = await policyServer.checkStartCompute(
                ddo.id,
                ddo,
                elem.serviceId,
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
              CORE_LOGGER.logMessage(
                `Error: Access to service with id ${service.id} was denied`,
                true
              )
              return {
                stream: null,
                status: {
                  httpStatus: 403,
                  error: `Error: Access to service with id ${service.id} was denied`
                }
              }
            }
          }

          // docker images?
          const clusters = config.c2dClusters
          let hasDockerImages = false
          for (const cluster of clusters) {
            if (cluster.type === C2DClusterType.DOCKER) {
              hasDockerImages = true
              break
            }
          }
          if (hasDockerImages) {
            const algoImage = getAlgorithmImage(task.algorithm, generateUniqueID(task))
            if (algoImage) {
              // validate encrypteddockerRegistryAuth
              let validation: ValidateParams
              if (task.encryptedDockerRegistryAuth) {
                validation = await engine.checkEncryptedDockerRegistryAuth(
                  task.encryptedDockerRegistryAuth
                )
                if (!validation.valid) {
                  return {
                    stream: null,
                    status: {
                      httpStatus: validation.status,
                      error: `Invalid encryptedDockerRegistryAuth :${validation.reason}`
                    }
                  }
                }
              }
              validation = await engine.checkDockerImage(
                algoImage,
                task.encryptedDockerRegistryAuth,
                env.platform
              )
              if (!validation.valid) {
                return {
                  stream: null,
                  status: {
                    httpStatus: validation.status,
                    error: `Initialize Compute failed for image ${algoImage} :${validation.reason}`
                  }
                }
              }
            }
          }

          const signer = await blockchain.getSigner()

          // check if oasis evm or similar
          const confidentialEVM = isConfidentialChainDDO(BigInt(ddo.chainId), service)
          // let's see if we can access this asset
          let canDecrypt = false
          try {
            if (!confidentialEVM) {
              await node
                .getKeyManager()
                .decrypt(
                  Uint8Array.from(
                    Buffer.from(sanitizeServiceFiles(service.files), 'hex')
                  ),
                  EncryptMethod.ECIES
                )
              canDecrypt = true
            } else {
              // TODO 'Initialize compute on confidential EVM!
              const isTemplate4 = await isDataTokenTemplate4(
                service.datatokenAddress,
                signer
              )
              if (isTemplate4) {
                if (!task.signature) {
                  CORE_LOGGER.error(
                    'Could not decrypt ddo files on template 4, missing consumer signature!'
                  )
                } else if (await isERC20Template4Active(ddoChainId, signer)) {
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
                  if (filesObject !== null) {
                    canDecrypt = true
                  }
                } else {
                  CORE_LOGGER.error(
                    'Could not decrypt ddo files on template 4, template is not active!'
                  )
                }
              }
            }
          } catch (e) {
            // do nothing
            CORE_LOGGER.error(`Could not decrypt ddo files:  ${e.message} `)
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

          const provider = await blockchain.getProvider()
          result.datatoken = service.datatokenAddress
          result.chainId = ddoChainId
          // start with assumption than we need new providerfees
          let validFee = {
            isValid: false,
            message: false
          }
          result.consumerAddress = env.consumerAddress
          if ('transferTxId' in elem && elem.transferTxId) {
            // search for that compute env and see if it has access to dataset
            const paymentValidation = await validateOrderTransaction(
              elem.transferTxId,
              env.consumerAddress,
              provider,
              nftAddress,
              service.datatokenAddress,
              AssetUtils.getServiceIndexById(ddo, service.id),
              service.timeout,
              await blockchain.getSigner()
            )
            if (paymentValidation.isValid === true) {
              // order is valid, so let's check providerFees
              result.validOrder = elem.transferTxId
              validFee = await verifyProviderFees(
                elem.transferTxId,
                task.consumerAddress,
                provider,
                service
              )
            } else {
              // no point in checking provider fees if order is expired
              result.validOrder = false
            }
          }
          if (validFee.isValid === false) {
            if (canDecrypt) {
              result.providerFee = await createProviderFee(ddo, service, service.timeout)
            } else {
              // TO DO:  Edge case when this asset is served by a remote provider.
              // We should connect to that provider and get the fee
            }
          }
        }
        if (index === 0) allFees.algorithm = result
        else allFees.datasets.push(result)
        index = index + 1
      }

      return {
        stream: Readable.from(JSON.stringify(allFees)),
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
