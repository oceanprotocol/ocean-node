import { Handler } from './handler.js'
import { P2PCommandResponse } from '../../@types/OceanNode.js'
import { ReindexTxCommand, StopNodeCommand } from '../../@types/commands.js'
import { CORE_LOGGER } from '../../utils/logging/common.js'
import { LOG_LEVELS_STR } from '../../utils/logging/Logger.js'
import { ReadableString } from '../P2P/handleProtocolCommands.js'
import {
  ValidateParams,
  validateCommandParameters,
  buildInvalidRequestMessage,
  buildInvalidParametersResponse
} from '../httpRoutes/validateCommands.js'
import { validateSignature } from '../../utils/auth.js'
import { processChunkLogs } from '../Indexer/utils.js'
import { Blockchain, getConfiguration } from '../../utils/index.js'

export class StopNodeHandler extends Handler {
  validate(command: StopNodeCommand): ValidateParams {
    const commandValidation = validateCommandParameters(command, [
      'expiryTimestamp',
      'signature'
    ])
    if (!commandValidation.valid) {
      return buildInvalidRequestMessage(
        `Command validation failed: ${JSON.stringify(commandValidation)}`
      )
    }
    if (!validateSignature(command.expiryTimestamp, command.signature)) {
      return buildInvalidRequestMessage('Expired authentication or invalid signature')
    }
    return commandValidation
  }

  handle(task: StopNodeCommand): Promise<P2PCommandResponse> {
    const validation = this.validate(task)
    if (!validation.valid) {
      return new Promise<P2PCommandResponse>((resolve, reject) => {
        resolve(buildInvalidParametersResponse(validation))
      })
    }
    CORE_LOGGER.logMessage(`Stopping node execution...`)
    setTimeout(() => {
      process.exit()
    }, 2000)
    return new Promise<P2PCommandResponse>((resolve, reject) => {
      resolve({
        status: { httpStatus: 200 },
        stream: new ReadableString('EXIT OK')
      })
    })
  }
}

export class ReindexTxHandler extends Handler {
  validate(command: ReindexTxCommand): ValidateParams {
    const commandValidation = validateCommandParameters(command, [
      'expiryTimestamp',
      'signature',
      'chainId',
      'txId'
    ])
    if (!commandValidation.valid) {
      return buildInvalidRequestMessage(
        `Command validation failed: ${JSON.stringify(commandValidation)}`
      )
    }
    if (!validateSignature(command.expiryTimestamp, command.signature)) {
      return buildInvalidRequestMessage('Expired authentication or invalid signature')
    }
    return commandValidation
  }

  async handle(task: ReindexTxCommand): Promise<P2PCommandResponse> {
    const validation = this.validate(task)
    if (!validation.valid) {
      return new Promise<P2PCommandResponse>((resolve, reject) => {
        resolve(buildInvalidParametersResponse(validation))
      })
    }
    CORE_LOGGER.logMessage(`Reindexing tx...`)
    const config = await getConfiguration()
    if (!(`${task.chainId}` in config.supportedNetworks)) {
      CORE_LOGGER.error(`Chain ID ${task.chainId} is not supported in config.`)
      return
    }
    const blockchain = new Blockchain(
      config.supportedNetworks[task.chainId.toString()].rpc,
      task.chainId
    )
    const provider = blockchain.getProvider()
    const signer = blockchain.getSigner()
    try {
      const receipt = await provider.getTransactionReceipt(task.txId)
      if (!receipt) {
        CORE_LOGGER.error(`Tx receipt was not found for txId ${task.txId}`)
        return
      }
      const { logs } = receipt
      const ret = await processChunkLogs(logs, signer, provider, task.chainId)
      if (!ret) {
        CORE_LOGGER.error(
          `Reindex tx for txId ${task.txId} failed on chain ${task.chainId}.`
        )
        return
      }

      return new Promise<P2PCommandResponse>((resolve, reject) => {
        resolve({
          status: { httpStatus: 200 },
          stream: new ReadableString('REINDEX TX OK')
        })
      })
    } catch (error) {
      CORE_LOGGER.log(LOG_LEVELS_STR.LEVEL_ERROR, `REINDEX tx: ${error.message} `, true)
    }
  }
}
