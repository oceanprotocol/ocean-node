import { Readable } from 'stream'
import { P2PCommandResponse } from '../../../@types/index.js'
import { CORE_LOGGER } from '../../../utils/logging/common.js'
import { Handler } from '../handler/handler.js'
import { DDO } from '../../../@types/DDO/DDO.js'
import { ComputeInitializeCommand } from '../../../@types/commands.js'
import { ProviderComputeInitializeResults } from '../../../@types/Fees.js'
import { AssetUtils } from '../../../utils/asset.js'
import { verifyProviderFees, createProviderFee } from '../utils/feesHandler.js'
import { getJsonRpcProvider } from '../../../utils/blockchain.js'
import { validateOrderTransaction } from '../utils/validateOrders.js'
import { getExactComputeEnv } from './utils.js'
import { EncryptMethod } from '../../../@types/fileObject.js'
import { decrypt } from '../../../utils/crypt.js'
import {
  ValidateParams,
  buildInvalidRequestMessage,
  validateCommandParameters
} from '../../httpRoutes/validateCommands.js'
import { isAddress } from 'ethers'
export class ComputeInitializeHandler extends Handler {
  validate(command: ComputeInitializeCommand): ValidateParams {
    const validation = validateCommandParameters(command, [
      'datasets',
      'algorithm',
      'compute',
      'consumerAddress'
    ])
    if (validation.valid) {
      if (command.consumerAddress && !isAddress(command.consumerAddress)) {
        return buildInvalidRequestMessage(
          'Parameter : "consumerAddress" is not a valid web3 address'
        )
      }
      const { validUntil } = command.compute
      if (validUntil <= new Date().getTime() / 1000) {
        const errorMsg = `Error validating validUntil ${validUntil}. It is not in the future.`
        CORE_LOGGER.error(errorMsg)
        return buildInvalidRequestMessage(errorMsg)
      } else if (!command.compute || !command.compute.env) {
        CORE_LOGGER.error(`Invalid compute environment: ${command.compute.env}`)
        return buildInvalidRequestMessage(
          `Invalid compute environment: ${command.compute.env}`
        )
      }
    }

    return validation
  }

  async handle(task: ComputeInitializeCommand): Promise<P2PCommandResponse> {
    const validationResponse = await this.verifyParamsAndRateLimits(task)
    if (this.shouldDenyTaskHandling(validationResponse)) {
      return validationResponse
    }

    try {
      let foundValidCompute = null
      const node = this.getOceanNode()
      const allFees: ProviderComputeInitializeResults = {
        algorithm: null,
        datasets: []
      }
      // check algo
      let index = 0
      for (const elem of [...[task.algorithm], ...task.datasets]) {
        const result: any = { validOrder: false }
        if ('documentId' in elem && elem.documentId) {
          result.did = elem.documentId
          result.serviceId = elem.documentId
          const ddo = (await node.getDatabase().ddo.retrieve(elem.documentId)) as DDO
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
          // let's see if we can access this asset
          let canDecrypt = false
          try {
            await decrypt(
              Uint8Array.from(Buffer.from(service.files, 'hex')),
              EncryptMethod.ECIES
            )
            canDecrypt = true
          } catch (e) {
            // do nothing
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
          const provider = await getJsonRpcProvider(ddo.chainId)
          result.datatoken = service.datatokenAddress
          result.chainId = ddo.chainId
          // start with assumption than we need new providerfees
          let validFee = {
            isValid: false,
            isComputeValid: false,
            message: false
          }
          const env = await getExactComputeEnv(task.compute.env, ddo.chainId)
          if (!env) {
            const error = `Compute environment: ${task.compute.env} not available on chainId: ${ddo.chainId}`
            return {
              stream: null,
              status: {
                httpStatus: 500,
                error
              }
            }
          }
          result.consumerAddress = env.consumerAddress
          if ('transferTxId' in elem && elem.transferTxId) {
            // search for that compute env and see if it has access to dataset
            const paymentValidation = await validateOrderTransaction(
              elem.transferTxId,
              env.consumerAddress,
              provider,
              ddo.nftAddress,
              service.datatokenAddress,
              AssetUtils.getServiceIndexById(ddo, service.id),
              service.timeout
            )
            if (paymentValidation.isValid === true) {
              // order is valid, so let's check providerFees
              result.validOrder = elem.transferTxId
              validFee = await verifyProviderFees(
                elem.transferTxId,
                task.consumerAddress,
                provider,
                service,
                task.compute.env,
                task.compute.validUntil
              )
            } else {
              // no point in checking provider fees if order is expired
              result.validOrder = false
            }
          }
          if (validFee.isComputeValid === true) {
            foundValidCompute = { txId: elem.transferTxId, chainId: ddo.chainId }
          }
          if (validFee.isValid === false) {
            // providerFee is no longer valid, so we need to create one
            const now = new Date().getTime() / 1000
            let bestValidUntil: number = 0
            if (service.timeout === 0) {
              bestValidUntil = task.compute.validUntil // no need to pay more if asset is available for days, but we need houts
            } else {
              bestValidUntil = Math.min(now + service.timeout, task.compute.validUntil)
            }
            if (foundValidCompute || !canDecrypt) {
              // we already have a valid compute fee with another asset, or it's an asset not served by us
              // in any case, we need an access providerFee
              if (canDecrypt) {
                result.providerFee = await createProviderFee(
                  ddo,
                  service,
                  bestValidUntil,
                  null,
                  null
                )
              } else {
                // TO DO:  Edge case when this asset is served by a remote provider.
                // We should connect to that provider and get the fee
              }
            } else {
              // we need to create a compute fee
              // we can only create computeFee if the asset is ours..
              result.providerFee = await createProviderFee(
                ddo,
                service,
                bestValidUntil,
                env,
                task.compute.validUntil
              )
              foundValidCompute = { txId: null, chainId: ddo.chainId }
            }
          }
        }
        if (index === 0) allFees.algorithm = result
        else allFees.datasets.push(result)
        index = index + 1
      }
      if (!foundValidCompute) {
        // edge case, where all assets have valid orders and valid provider fees (for download)
        // unfortunatelly, none have valid compute provider fees.  let's create for the first asset that is published on a chainId that matches our env
        // just take any asset and create provider fees with compute
        console.log('TO DO!!!!')
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
