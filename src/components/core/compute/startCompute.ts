import { Readable } from 'stream'
import { P2PCommandResponse } from '../../../@types/index.js'
import { CORE_LOGGER } from '../../../utils/logging/common.js'
import {
  FreeComputeStartCommand,
  PaidComputeStartCommand
} from '../../../@types/commands.js'
import { CommandHandler } from '../handler/handler.js'
import { generateUniqueID, getAlgoChecksums, validateAlgoForDataset } from './utils.js'
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
import {
  ComputeAccessList,
  ComputeResourceRequestWithPrice
} from '../../../@types/C2D/C2D.js'
import { decrypt } from '../../../utils/crypt.js'
// import { verifyProviderFees } from '../utils/feesHandler.js'
import { Blockchain } from '../../../utils/blockchain.js'
import { validateOrderTransaction } from '../utils/validateOrders.js'
import { getConfiguration, isPolicyServerConfigured } from '../../../utils/index.js'
import { sanitizeServiceFiles } from '../../../utils/util.js'
import { FindDdoHandler } from '../handler/ddoHandler.js'
// import { ProviderFeeValidation } from '../../../@types/Fees.js'
import { isOrderingAllowedForAsset } from '../handler/downloadHandler.js'
import { Credentials, DDOManager } from '@oceanprotocol/ddo-js'
import { getNonceAsNumber } from '../utils/nonceHandler.js'
import { PolicyServer } from '../../policyServer/index.js'
import {
  areKnownCredentialTypes,
  checkCredentials,
  findAccessListCredentials
} from '../../../utils/credentials.js'
export class PaidComputeStartHandler extends CommandHandler {
  validate(command: PaidComputeStartCommand): ValidateParams {
    const commandValidation = validateCommandParameters(command, [
      'environment',
      'algorithm',
      'datasets',
      'maxJobDuration'
    ])
    if (commandValidation.valid) {
      if (!isAddress(command.consumerAddress)) {
        return buildInvalidRequestMessage(
          'Parameter : "consumerAddress" is not a valid web3 address'
        )
      }
      if (parseInt(String(command.maxJobDuration)) <= 0) {
        return buildInvalidRequestMessage('Invalid maxJobDuration')
      }
    }
    return commandValidation
  }

  async handle(task: PaidComputeStartCommand): Promise<P2PCommandResponse> {
    const validationResponse = await this.verifyParamsAndRateLimits(task)
    if (this.shouldDenyTaskHandling(validationResponse)) {
      return validationResponse
    }

    const authValidationResponse = await this.validateTokenOrSignature(
      task.authorization,
      task.consumerAddress,
      task.nonce,
      task.signature,
      String(task.consumerAddress + task.datasets[0]?.documentId + task.nonce)
    )

    if (authValidationResponse.status.httpStatus !== 200) {
      return authValidationResponse
    }

    try {
      const node = this.getOceanNode()
      // split compute env (which is already in hash-envId format) and get the hash
      // then get env which might contain dashes as well
      const eIndex = task.environment.indexOf('-')
      const hash = task.environment.slice(0, eIndex)
      let engine
      let env
      try {
        engine = await node.getC2DEngines().getC2DByHash(hash)
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
        env = await engine.getComputeEnvironment(null, task.environment)
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
        task.payment.resources = await engine.checkAndFillMissingResources(
          task.payment.resources,
          env,
          false
        )
        await engine.checkIfResourcesAreAvailable(task.payment.resources, env, true)
      } catch (e) {
        return {
          stream: null,
          status: {
            httpStatus: 400,
            error: e
          }
        }
      }

      const accessGranted = await validateAccess(task.consumerAddress, env.access)
      if (!accessGranted) {
        return {
          stream: null,
          status: {
            httpStatus: 403,
            error: 'Access denied'
          }
        }
      }

      const { algorithm } = task
      const algoChecksums = await getAlgoChecksums(
        task.algorithm.documentId,
        task.algorithm.serviceId,
        node
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
      const policyServer = new PolicyServer()
      // check algo
      for (const elem of [...[task.algorithm], ...task.datasets]) {
        console.log(elem)
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
            metadata,
            nftAddress,
            credentials
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
          // check credentials (DDO level)
          let accessGrantedDDOLevel: boolean
          if (credentials) {
            // if POLICY_SERVER_URL exists, then ocean-node will NOT perform any checks.
            // It will just use the existing code and let PolicyServer decide.
            if (isPolicyServerConfigured()) {
              const response = await policyServer.checkStartCompute(
                ddo.id,
                ddo,
                elem.serviceId,
                task.consumerAddress,
                task.policyServer
              )
              accessGrantedDDOLevel = response.success
            } else {
              accessGrantedDDOLevel = areKnownCredentialTypes(credentials as Credentials)
                ? checkCredentials(credentials as Credentials, task.consumerAddress)
                : true
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
                ddoInstance.getDid(),
                ddo,
                elem.serviceId,
                task.consumerAddress,
                task.policyServer
              )
              accessGrantedServiceLevel = accessGrantedDDOLevel || response.success
            } else {
              accessGrantedServiceLevel = areKnownCredentialTypes(service.credentials)
                ? checkCredentials(service.credentials, task.consumerAddress)
                : true
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

          const config = await getConfiguration()
          const { rpc, network, chainId, fallbackRPCs } =
            config.supportedNetworks[ddoChainId]
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
          const confidentialEVM = isConfidentialChainDDO(BigInt(ddo.chainId), service)
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
              if (isTemplate4 && (await isERC20Template4Active(ddoChainId, signer))) {
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

          const provider = blockchain.getProvider()
          result.datatoken = service.datatokenAddress
          result.chainId = ddoChainId

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
            nftAddress,
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

          if (!('meta' in algorithm) && ddo.metadata.type === 'algorithm') {
            const { entrypoint, image, tag, checksum } = ddo.metadata.algorithm.container
            const container = { entrypoint, image, tag, checksum }
            algorithm.meta = {
              language: metadata.algorithm.language,
              version: metadata.algorithm.version,
              container
            }
          }
        }
      }
      // let's lock the amount
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
      const resources: ComputeResourceRequestWithPrice[] = []

      for (const res of task.payment.resources) {
        const price = engine.getResourcePrice(prices, res.id)
        resources.push({
          id: res.id,
          amount: res.amount,
          price
        })
      }
      const s = {
        assets: task.datasets,
        algorithm,
        output: task.output,
        environment: env.id,
        owner: task.consumerAddress,
        maxJobDuration: task.maxJobDuration,
        chainId: task.payment.chainId,
        agreementId: '',
        resources,
        metadata: task.metadata
      }
      // job ID unicity
      const jobId = generateUniqueID(s)
      // let's calculate payment needed based on resources request and maxJobDuration
      const cost = engine.calculateResourcesCost(
        task.payment.resources,
        env,
        task.payment.chainId,
        task.payment.token,
        task.maxJobDuration
      )
      let agreementId
      try {
        agreementId = await engine.escrow.createLock(
          task.payment.chainId,
          jobId,
          task.payment.token,
          task.consumerAddress,
          cost,
          task.maxJobDuration
        )
      } catch (e) {
        return {
          stream: null,
          status: {
            httpStatus: 400,
            error: e
          }
        }
      }
      try {
        const response = await engine.startComputeJob(
          task.datasets,
          algorithm,
          task.output,
          env.id,
          task.consumerAddress,
          task.maxJobDuration,
          task.payment.resources,
          {
            chainId: task.payment.chainId,
            token: task.payment.token,
            lockTx: agreementId,
            claimTx: null
          },
          jobId,
          task.metadata,
          task.additionalViewers
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
      } catch (e) {
        try {
          await engine.escrow.cancelExpiredLocks(
            task.payment.chainId,
            jobId,
            task.payment.token,
            task.consumerAddress
          )
        } catch (e) {
          // is fine if it fails
        }
        return {
          stream: null,
          status: {
            httpStatus: 400,
            error: e
          }
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
  validate(command: FreeComputeStartCommand): ValidateParams {
    const commandValidation = validateCommandParameters(command, [
      'algorithm',
      'datasets',
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
    const thisNode = this.getOceanNode()
    const validationResponse = await this.verifyParamsAndRateLimits(task)
    if (this.shouldDenyTaskHandling(validationResponse)) {
      return validationResponse
    }

    const authValidationResponse = await this.validateTokenOrSignature(
      task.authorization,
      task.consumerAddress,
      task.nonce,
      task.signature,
      String(task.nonce)
    )
    if (authValidationResponse.status.httpStatus !== 200) {
      return authValidationResponse
    }

    let engine = null
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
      const policyServer = new PolicyServer()
      for (const elem of [...[task.algorithm], ...task.datasets]) {
        if (!('documentId' in elem)) {
          continue
        }
        const ddo = await new FindDdoHandler(this.getOceanNode()).findAndFormatDdo(
          elem.documentId
        )
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
        const { credentials } = ddoInstance.getDDOFields()
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
            accessGrantedDDOLevel = areKnownCredentialTypes(credentials as Credentials)
              ? checkCredentials(credentials as Credentials, task.consumerAddress)
              : true
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
              service.id,
              task.consumerAddress,
              task.policyServer
            )
            accessGrantedServiceLevel = accessGrantedDDOLevel || response.success
          } else {
            accessGrantedServiceLevel = areKnownCredentialTypes(service.credentials)
              ? checkCredentials(service.credentials, task.consumerAddress)
              : true
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

        const accessGranted = await validateAccess(task.consumerAddress, env.free.access)
        if (!accessGranted) {
          return {
            stream: null,
            status: {
              httpStatus: 403,
              error: 'Access denied'
            }
          }
        }

        task.resources = await engine.checkAndFillMissingResources(
          task.resources,
          env,
          true
        )
        await engine.checkIfResourcesAreAvailable(task.resources, env, true)
        if (!task.maxJobDuration || task.maxJobDuration > env.free.maxJobDuration) {
          task.maxJobDuration = env.free.maxJobDuration
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
      const s = {
        assets: task.datasets,
        algorithm: task.algorithm,
        output: task.output,
        environment: task.environment,
        owner: task.consumerAddress,
        maxJobDuration: task.maxJobDuration,
        resources: task.resources,
        metadata: task.metadata
      }
      const jobId = generateUniqueID(s)
      const response = await engine.startComputeJob(
        task.datasets,
        task.algorithm,
        task.output,
        task.environment,
        task.consumerAddress,
        task.maxJobDuration,
        task.resources,
        null,
        jobId,
        task.metadata,
        task.additionalViewers
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

async function validateAccess(
  consumerAddress: string,
  access: ComputeAccessList | undefined
): Promise<boolean> {
  if (!access) {
    return true
  }

  if (access.accessLists.length === 0 && access.addresses.length === 0) {
    return true
  }

  if (access.addresses.includes(consumerAddress)) {
    return true
  }

  if (access.accessLists.length > 0) {
    const config = await getConfiguration()
    const { supportedNetworks } = config

    for (const accessListAddress of access.accessLists) {
      for (const chainIdStr of Object.keys(supportedNetworks)) {
        const { rpc, network, chainId, fallbackRPCs } = supportedNetworks[chainIdStr]
        try {
          const blockchain = new Blockchain(rpc, network, chainId, fallbackRPCs)
          const signer = blockchain.getSigner()

          const hasAccess = await findAccessListCredentials(
            signer,
            accessListAddress,
            consumerAddress
          )
          if (hasAccess) {
            return true
          }
        } catch (error) {
          CORE_LOGGER.logMessage(
            `Failed to check access list ${accessListAddress} on chain ${chainIdStr}: ${error.message}`,
            true
          )
        }
      }
    }
  }

  return false
}
