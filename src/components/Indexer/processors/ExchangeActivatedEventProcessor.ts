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

export class ExchangeActivatedEventProcessor extends BaseEventProcessor {
  async processEvent(
    event: ethers.Log,
    chainId: number,
    signer: Signer,
    provider: FallbackProvider
  ): Promise<any> {
    try {
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
        EVENTS.EXCHANGE_ACTIVATED
      )
      const exchangeId = decodedEventData.args[0].toString()
      const freContract = new ethers.Contract(
        event.address,
        FixedRateExchange.abi,
        signer
      )
      const exchange = await freContract.getExchange(exchangeId)

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

      const { ddo: ddoDatabase } = await this.getDatabase()
      const ddo = await ddoDatabase.retrieve(did)
      if (!ddo) {
        INDEXER_LOGGER.debug(
          `Detected ExchangeActivated changed for ${did}, but it does not exists.`
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
            !doesFreAlreadyExist(exchangeId, stat.prices)[0]
          ) {
            stat.prices.push({
              type: 'fixedrate',
              price: ethers.formatEther(exchange[5]),
              contract: event.address,
              token: exchange[3],
              exchangeId
            })
            break
          } else if (doesFreAlreadyExist(event.address, stat.prices)[0]) {
            break
          }
        }
      } else {
        INDEXER_LOGGER.debug(`[ExchangeActivated] - No stats were found on the ddo`)
        const serviceIdToFind = findServiceIdByDatatoken(ddoInstance, datatokenAddress)
        if (!serviceIdToFind) {
          INDEXER_LOGGER.debug(
            `[ExchangeActivated] - This datatoken does not contain this service. Invalid service id!`
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
        EVENTS.EXCHANGE_ACTIVATED
      )
      return savedDDO
    } catch (err) {
      this.rethrowIfProviderError(err)
      INDEXER_LOGGER.error(`Error retrieving DDO: ${err}`)
    }
  }
}
