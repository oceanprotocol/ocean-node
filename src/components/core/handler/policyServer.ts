import { P2PCommandResponse } from '../../../@types/index.js'
import {
  PolicyServerPassthroughCommand,
  PolicyServerInitializeCommand
} from '../../../@types/commands.js'
import { Readable } from 'stream'
import { isAddress } from 'ethers'
import { CommandHandler } from './handler.js'
import {
  ValidateParams,
  buildInvalidRequestMessage,
  validateCommandParameters
} from '../../httpRoutes/validateCommands.js'
import { CORE_LOGGER } from '../../../utils/logging/common.js'

import { PolicyServer } from '../../policyServer/index.js'

export class PolicyServerPassthroughHandler extends CommandHandler {
  validate(command: PolicyServerPassthroughCommand): ValidateParams {
    if (!command.policyServerPassthrough)
      return buildInvalidRequestMessage(
        'Invalid Request: missing policyServerPassthrough field!'
      )
    // we inject fields into this object below, so it has to be a keyed object. arrays are
    // objects too, and would be forwarded as {"0":..,"1":..} with no action
    if (
      typeof command.policyServerPassthrough !== 'object' ||
      Array.isArray(command.policyServerPassthrough)
    )
      return buildInvalidRequestMessage(
        'Invalid Request: "policyServerPassthrough" must be an object!'
      )
    const validation = validateCommandParameters(command, ['consumerAddress'])
    if (validation.valid && !isAddress(command.consumerAddress)) {
      return buildInvalidRequestMessage(
        'Parameter : "consumerAddress" is not a valid web3 address'
      )
    }
    return validation
  }

  async handle(task: PolicyServerPassthroughCommand): Promise<P2PCommandResponse> {
    const validationResponse = await this.verifyParamsAndRateLimits(task)
    if (this.shouldDenyTaskHandling(validationResponse)) {
      return validationResponse
    }
    // same auth contract as startCompute: an authorization token, or nonce + signature
    const authValidationResponse = await this.validateTokenOrSignature(
      task.authorization,
      task.consumerAddress,
      task.nonce,
      task.signature,
      task.command
    )
    if (authValidationResponse.status.httpStatus !== 200) {
      return authValidationResponse
    }
    task.policyServerPassthrough.ddo = null
    // resolve DDO first
    try {
      task.policyServerPassthrough.ddo = await (
        await this.getOceanNode().getDatabase()
      ).ddo.retrieve(task.policyServerPassthrough.documentId)
    } catch (error) {
      // just log it
      CORE_LOGGER.warn(
        `PolicyServerPassthroughHandler: DDO not found for documentId ${task.policyServerPassthrough.documentId}: ${error.message}`
      )
    }
    // the passthrough payload is forwarded verbatim, so every identity field has to be
    // (re)written here, after validation. otherwise a caller could forge consumerAddress
    // and impersonate the typed actions (download, startCompute, ...)
    task.policyServerPassthrough.consumerAddress = authValidationResponse.consumerAddress
    task.policyServerPassthrough.authorization = task.authorization
    task.policyServerPassthrough.nonce = task.nonce
    task.policyServerPassthrough.signature = task.signature
    // policyServer check
    const policyServer = new PolicyServer()
    const policyStatus = await policyServer.passThrough(task.policyServerPassthrough)
    if (!policyStatus.success) {
      return {
        stream: null,
        status: {
          httpStatus: policyStatus.httpStatus,
          error: policyStatus.message
        }
      }
    } else {
      return {
        stream: Readable.from(policyStatus.message),
        status: {
          httpStatus: policyStatus.httpStatus
        }
      }
    }
  }
}

export class PolicyServerInitializeHandler extends CommandHandler {
  validate(command: PolicyServerInitializeCommand): ValidateParams {
    if (!command.policyServer)
      return buildInvalidRequestMessage('Invalid Request: missing policyServer field!')
    const validation = validateCommandParameters(command, [
      'documentId',
      'serviceId',
      'consumerAddress'
    ])
    if (validation.valid && !isAddress(command.consumerAddress)) {
      return buildInvalidRequestMessage(
        'Parameter : "consumerAddress" is not a valid web3 address'
      )
    }
    return validation
  }

  async handle(task: PolicyServerInitializeCommand): Promise<P2PCommandResponse> {
    const validationResponse = await this.verifyParamsAndRateLimits(task)
    if (this.shouldDenyTaskHandling(validationResponse)) {
      return validationResponse
    }
    // same auth contract as startCompute: an authorization token, or nonce + signature
    const authValidationResponse = await this.validateTokenOrSignature(
      task.authorization,
      task.consumerAddress,
      task.nonce,
      task.signature,
      task.command
    )
    if (authValidationResponse.status.httpStatus !== 200) {
      return authValidationResponse
    }
    // resolve DDO first
    try {
      const database = await this.getOceanNode().getDatabase()
      if (!database || !database.ddo) {
        return {
          stream: null,
          status: { httpStatus: 503, error: 'DDO database is not available' }
        }
      }
      const ddo = await database.ddo.retrieve(task.documentId)
      if (!ddo) {
        return {
          stream: null,
          status: { httpStatus: 404, error: 'Not found' }
        }
      }
      // policyServer check
      const policyServer = new PolicyServer()
      // forward the address this node actually verified, plus the caller credentials,
      // so the policy server can run its own additional checks
      const policyStatus = await policyServer.initializePSVerification(
        task.documentId,
        ddo,
        task.serviceId,
        authValidationResponse.consumerAddress,
        {
          ...task.policyServer,
          authorization: task.authorization,
          nonce: task.nonce,
          signature: task.signature
        }
      )
      if (!policyStatus.success) {
        return {
          stream: null,
          status: {
            httpStatus: policyStatus.httpStatus,
            error: policyStatus.message
          }
        }
      } else {
        return {
          stream: Readable.from(policyStatus.message),
          status: {
            httpStatus: policyStatus.httpStatus
          }
        }
      }
    } catch (error) {
      return {
        stream: null,
        status: { httpStatus: 500, error: 'Unknown error: ' + error.message }
      }
    }
  }
}
