import { Handler } from './handler.js'
import { P2PCommandResponse } from '../../@types/OceanNode.js'
import {
  ReindexChainCommand,
  ReindexTxCommand,
  StopNodeCommand
} from '../../@types/commands.js'
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
import {
  processBlocks,
  processChunkLogs,
  getDeployedContractBlock
} from '../Indexer/utils.js'
import { Blockchain, getConfiguration } from '../../utils/index.js'

export class StopNodeHandler extends Handler {
  validate(command: StopNodeCommand): ValidateParams {
    const commandValidation = validateCommandParameters(command, [
      'expiryTimestamp',
      'signature'
    ])
    if (!commandValidation.valid) {
      const errorMsg = `Command validation failed: ${JSON.stringify(commandValidation)}`
      CORE_LOGGER.logMessage(errorMsg)
      return buildInvalidRequestMessage(errorMsg)
    }
    if (!validateSignature(command.expiryTimestamp, command.signature)) {
      const errorMsg = 'Expired authentication or invalid signature'
      CORE_LOGGER.logMessage(errorMsg)
      return buildInvalidRequestMessage(errorMsg)
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
      const errorMsg = `Command validation failed: ${JSON.stringify(commandValidation)}`
      CORE_LOGGER.logMessage(errorMsg)
      return buildInvalidRequestMessage(errorMsg)
    }
    if (!validateSignature(command.expiryTimestamp, command.signature)) {
      const errorMsg = 'Expired authentication or invalid signature'
      CORE_LOGGER.logMessage(errorMsg)
      return buildInvalidRequestMessage(errorMsg)
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
    const blockchain = new Blockchain(
      config.supportedNetworks[task.chainId.toString()].rpc,
      task.chainId
    )
    const provider = blockchain.getProvider()
    const signer = blockchain.getSigner()
    try {
      const receipt = await provider.getTransactionReceipt(task.txId)
      if (!receipt) {
        CORE_LOGGER.log(
          LOG_LEVELS_STR.LEVEL_ERROR,
          `Tx receipt was not found for txId ${task.txId}`,
          true
        )
        return
      }
      const { logs } = receipt
      const ret = await processChunkLogs(logs, signer, provider, task.chainId)
      if (!ret) {
        CORE_LOGGER.log(
          LOG_LEVELS_STR.LEVEL_ERROR,
          `Reindex tx for txId ${task.txId} failed on chain ${task.chainId}.`,
          true
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

export class ReindexChainHandler extends Handler {
  validate(command: ReindexChainCommand): ValidateParams {
    const commandValidation = validateCommandParameters(command, [
      'expiryTimestamp',
      'signature',
      'chainId'
    ])
    if (!commandValidation.valid) {
      const errorMsg = `Command validation failed: ${JSON.stringify(commandValidation)}`
      CORE_LOGGER.logMessage(errorMsg)
      return buildInvalidRequestMessage(errorMsg)
    }
    if (!validateSignature(command.expiryTimestamp, command.signature)) {
      const errorMsg = 'Expired authentication or invalid signature'
      CORE_LOGGER.logMessage(errorMsg)
      return buildInvalidRequestMessage(errorMsg)
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
    CORE_LOGGER.logMessage(`Reindexing chaincommand called`)
    const config = await getConfiguration()
    const blockchain = new Blockchain(
      config.supportedNetworks[task.chainId.toString()].rpc,
      task.chainId
    )
    const provider = blockchain.getProvider()
    const signer = blockchain.getSigner()
    const deployedBlock = getDeployedContractBlock(task.chainId)
    try {
      await this.getOceanNode().getDatabase().ddo.deleteAllAssetsFromChain(task.chainId)
      CORE_LOGGER.logMessage(
        `Assets from chain ${task.chainId} were deleted from db, now starting to reindex...`
      )
      const latestBlock = await provider.getBlockNumber()
      const ret = await processBlocks(
        signer,
        provider,
        task.chainId,
        deployedBlock,
        latestBlock - deployedBlock + 1
      )
      if (!ret) {
        CORE_LOGGER.log(
          LOG_LEVELS_STR.LEVEL_ERROR,
          `Reindex chain failed on chain ${task.chainId}.`,
          true
        )
        return
      }

      return new Promise<P2PCommandResponse>((resolve, reject) => {
        resolve({
          status: { httpStatus: 200 },
          stream: new ReadableString('REINDEX CHAIN OK')
        })
      })
    } catch (error) {
      CORE_LOGGER.log(
        LOG_LEVELS_STR.LEVEL_ERROR,
        `REINDEX chain: ${error.message} `,
        true
      )
    }
  }
}
