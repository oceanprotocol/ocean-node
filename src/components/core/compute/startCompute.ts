import { Readable } from 'stream'
import { P2PCommandResponse } from '../../../@types/index.js'
import { ComputeAsset } from '../../../@types/C2D.js'
import { CORE_LOGGER } from '../../../utils/logging/common.js'
import { Handler } from '../handler.js'
import { ComputeStartCommand } from '../../../@types/commands.js'
import { C2DEngine } from '../../c2d/compute_engines.js'
import {
  ValidateParams,
  buildInvalidParametersResponse,
  buildInvalidRequestMessage,
  validateCommandParameters
} from '../../httpRoutes/validateCommands.js'
import { isAddress } from 'ethers'

export class ComputeStartHandler extends Handler {
  validate(command: ComputeStartCommand): ValidateParams {
    const commandValidation = validateCommandParameters(command, [
      'consumerAddress',
      'signature',
      'nonce',
      'environment',
      'algorithm',
      'dataset'
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
    const validation = this.validate(task)
    if (!validation.valid) {
      return buildInvalidParametersResponse(validation)
    }
    try {
      CORE_LOGGER.logMessage(
        'ComputeStartCommand received with arguments: ' + JSON.stringify(task, null, 2),
        true
      )
      // split compute env (which is already in hash-envId format) and get the hash
      // then get env which might contain dashes as well
      const index = task.environment.indexOf('-')
      const hash = task.environment.slice(0, index)
      const envId = task.environment.slice(index + 1)

      // env might contain
      let engine
      try {
        engine = await C2DEngine.getC2DByHash(hash)
      } catch (e) {
        return {
          stream: null,
          status: {
            httpStatus: 500,
            error: 'Invalid C2D Environment'
          }
        }
      }
      const assets: ComputeAsset[] = [task.dataset]
      if (task.additionalDatasets) assets.push(...task.additionalDatasets)
      // TODO - hardcoded values.
      //  - validate algo & datasets
      //  - validate providerFees -> will generate chainId & agreementId & validUntil
      const chainId = 8996
      const agreementId = '0x1234'
      const validUntil = new Date().getTime() + 60
      const response = await engine.startComputeJob(
        assets,
        task.algorithm,
        task.output,
        task.consumerAddress,
        envId,
        validUntil,
        chainId,
        agreementId
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
