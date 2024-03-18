import { P2PCommandResponse } from '../../../@types/index.js'
import { CORE_LOGGER } from '../../../utils/logging/common.js'
import { Handler } from '../handler.js'
import { ComputeGetResultCommand } from '../../../@types/commands.js'
import { C2DEngine } from '../../c2d/compute_engines.js'
import { checkNonce, NonceResponse } from '../utils/nonceHandler.js'
import {
  buildInvalidParametersResponse,
  buildInvalidRequestMessage,
  validateCommandParameters,
  ValidateParams
} from '../../httpRoutes/validateCommands.js'
import { isAddress } from 'ethers'

export class ComputeGetResultHandler extends Handler {
  validate(command: ComputeGetResultCommand): ValidateParams {
    const validation = validateCommandParameters(command, [
      'consumerAddress',
      'signature',
      'nonce',
      'jobId',
      'index'
    ])
    if (validation.valid) {
      if (command.consumerAddress && !isAddress(command.consumerAddress)) {
        return buildInvalidRequestMessage(
          'Parameter : "consumerAddress" is not a valid web3 address'
        )
      }
      if (isNaN(command.index) || command.index < 1) {
        return buildInvalidRequestMessage('Invalid result index')
      }
    }
    return validation
  }

  async handle(task: ComputeGetResultCommand): Promise<P2PCommandResponse> {
    const validation = this.validate(task)
    if (!validation.valid) {
      return buildInvalidParametersResponse(validation)
    }

    let error = null

    const nonceCheckResult: NonceResponse = await checkNonce(
      this.getOceanNode().getDatabase().nonce,
      task.consumerAddress,
      parseInt(task.nonce),
      task.signature,
      task.jobId + task.index.toString()
    )

    if (!nonceCheckResult.valid) {
      // eslint-disable-next-line prefer-destructuring
      error = nonceCheckResult.error
    }

    if (error) {
      CORE_LOGGER.logMessage(error, true)
      return {
        stream: null,
        status: {
          httpStatus: 400,
          error
        }
      }
    }
    // split jobId (which is already in hash-jobId format) and get the hash
    // then get jobId which might contain dashes as well
    const index = task.jobId.indexOf('-')
    const hash = task.jobId.slice(0, index)
    const jobId = task.jobId.slice(index + 1)

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
    try {
      return {
        stream: await engine.getComputeJobResult(task.consumerAddress, jobId, task.index),
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
