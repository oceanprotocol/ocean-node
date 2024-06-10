import { AdminHandler } from './adminHandler.js'
import { AdminCollectFeesCommand } from '../../../@types/commands.js'
import { P2PCommandResponse } from '../../../@types/OceanNode.js'
import {
  ValidateParams,
  buildInvalidParametersResponse,
  buildErrorResponse
} from '../../httpRoutes/validateCommands.js'
import { getConfiguration, Blockchain } from '../../../utils/index.js'
import { getProviderWallet } from '../utils/feesHandler.js'
import { parseUnits } from 'ethers'
import { ReadableString } from '../../P2P/handleProtocolCommands.js'

export class CollectFeesHandler extends AdminHandler {
  validate(command: AdminCollectFeesCommand): ValidateParams {
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
    const { rpc, network, chainId, fallbackRPCs } = config.supportedNetworks[task.chainId]
    const blockchain = new Blockchain(rpc, network, chainId, fallbackRPCs)
    const { ready, error } = await blockchain.isNetworkReady()
    if (!ready) {
      return buildErrorResponse(`Collect Provider Fees: ${error}`)
    }
    const provider = blockchain.getProvider()
    try {
      if (
        (await provider.getBalance(task.tokenAddress)) <
        parseUnits(task.tokenAmount.toString(), 'ether')
      ) {
        return buildErrorResponse(
          `Amount too high to transfer! Balance: ${await provider.getBalance(
            task.tokenAddress
          )} vs. amount provided: ${parseUnits(task.tokenAmount.toString(), 'ether')}`
        )
      }

      const tx = await providerWallet.sendTransaction({
        to: task.destinationAddress.toLowerCase(),
        value: parseUnits(task.tokenAmount.toString(), 'ether')
      })
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
