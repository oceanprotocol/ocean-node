import { DDOManager } from '@oceanprotocol/ddo-js'
import { ethers, Signer, FallbackProvider, ZeroAddress } from 'ethers'
import { EVENTS } from '../../../utils/constants.js'
import { INDEXER_LOGGER } from '../../../utils/logging/common.js'
import {
  getDtContract,
  getDid,
  doesDispenserAlreadyExist,
  findServiceIdByDatatoken,
  getPricesByDt,
  isValidDispenserContract
} from '../utils.js'
import { BaseEventProcessor } from './BaseProcessor.js'
import Dispenser from '@oceanprotocol/contracts/artifacts/contracts/pools/dispenser/Dispenser.sol/Dispenser.json' with { type: 'json' }

export class DispenserDeactivatedEventProcessor extends BaseEventProcessor {
  async processEvent(
    event: ethers.Log,
    chainId: number,
    signer: Signer,
    provider: FallbackProvider
  ): Promise<any> {
    const decodedEventData = await this.getEventData(
      provider,
      event.transactionHash,
      Dispenser.abi,
      EVENTS.DISPENSER_DEACTIVATED
    )
    const datatokenAddress = decodedEventData.args[0].toString()
    if (!datatokenAddress) {
      INDEXER_LOGGER.debug(
        `Datatoken address not found in decoded event (tx ${event.transactionHash})`
      )
      return null
    }
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
          `Detected DispenserDeactivated changed for ${did}, but it does not exists.`
        )
        return
      }
      if (!(await isValidDispenserContract(event.address, chainId, signer))) {
        INDEXER_LOGGER.debug(
          `Dispenser contract ${event.address} is not approved by Router, DDO pricing not updated`
        )
        return ddo
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
            doesDispenserAlreadyExist(event.address, stat.prices)[0]
          ) {
            const price = doesDispenserAlreadyExist(event.address, stat.prices)[1]
            const index = stat.prices.indexOf(price)
            stat.prices.splice(index, 1)
            break
          } else if (
            stat.datatokenAddress.toLowerCase() === datatokenAddress.toLowerCase() &&
            !doesDispenserAlreadyExist(event.address, stat.prices)[0]
          ) {
            INDEXER_LOGGER.debug(
              `Detected DispenserDeactivated changed for ${event.address}, but dispenser does not exist in the DDO pricing.`
            )
            break
          }
        }
      } else {
        INDEXER_LOGGER.debug(`[DispenserDeactivated] - No stats were found on the ddo`)
        const serviceIdToFind = findServiceIdByDatatoken(ddoInstance, datatokenAddress)
        if (!serviceIdToFind) {
          INDEXER_LOGGER.debug(
            `[DispenserDeactivated] - This datatoken does not contain this service. Invalid service id!`
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
        EVENTS.DISPENSER_DEACTIVATED
      )
      return savedDDO
    } catch (err) {
      this.rethrowIfProviderError(err)
      INDEXER_LOGGER.error(`Error retrieving DDO: ${err}`)
    }
  }
}
