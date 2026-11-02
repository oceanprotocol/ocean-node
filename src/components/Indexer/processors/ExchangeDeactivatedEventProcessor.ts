import { DDOManager } from '@oceanprotocol/ddo-js'
import { ethers, Signer, FallbackProvider, ZeroAddress } from 'ethers'
import { EVENTS } from '../../../utils/constants.js'
import { INDEXER_LOGGER } from '../../../utils/logging/common.js'
import {
  getDtContract,
  getDid,
  doesFreAlreadyExist,
  findServiceIdByDatatoken,
  getPricesByDt,
  isValidFreContract
} from '../utils.js'
import { BaseEventProcessor } from './BaseProcessor.js'
import FixedRateExchange from '@oceanprotocol/contracts/artifacts/contracts/pools/fixedRate/FixedRateExchange.sol/FixedRateExchange.json' with { type: 'json' }

export class ExchangeDeactivatedEventProcessor extends BaseEventProcessor {
  async processEvent(
    event: ethers.Log,
    chainId: number,
    signer: Signer,
    provider: FallbackProvider
  ): Promise<any> {
    if (!(await isValidFreContract(event.address, chainId, signer))) {
      INDEXER_LOGGER.debug(
        `Fixed Rate Exchange contract ${event.address} is not approved by Router, DDO pricing not updated`
      )
      return null
    }
    const decodedEventData = await this.getEventData(
      provider,
      event.transactionHash,
      FixedRateExchange.abi,
      EVENTS.EXCHANGE_DEACTIVATED
    )
    const exchangeId = decodedEventData.args[0].toString()
    const freContract = new ethers.Contract(event.address, FixedRateExchange.abi, signer)
    let exchange
    try {
      exchange = await freContract.getExchange(exchangeId)
    } catch (e) {
      this.rethrowIfProviderError(e)
      INDEXER_LOGGER.error(`Could not fetch exchange ${exchangeId} details: ${e.message}`)
    }
    if (!exchange) {
      INDEXER_LOGGER.debug(
        `Exchange ${exchangeId} not found, skipping ExchangeDeactivated event`
      )
      return null
    }
    const datatokenAddress = exchange[1]
    if (datatokenAddress === ZeroAddress) {
      INDEXER_LOGGER.debug(
        `Datatoken address is ZERO ADDRESS, no DDO to update (tx ${event.transactionHash})`
      )
      return null
    }
    const datatokenContract = getDtContract(signer, datatokenAddress)
    const nftAddress = await datatokenContract.getERC721Address()
    const did = getDid(nftAddress, chainId)
    try {
      const { ddo: ddoDatabase } = await this.getDatabase()
      const ddo = await ddoDatabase.retrieve(did)
      if (!ddo) {
        INDEXER_LOGGER.debug(
          `Detected ExchangeDeactivated changed for ${did}, but it does not exists.`
        )
        return null
      }

      const ddoInstance = DDOManager.getDDOClass(ddo)
      if (!ddoInstance.getAssetFields().indexedMetadata) {
        ddoInstance.updateFields({ indexedMetadata: {} })
      }

      if (!Array.isArray(ddoInstance.getAssetFields().indexedMetadata.stats)) {
        ddoInstance.updateFields({ indexedMetadata: { stats: [] } })
      }
      if (ddoInstance.getAssetFields().indexedMetadata.stats.length !== 0) {
        for (const stat of ddoInstance.getAssetFields().indexedMetadata.stats) {
          if (
            stat.datatokenAddress.toLowerCase() === datatokenAddress.toLowerCase() &&
            doesFreAlreadyExist(exchangeId, stat.prices)[0]
          ) {
            const price = doesFreAlreadyExist(exchangeId, stat.prices)[1]
            const index = stat.prices.indexOf(price)
            stat.prices.splice(index, 1)
            break
          } else if (
            stat.datatokenAddress.toLowerCase() === datatokenAddress.toLowerCase() &&
            !doesFreAlreadyExist(exchangeId, stat.prices)[0]
          ) {
            INDEXER_LOGGER.debug(
              `Detected ExchangeDeactivated changed for ${event.address}, but exchange ${exchangeId} does not exist in the DDO pricing.`
            )
            break
          }
        }
      } else {
        INDEXER_LOGGER.debug(`[ExchangeDeactivated] - No stats were found on the ddo`)
        const serviceIdToFind = findServiceIdByDatatoken(ddoInstance, datatokenAddress)
        if (!serviceIdToFind) {
          INDEXER_LOGGER.debug(
            `[ExchangeDeactivated] - This datatoken does not contain this service. Invalid service id!`
          )
          return null
        }
        const { stats } = ddoInstance.getAssetFields().indexedMetadata
        stats.push({
          datatokenAddress,
          name: await datatokenContract.name(),
          symbol: await datatokenContract.symbol(),
          serviceId: serviceIdToFind,
          orders: 0,
          prices: await getPricesByDt(datatokenContract, signer)
        })

        ddoInstance.updateFields({ indexedMetadata: { stats } })
      }

      const savedDDO = await this.createOrUpdateDDO(
        ddoInstance,
        EVENTS.EXCHANGE_DEACTIVATED
      )
      return savedDDO
    } catch (err) {
      this.rethrowIfProviderError(err)
      INDEXER_LOGGER.error(`Error retrieving DDO: ${err}`)
    }
  }
}
