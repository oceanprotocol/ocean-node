import { DDOManager } from '@oceanprotocol/ddo-js'
import { ethers, Signer, FallbackProvider } from 'ethers'
import { EVENTS } from '../../../utils/constants.js'
import { getDatabase } from '../../../utils/database.js'
import { INDEXER_LOGGER } from '../../../utils/logging/common.js'
import { LOG_LEVELS_STR } from '../../../utils/logging/Logger.js'
import {
  getDtContract,
  getDid,
  findServiceIdByDatatoken,
  getPricesByDt
} from '../utils.js'
import { BaseEventProcessor } from './BaseProcessor.js'
import ERC20Template from '@oceanprotocol/contracts/artifacts/contracts/templates/ERC20TemplateEnterprise.sol/ERC20TemplateEnterprise.json' with { type: 'json' }

export class OrderReusedEventProcessor extends BaseEventProcessor {
  async processEvent(
    event: ethers.Log,
    chainId: number,
    signer: Signer,
    provider: FallbackProvider
  ): Promise<any> {
    const decodedEventData = await this.getEventData(
      provider,
      event.transactionHash,
      ERC20Template.abi,
      EVENTS.ORDER_REUSED
    )
    const startOrderId = decodedEventData.args[0].toString()
    const timestamp = parseInt(decodedEventData.args[2].toString())
    const payer = decodedEventData.args[1].toString()
    INDEXER_LOGGER.logMessage(`Processed reused order at ${timestamp}`, true)

    const datatokenContract = getDtContract(signer, event.address)

    const nftAddress = await datatokenContract.getERC721Address()
    const did = getDid(nftAddress, chainId)
    try {
      const { ddo: ddoDatabase, order: orderDatabase } = await getDatabase()
      const ddo = await ddoDatabase.retrieve(did)
      if (!ddo) {
        INDEXER_LOGGER.logMessage(
          `Detected OrderReused changed for ${did}, but it does not exists.`
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
          if (stat.datatokenAddress.toLowerCase() === event.address?.toLowerCase()) {
            stat.orders += 1
            break
          }
        }
      } else {
        INDEXER_LOGGER.logMessage(`[OrderReused] - No stats were found on the ddo`)
        const serviceIdToFind = findServiceIdByDatatoken(ddoInstance, event.address)
        if (!serviceIdToFind) {
          INDEXER_LOGGER.logMessage(
            `[OrderReused] - This datatoken does not contain this service. Invalid service id!`
          )
          return
        }
        const existingStats = ddoInstance.getAssetFields().indexedMetadata.stats
        existingStats.push({
          datatokenAddress: event.address,
          name: await datatokenContract.name(),
          symbol: await datatokenContract.symbol(),
          serviceId: serviceIdToFind,
          orders: 1,
          prices: await getPricesByDt(datatokenContract, signer)
        })

        ddoInstance.updateFields({
          indexedMetadata: {
            stats: existingStats
          }
        })
      }

      try {
        const startOrder = await orderDatabase.retrieve(startOrderId)
        if (!startOrder) {
          INDEXER_LOGGER.logMessage(
            `Detected OrderReused changed for order ${startOrderId}, but it does not exists.`
          )
          return
        }
        await orderDatabase.create(
          event.transactionHash,
          'reuseOrder',
          timestamp,
          startOrder.consumer,
          payer,
          event.address,
          nftAddress,
          did,
          startOrderId
        )
      } catch (error) {
        INDEXER_LOGGER.log(
          LOG_LEVELS_STR.LEVEL_ERROR,
          `Error retrieving startOrder for reuseOrder: ${error}`,
          true
        )
      }

      const savedDDO = await this.createOrUpdateDDO(ddoInstance, EVENTS.ORDER_REUSED)
      return savedDDO
    } catch (err) {
      INDEXER_LOGGER.log(LOG_LEVELS_STR.LEVEL_ERROR, `Error retrieving DDO: ${err}`, true)
    }
  }
}
