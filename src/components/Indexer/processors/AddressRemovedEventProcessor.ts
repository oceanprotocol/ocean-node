import { ethers, Signer, FallbackProvider, Interface } from 'ethers'
import { INDEXER_LOGGER } from '../../../utils/logging/common.js'
import { LOG_LEVELS_STR } from '../../../utils/logging/Logger.js'
import { BaseEventProcessor } from './BaseProcessor.js'
import AccessList from '@oceanprotocol/contracts/artifacts/contracts/accesslists/AccessList.sol/AccessList.json' with { type: 'json' }

const accessListInterface = new Interface(AccessList.abi)

export class AddressRemovedEventProcessor extends BaseEventProcessor {
  async processEvent(
    event: ethers.Log,
    chainId: number,
    signer: Signer,
    provider: FallbackProvider
  ): Promise<any> {
    try {
      const decoded = accessListInterface.parseLog({
        topics: Array.from(event.topics),
        data: event.data
      })
      if (!decoded) return null

      const tokenId = Number(decoded.args[0])
      const contractAddress = event.address.toLowerCase()

      const { accessList } = await this.getDatabase()
      const result = await accessList.removeUserByTokenId(
        chainId,
        contractAddress,
        tokenId
      )

      INDEXER_LOGGER.logMessage(
        `[AddressRemoved] tokenId=${tokenId} removed from ${contractAddress} on chain ${chainId}`
      )
      return result
    } catch (err) {
      INDEXER_LOGGER.log(
        LOG_LEVELS_STR.LEVEL_ERROR,
        `Error processing AddressRemoved event: ${err.message}`,
        true
      )
      return null
    }
  }
}
