import { ethers, Signer, FallbackProvider, Interface } from 'ethers'
import { INDEXER_LOGGER } from '../../../utils/logging/common.js'
import { LOG_LEVELS_STR } from '../../../utils/logging/Logger.js'
import { BaseEventProcessor } from './BaseProcessor.js'
import AccessList from '@oceanprotocol/contracts/artifacts/contracts/accesslists/AccessList.sol/AccessList.json' with { type: 'json' }

const accessListInterface = new Interface(AccessList.abi)

// OwnershipTransferred is emitted by every Ownable contract; only update if the
// emitting contract is already a known AccessList (doc exists), otherwise no-op.
export class AccessListOwnershipTransferredEventProcessor extends BaseEventProcessor {
  async processEvent(
    event: ethers.Log,
    chainId: number,
    signer: Signer,
    provider: FallbackProvider
  ): Promise<any> {
    try {
      const contractAddress = event.address.toLowerCase()
      const { accessList } = await this.getDatabase()

      const existing = await accessList.retrieve(chainId, contractAddress)
      if (!existing) {
        return null
      }

      const decoded = accessListInterface.parseLog({
        topics: Array.from(event.topics),
        data: event.data
      })
      if (!decoded) return null

      const newOwner = decoded.args[1].toString().toLowerCase()
      const result = await accessList.updateOwner(
        chainId,
        contractAddress,
        newOwner,
        event.blockNumber,
        event.transactionHash
      )

      INDEXER_LOGGER.logMessage(
        `[AccessList:OwnershipTransferred] ${contractAddress} owner -> ${newOwner} on chain ${chainId}`
      )
      return result
    } catch (err) {
      INDEXER_LOGGER.log(
        LOG_LEVELS_STR.LEVEL_ERROR,
        `Error processing AccessList OwnershipTransferred event: ${err.message}`,
        true
      )
      return null
    }
  }
}
