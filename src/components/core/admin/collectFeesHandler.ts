import { AdminHandler } from './adminHandler.js'
import { AdminCollectFeesCommand } from '../../../@types/commands.js'
import { P2PCommandResponse } from '../../../@types/OceanNode.js'
import {
  ValidateParams,
  buildInvalidParametersResponse,
  buildErrorResponse,
  buildInvalidRequestMessage
} from '../../httpRoutes/validateCommands.js'
import { getConfiguration } from '../../../utils/index.js'
import { getProviderFeeToken, getProviderWallet } from '../utils/feesHandler.js'
import { parseUnits, Contract, ZeroAddress } from 'ethers'
import ERC20Template from '@oceanprotocol/contracts/artifacts/contracts/templates/ERC20Template.sol/ERC20Template.json' assert { type: 'json' }
import { CORE_LOGGER } from '../../../utils/logging/common.js'
import { Readable } from 'stream'

export class CollectFeesHandler extends AdminHandler {
  validate(command: AdminCollectFeesCommand): ValidateParams {
    if (
      !/^0x([A-Fa-f0-9]{40})$/.test(command.tokenAddress) ||
      !/^0x([A-Fa-f0-9]{40})$/.test(command.destinationAddress)
    ) {
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
    const providerWallet = await getProviderWallet(String(task.chainId))
    try {
      const providerFeeToken = await getProviderFeeToken(task.chainId)
      if (
        task.tokenAddress.toLowerCase() !== providerFeeToken.toLowerCase() ||
        task.tokenAddress === ZeroAddress ||
        providerFeeToken === ZeroAddress
      ) {
        const msg: string = `Token address ${task.tokenAddress} is not the same with provider fee token address ${providerFeeToken}`
        CORE_LOGGER.error(msg)
        return buildErrorResponse(msg)
      }

      const token = new Contract(
        task.tokenAddress.toLowerCase(),
        ERC20Template.abi,
        providerWallet
      )
      if (
        (await token.balanceOf(await providerWallet.getAddress())) <
        parseUnits(task.tokenAmount.toString(), 'ether')
      ) {
        const msg: string = `Amount too high to transfer! Balance: ${await token.balanceOf(
          await providerWallet.getAddress()
        )} vs. amount provided: ${parseUnits(task.tokenAmount.toString(), 'ether')}`
        CORE_LOGGER.error(msg)
        return buildErrorResponse(msg)
      }
      const tx = await token.transfer(
        task.destinationAddress.toLowerCase(),
        parseUnits(task.tokenAmount.toString(), 'ether')
      )
      const txReceipt = await tx.wait()
      const response: any = {
        tx: txReceipt.hash,
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
