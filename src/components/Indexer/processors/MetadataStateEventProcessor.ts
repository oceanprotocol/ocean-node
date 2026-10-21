import { DDOManager } from '@oceanprotocol/ddo-js'
import { ethers, Signer, FallbackProvider } from 'ethers'
import { EVENTS, MetadataStates } from '../../../utils/constants.js'
import { INDEXER_LOGGER } from '../../../utils/logging/common.js'
import { BaseEventProcessor } from './BaseProcessor.js'
import ERC721Template from '@oceanprotocol/contracts/artifacts/contracts/templates/ERC721Template.sol/ERC721Template.json' with { type: 'json' }
import { getDid } from '../utils.js'

export class MetadataStateEventProcessor extends BaseEventProcessor {
  async processEvent(
    event: ethers.Log,
    chainId: number,
    _signer: Signer,
    provider: FallbackProvider
  ): Promise<any> {
    INDEXER_LOGGER.debug(`Processing metadata state event...`)
    const decodedEventData = await this.getEventData(
      provider,
      event.transactionHash,
      ERC721Template.abi,
      EVENTS.METADATA_STATE
    )
    const metadataState = parseInt(decodedEventData.args[1].toString())
    INDEXER_LOGGER.debug(`Processed new metadata state ${metadataState} `)
    INDEXER_LOGGER.debug(`NFT address in processing MetadataState: ${event.address} `)
    const did = getDid(event.address, chainId)

    try {
      const { ddo: ddoDatabase } = await this.getDatabase()
      const ddo = await ddoDatabase.retrieve(did)
      if (!ddo) {
        INDEXER_LOGGER.debug(
          `Detected MetadataState changed for ${did}, but it does not exists.`
        )
        return
      }

      const ddoInstance = DDOManager.getDDOClass(ddo)
      INDEXER_LOGGER.debug(`Found did ${did} on network ${chainId}`)

      if (
        'nft' in ddoInstance.getAssetFields().indexedMetadata &&
        ddoInstance.getAssetFields().indexedMetadata.nft.state !== metadataState
      ) {
        if (
          ddoInstance.getAssetFields().indexedMetadata.nft.state ===
            MetadataStates.ACTIVE &&
          [MetadataStates.REVOKED, MetadataStates.DEPRECATED].includes(metadataState)
        ) {
          INDEXER_LOGGER.debug(
            `DDO became non-visible from ${
              ddoInstance.getAssetFields().indexedMetadata.nft.state
            } to ${metadataState}`
          )

          // We should keep it here, because in further development we'll store
          // the previous structure of the non-visible DDOs (full version)
          // in case their state changes back to active.
          const shortDdoInstance = DDOManager.getDDOClass({
            id: ddo.id,
            version: 'deprecated',
            chainId,
            nftAddress: ddo.nftAddress,
            indexedMetadata: {
              nft: {
                state: metadataState
              }
            }
          })

          const savedDDO = await this.createOrUpdateDDO(
            shortDdoInstance,
            EVENTS.METADATA_STATE
          )
          return savedDDO
        }
      }

      // Still update until we validate and polish schemas for DDO.
      // But it should update ONLY if the first condition is met.
      // Check https://github.com/oceanprotocol/aquarius/blob/84a560ea972485e46dd3c2cfc3cdb298b65d18fa/aquarius/events/processors.py#L663
      ddoInstance.getDDOData().indexedMetadata.nft = {
        state: metadataState
      }
      INDEXER_LOGGER.debug(`Found did ${did} for state updating on network ${chainId}`)
      const savedDDO = await this.createOrUpdateDDO(ddoInstance, EVENTS.METADATA_STATE)
      return savedDDO
    } catch (err) {
      this.rethrowIfProviderError(err)
      INDEXER_LOGGER.error(`Error retrieving DDO: ${err}`)
    }
  }
}
