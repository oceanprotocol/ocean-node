import { DDOManager } from '@oceanprotocol/ddo-js'
import { ethers, Signer, JsonRpcApiProvider } from 'ethers'
import { EVENTS } from '../../../utils/constants.js'
import { getDatabase } from '../../../utils/database.js'
import { INDEXER_LOGGER } from '../../../utils/logging/common.js'
import { LOG_LEVELS_STR } from '../../../utils/logging/Logger.js'
import { getDtContract, getDid, getPricesByDt } from '../utils.js'
import { BaseEventProcessor } from './BaseProcessor.js'
import ERC20Template from '@oceanprotocol/contracts/artifacts/contracts/templates/ERC20TemplateEnterprise.sol/ERC20TemplateEnterprise.json' with { type: 'json' }

export class OrderStartedEventProcessor extends BaseEventProcessor {
  async processEvent(
    event: ethers.Log,
    chainId: number,
    signer: Signer,
    provider: JsonRpcApiProvider
  ): Promise<any> {
    const decodedEventData = await this.getEventData(
      provider,
      event.transactionHash,
      ERC20Template.abi,
      EVENTS.ORDER_STARTED
    )
    const serviceIndex = parseInt(decodedEventData.args[3].toString())
    const timestamp = parseInt(decodedEventData.args[4].toString())
    const consumer = decodedEventData.args[0].toString()
    const payer = decodedEventData.args[1].toString()
    INDEXER_LOGGER.logMessage(
      `Processed new order for service index ${serviceIndex} at ${timestamp}`,
      true
    )
    const datatokenContract = getDtContract(signer, event.address)

    const nftAddress = await datatokenContract.getERC721Address()
    const did = getDid(nftAddress, chainId)
    try {
      const { ddo: ddoDatabase, order: orderDatabase } = await getDatabase()
      const ddo = await ddoDatabase.retrieve(did)
      if (!ddo) {
        INDEXER_LOGGER.logMessage(
          `Detected OrderStarted changed for ${did}, but it does not exists.`
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

      if (
        ddoInstance.getAssetFields().indexedMetadata.stats.length !== 0 &&
        ddoInstance
          .getDDOFields()
          .services[serviceIndex].datatokenAddress?.toLowerCase() ===
          event.address?.toLowerCase()
      ) {
        for (const stat of ddoInstance.getAssetFields().indexedMetadata.stats) {
          if (stat.datatokenAddress.toLowerCase() === event.address?.toLowerCase()) {
            stat.orders += 1
            break
          }
        }
      } else if (ddoInstance.getAssetFields().indexedMetadata.stats.length === 0) {
        const existingStats = ddoInstance.getAssetFields().indexedMetadata.stats
        existingStats.push({
          datatokenAddress: event.address,
          name: await datatokenContract.name(),
          symbol: await datatokenContract.symbol(),
          serviceId: ddoInstance.getDDOFields().services[serviceIndex].id,
          orders: 1,
          prices: await getPricesByDt(datatokenContract, signer)
        })

        ddoInstance.updateFields({ indexedMetadata: { stats: existingStats } })
      }
      await orderDatabase.create(
        event.transactionHash,
        'startOrder',
        timestamp,
        consumer,
        payer,
        ddoInstance.getDDOFields().services[serviceIndex].datatokenAddress,
        nftAddress,
        did
      )
      INDEXER_LOGGER.logMessage(
        `Found did ${did} for order starting on network ${chainId}`
      )
      const savedDDO = await this.createOrUpdateDDO(ddoInstance, EVENTS.ORDER_STARTED)
      return savedDDO
    } catch (err) {
      INDEXER_LOGGER.log(LOG_LEVELS_STR.LEVEL_ERROR, `Error retrieving DDO: ${err}`, true)
    }
  }
}
