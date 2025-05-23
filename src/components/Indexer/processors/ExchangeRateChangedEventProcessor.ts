import { DDOManager } from '@oceanprotocol/ddo-js'
import { ethers, Signer, JsonRpcApiProvider } from 'ethers'
import { EVENTS } from '../../../utils/constants.js'
import { getDatabase } from '../../../utils/database.js'
import { INDEXER_LOGGER } from '../../../utils/logging/common.js'
import { LOG_LEVELS_STR } from '../../../utils/logging/Logger.js'
import {
  getDtContract,
  getDid,
  doesFreAlreadyExist,
  findServiceIdByDatatoken,
  getPricesByDt
} from '../utils.js'
import { BaseEventProcessor } from './BaseProcessor.js'
import FixedRateExchange from '@oceanprotocol/contracts/artifacts/contracts/pools/fixedRate/FixedRateExchange.sol/FixedRateExchange.json' assert { type: 'json' }

export class ExchangeRateChangedEventProcessor extends BaseEventProcessor {
  async processEvent(
    event: ethers.Log,
    chainId: number,
    signer: Signer,
    provider: JsonRpcApiProvider
  ): Promise<any> {
    const decodedEventData = await this.getEventData(
      provider,
      event.transactionHash,
      FixedRateExchange.abi,
      EVENTS.EXCHANGE_RATE_CHANGED
    )
    const exchangeId = ethers.toUtf8Bytes(decodedEventData.args[0].toString())
    const newRate = decodedEventData.args[2].toString()
    const freContract = new ethers.Contract(event.address, FixedRateExchange.abi, signer)
    const exchange = await freContract.getExchange(exchangeId)
    const datatokenAddress = exchange[1]
    const datatokenContract = getDtContract(signer, datatokenAddress)
    const nftAddress = await datatokenContract.getERC721Address()
    const did = getDid(nftAddress, chainId)
    try {
      const { ddo: ddoDatabase } = await getDatabase()
      const ddo = await ddoDatabase.retrieve(did)
      if (!ddo) {
        INDEXER_LOGGER.logMessage(
          `Detected ExchangeRateChanged changed for ${did}, but it does not exists.`
        )
        return
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
            price.price = newRate
            break
          } else if (
            stat.datatokenAddress.toLowerCase() === datatokenAddress.toLowerCase() &&
            !doesFreAlreadyExist(exchangeId, stat.prices)[0]
          ) {
            INDEXER_LOGGER.logMessage(
              `[ExchangeRateChanged] - Could not find the exchange in DDO ${did} prices`
            )
            return
          }
        }
      } else {
        INDEXER_LOGGER.logMessage(
          `[ExchangeRateChanged] - No stats were found on the ddo`
        )
        const serviceIdToFind = findServiceIdByDatatoken(ddoInstance, datatokenAddress)
        if (!serviceIdToFind) {
          INDEXER_LOGGER.logMessage(
            `[ExchangeRateChanged] - This datatoken does not contain this service. Invalid service id!`
          )
          return
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
        EVENTS.EXCHANGE_RATE_CHANGED
      )
      return savedDDO
    } catch (err) {
      INDEXER_LOGGER.log(LOG_LEVELS_STR.LEVEL_ERROR, `Error retrieving DDO: ${err}`, true)
    }
  }
}
