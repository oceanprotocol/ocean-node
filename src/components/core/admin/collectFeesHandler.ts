import { AdminHandler } from './adminHandler.js'
import {
  AdminCollectFeesCommand,
  AdminCollectFeesHandlerResponse
} from '../../../@types/commands.js'
import { P2PCommandResponse } from '../../../@types/OceanNode.js'
import {
  ValidateParams,
  buildInvalidParametersResponse,
  buildErrorResponse,
  buildInvalidRequestMessage,
  validateCommandParameters
} from '../../httpRoutes/validateCommands.js'
import {
  getConfiguration,
  checkSupportedChainId,
  Blockchain
} from '../../../utils/index.js'
import { parseUnits, Contract, ZeroAddress, isAddress, Wallet } from 'ethers'
import ERC20Template from '@oceanprotocol/contracts/artifacts/contracts/templates/ERC20Template.sol/ERC20Template.json' assert { type: 'json' }
import { CORE_LOGGER } from '../../../utils/logging/common.js'
import { Readable } from 'stream'

export class CollectFeesHandler extends AdminHandler {
  validate(command: AdminCollectFeesCommand): ValidateParams {
    if (
      !validateCommandParameters(command, [
        'chainId',
        'tokenAddress',
        'tokenAmount',
        'destinationAddress'
      ])
    ) {
      return buildInvalidRequestMessage(
        `Missing chainId field for command: "${command}".`
      )
    }
    if (!isAddress(command.tokenAddress) || !isAddress(command.destinationAddress)) {
      const msg: string = `Invalid format for token address or destination address.`
      CORE_LOGGER.error(msg)
      return buildInvalidRequestMessage(msg)
    }
    return super.validate(command)
  }

  async handle(task: AdminCollectFeesCommand): Promise<P2PCommandResponse> {
    const validation = this.validate(task)
    if (!validation.valid) {
      return buildInvalidParametersResponse(validation)
    }
    const config = await getConfiguration()
    if (task.node && task.node !== config.keys.peerId.toString()) {
      const msg: string = `Cannot run this command ${JSON.stringify(
        task
      )} on a different node.`
      CORE_LOGGER.error(msg)
      return buildErrorResponse(msg)
    }
    const checkChainId = await checkSupportedChainId(task.chainId)
    if (!checkChainId.validation) {
      return buildErrorResponse(
        `Chain ID ${task.chainId} is not supported in the node's config`
      )
    }

    try {
      const { rpc, network, chainId, fallbackRPCs } =
        config.supportedNetworks[task.chainId]
      const blockchain = new Blockchain(rpc, network, chainId, fallbackRPCs)
      const provider = blockchain.getProvider()
      const providerWallet = blockchain.getSigner() as Wallet
      const providerWalletAddress = await providerWallet.getAddress()
      const ammountInEther = task.tokenAmount
        ? parseUnits(task.tokenAmount.toString(), 'ether')
        : await provider.getBalance(providerWalletAddress)

      let receipt
      if (task.tokenAddress.toLowerCase() === ZeroAddress) {
        if (
          (await provider.getBalance(providerWalletAddress)) <
          (await blockchain.calculateGasCost(
            task.destinationAddress.toLowerCase(),
            ammountInEther
          ))
        ) {
          const msg: string = `Amount too high to transfer native token! Balance: ${await provider.getBalance(
            providerWalletAddress
          )} vs. amount provided: ${ammountInEther}`
          CORE_LOGGER.error(msg)
          return buildErrorResponse(msg)
        }

        receipt = await blockchain.sendTransaction(
          providerWallet,
          task.destinationAddress.toLowerCase(),
          ammountInEther
        )
      } else {
        const token = new Contract(
          task.tokenAddress.toLowerCase(),
          ERC20Template.abi,
          providerWallet
        )
        const tokenAmount = task.tokenAmount
          ? parseUnits(task.tokenAmount.toString(), 'ether')
          : await token.balanceOf(providerWalletAddress)

        if ((await token.balanceOf(providerWalletAddress)) < tokenAmount) {
          const msg: string = `Amount too high to transfer! Balance: ${await token.balanceOf(
            providerWalletAddress
          )} vs. amount provided: ${tokenAmount}`
          CORE_LOGGER.error(msg)
          return buildErrorResponse(msg)
        }
        const tx = await token.transfer(
          task.destinationAddress.toLowerCase(),
          tokenAmount
        )
        receipt = await tx.wait()
      }
      if (!receipt) {
        const msg: string = `Receipt does not exist`
        CORE_LOGGER.error(msg)
        return {
          stream: null,
          status: {
            httpStatus: 404,
            error: msg
          }
        }
      }
      if (receipt.status !== 1) {
        const msg: string = `Reverted transaction: ${JSON.stringify(receipt.logs)}`
        CORE_LOGGER.error(msg)
        return {
          stream: null,
          status: {
            httpStatus: 404,
            error: msg
          }
        }
      }
      const response: AdminCollectFeesHandlerResponse = {
        tx: receipt.hash,
        message: 'Fees successfully transfered to admin!'
      }
      return {
        status: { httpStatus: 200 },
        stream: Readable.from(JSON.stringify(response))
      }
    } catch (e) {
      const msg: string = `Error in collecting provider fees: ${e}`
      CORE_LOGGER.error(msg)
      return {
        stream: null,
        status: {
          httpStatus: 500,
          error: msg
        }
      }
    }
  }
}
