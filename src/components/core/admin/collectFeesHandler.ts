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
import { ReadableString } from '../../P2P/handleProtocolCommands.js'
import ERC20Template from '@oceanprotocol/contracts/artifacts/contracts/templates/ERC20Template.sol/ERC20Template.json' assert { type: 'json' }
import { CORE_LOGGER } from '../../../utils/logging/common.js'

export class CollectFeesHandler extends AdminHandler {
  validate(command: AdminCollectFeesCommand): ValidateParams {
    if (
      !/^0x([A-Fa-f0-9]{40})$/.test(command.tokenAddress) ||
      !/^0x([A-Fa-f0-9]{40})$/.test(command.destinationAddress)
    ) {
      CORE_LOGGER.logMessage(
        `enters here: ${/^0x([A-Fa-f0-9]{40})$/.test(
          command.tokenAddress
        )}, ${/^0x([A-Fa-f0-9]{40})$/.test(command.destinationAddress)}`
      )
      return buildInvalidRequestMessage(
        `Invalid format for token address or destination address.`
      )
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
      return buildErrorResponse(
        `Cannot run this command ${JSON.stringify(task)} on a different node.`
      )
    }
    const providerWallet = await getProviderWallet(String(task.chainId))
    try {
      const providerFeeToken = await getProviderFeeToken(task.chainId)
      if (
        task.tokenAddress !== providerFeeToken ||
        task.tokenAddress === ZeroAddress ||
        providerFeeToken === ZeroAddress
      ) {
        return buildErrorResponse(
          `Token address ${task.tokenAddress} is not the same with provider fee token address ${providerFeeToken}`
        )
      }

      const token = new Contract(task.tokenAddress, ERC20Template.abi, providerWallet)
      if (
        (await token.balanceOf(await providerWallet.getAddress())) <
        parseUnits(task.tokenAmount.toString(), 'ether')
      ) {
        return buildErrorResponse(
          `Amount too high to transfer! Balance: ${await token.balance(
            providerWallet
          )} vs. amount provided: ${parseUnits(task.tokenAmount.toString(), 'ether')}`
        )
      }
      const tx = await token.transfer(
        task.destinationAddress.toLowerCase(),
        parseUnits(task.tokenAmount.toString(), 'ether')
      )
      await tx.wait()

      return {
        status: { httpStatus: 200 },
        stream: new ReadableString(
          JSON.stringify({
            txId: tx.hash,
            message: 'Fees successfully transfered to admin!'
          })
        )
      }
    } catch (e) {
      return {
        stream: null,
        status: {
          httpStatus: 500,
          error: `Error in collecting provider fees: ${e}`
        }
      }
    }
  }
}
