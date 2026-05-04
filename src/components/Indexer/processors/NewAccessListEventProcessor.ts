import { ethers, Signer, FallbackProvider, Interface } from 'ethers'
import { INDEXER_LOGGER } from '../../../utils/logging/common.js'
import { LOG_LEVELS_STR } from '../../../utils/logging/Logger.js'
import { BaseEventProcessor } from './BaseProcessor.js'
import AccessListFactory from '@oceanprotocol/contracts/artifacts/contracts/accesslists/AccessListFactory.sol/AccessListFactory.json' with { type: 'json' }
import AccessList from '@oceanprotocol/contracts/artifacts/contracts/accesslists/AccessList.sol/AccessList.json' with { type: 'json' }

const factoryInterface = new Interface(AccessListFactory.abi)

export class NewAccessListEventProcessor extends BaseEventProcessor {
  async processEvent(
    event: ethers.Log,
    chainId: number,
    signer: Signer,
    provider: FallbackProvider
  ): Promise<any> {
    try {
      const decoded = factoryInterface.parseLog({
        topics: Array.from(event.topics),
        data: event.data
      })
      if (!decoded) return null

      const contractAddress = decoded.args[0].toString().toLowerCase()

      let transferable = false
      let name: string | undefined
      let symbol: string | undefined
      try {
        const accessListContract = new ethers.Contract(
          contractAddress,
          AccessList.abi,
          provider
        )
        const [transferableRaw, nameRaw, symbolRaw] = await Promise.all([
          accessListContract.transferable(),
          accessListContract.name(),
          accessListContract.symbol()
        ])
        transferable = Boolean(transferableRaw)
        name = nameRaw
        symbol = symbolRaw
      } catch (err) {
        INDEXER_LOGGER.log(
          LOG_LEVELS_STR.LEVEL_WARN,
          `Failed to read on-chain metadata for ${contractAddress}: ${err.message}`
        )
      }

      const { accessList } = await this.getDatabase()
      const result = await accessList.create(
        chainId,
        contractAddress,
        transferable,
        event.blockNumber,
        event.transactionHash,
        name,
        symbol
      )

      INDEXER_LOGGER.logMessage(
        `[NewAccessList] Indexed access list ${contractAddress} on chain ${chainId} (name=${name}, symbol=${symbol}, transferable=${transferable})`
      )
      return result
    } catch (err) {
      INDEXER_LOGGER.log(
        LOG_LEVELS_STR.LEVEL_ERROR,
        `Error processing NewAccessList event: ${err.message}`,
        true
      )
      return null
    }
  }
}
