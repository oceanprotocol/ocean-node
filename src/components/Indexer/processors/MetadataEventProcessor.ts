import { DDOManager, DDO, VersionedDDO } from '@oceanprotocol/ddo-js'
import { ethers, Signer, FallbackProvider, getAddress } from 'ethers'
import {
  ENVIRONMENT_VARIABLES,
  EVENTS,
  MetadataStates
} from '../../../utils/constants.js'
import { deleteIndexedMetadataIfExists } from '../../../utils/asset.js'

import { checkCredentialOnAccessList } from '../../../utils/credentials.js'

import { INDEXER_LOGGER } from '../../../utils/logging/common.js'
import { errorSummary } from '../../../utils/logging/redact.js'
import { asyncCallWithTimeout } from '../../../utils/util.js'
import { PolicyServer } from '../../policyServer/index.js'
import { wasNFTDeployedByOurFactory, getPricingStatsForDddo, getDid } from '../utils.js'
import { BaseEventProcessor } from './BaseProcessor.js'
import ERC721Template from '@oceanprotocol/contracts/artifacts/contracts/templates/ERC721Template.sol/ERC721Template.json' with { type: 'json' }
import { Purgatory } from '../purgatory.js'

export class MetadataEventProcessor extends BaseEventProcessor {
  async processEvent(
    event: ethers.Log,
    chainId: number,
    signer: Signer,
    provider: FallbackProvider,
    eventName: string
  ): Promise<any> {
    let did = 'did:op'
    try {
      const { ddo: ddoDatabase, ddoState } = await this.getDatabase()
      const wasDeployedByUs = await wasNFTDeployedByOurFactory(
        chainId,
        signer,
        getAddress(event.address)
      )

      if (!wasDeployedByUs) {
        INDEXER_LOGGER.debug(
          `NFT ${event.address} not deployed by OPF factory (chain ${chainId}, tx ${event.transactionHash})`
        )
        return
      }
      const decodedEventData = await this.getEventData(
        provider,
        event.transactionHash,
        ERC721Template.abi,
        eventName
      )

      const metadata = decodedEventData.args[4]
      const metadataHash = decodedEventData.args[5]
      const flag = decodedEventData.args[3]
      const owner = decodedEventData.args[0]

      const dataNftAddress = ethers.getAddress(event.address)

      did = getDid(event.address, chainId)

      const templateContract = new ethers.Contract(
        dataNftAddress,
        ERC721Template.abi,
        signer
      )
      const metaData = await templateContract.getMetaData()
      const metadataState = Number(metaData[2])

      if ([MetadataStates.DEPRECATED, MetadataStates.REVOKED].includes(metadataState)) {
        INDEXER_LOGGER.debug(
          `Delete DDO ${did} because Metadata state is ${metadataState}`
        )
        const { ddo: ddoDatabase } = await this.getDatabase()
        const ddo = await ddoDatabase.retrieve(did)
        if (!ddo) {
          INDEXER_LOGGER.debug(
            `Detected MetadataState changed for ${did}, but it does not exists.`
          )
          return
        }

        const ddoInstance = DDOManager.getDDOClass(ddo)

        INDEXER_LOGGER.debug(
          `DDO ${did} became non-visible from ${
            ddoInstance.getAssetFields().indexedMetadata.nft.state
          } to ${metadataState}`
        )

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

      const ddo = await this.decryptDDO(
        decodedEventData.args[2],
        flag,
        owner,
        event.address,
        chainId,
        event.transactionHash,
        metadataHash,
        metadata
      )
      const clonedDdo = structuredClone(ddo)
      const updatedDdo = deleteIndexedMetadataIfExists(clonedDdo)
      const ddoInstance = DDOManager.getDDOClass(updatedDdo)
      if (updatedDdo.id !== ddoInstance.makeDid(event.address, chainId.toString(10))) {
        INDEXER_LOGGER.debug(
          `Decrypted DDO ID ${updatedDdo.id} does not match generated DID ${did} (tx ${event.transactionHash})`
        )
        await ddoState.update(
          this.networkId,
          did,
          event.address,
          event.transactionHash,
          false,
          'Decrypted DDO ID does not match generated DID.'
        )
        return
      }
      // for unencrypted DDOs
      if ((parseInt(flag) & 2) === 0 && !this.checkDdoHash(updatedDdo, metadataHash)) {
        INDEXER_LOGGER.debug(
          `Unencrypted DDO hash does not match metadata hash for ${did} (tx ${event.transactionHash})`
        )
        await ddoState.update(
          this.networkId,
          did,
          event.address,
          event.transactionHash,
          false,
          'Unencrypted DDO hash does not match metadata hash.'
        )
        return
      }

      // check authorized publishers
      const { authorizedPublishers, authorizedPublishersList } = this.getConfig()
      if (authorizedPublishers.length > 0) {
        const ownerNormalized = getAddress(String(owner))
        const authorized: string[] = authorizedPublishers.filter(
          (address) => getAddress(address).toLowerCase() === ownerNormalized.toLowerCase()
        )
        if (!authorized.length) {
          INDEXER_LOGGER.debug(
            `DDO owner ${owner} is NOT part of the ${ENVIRONMENT_VARIABLES.AUTHORIZED_PUBLISHERS.name} group (${did})`
          )
          await ddoState.update(
            this.networkId,
            did,
            event.address,
            event.transactionHash,
            false,
            `DDO owner ${owner} is NOT part of the ${ENVIRONMENT_VARIABLES.AUTHORIZED_PUBLISHERS.name} group.`
          )
          return
        }
      }
      if (authorizedPublishersList) {
        // check accessList
        const isAuthorized = await checkCredentialOnAccessList(
          authorizedPublishersList,
          String(chainId),
          owner,
          signer
        )
        if (!isAuthorized) {
          INDEXER_LOGGER.debug(
            `DDO owner ${owner} is NOT part of the ${ENVIRONMENT_VARIABLES.AUTHORIZED_PUBLISHERS_LIST.name} access group (${did})`
          )
          await ddoState.update(
            this.networkId,
            did,
            event.address,
            event.transactionHash,
            false,
            `DDO owner ${owner} is NOT part of the ${ENVIRONMENT_VARIABLES.AUTHORIZED_PUBLISHERS_LIST.name} access group.`
          )
          return
        }
      }

      // stuff that we overwrite
      did = ddoInstance.getDid()
      const { services } = ddoInstance.getDDOFields()
      ddoInstance.updateFields({
        chainId,
        nftAddress: event.address,
        datatokens: await this.getTokenInfo(services, signer)
      })

      INDEXER_LOGGER.debug(
        `Processed new DDO data ${ddoInstance.getDid()} with txHash ${
          event.transactionHash
        } from block ${event.blockNumber}`
      )

      let previousDdoInstance
      const previousDdo = await ddoDatabase.retrieve(ddoInstance.getDid())
      if (previousDdo) {
        previousDdoInstance = DDOManager.getDDOClass(previousDdo)
      }

      if (eventName === EVENTS.METADATA_CREATED) {
        if (
          previousDdoInstance &&
          previousDdoInstance.getAssetFields().indexedMetadata.nft.state ===
            MetadataStates.ACTIVE
        ) {
          const previousTxId =
            previousDdoInstance.getAssetFields().indexedMetadata?.event?.txid
          // If it's the same transaction being reprocessed, just skip (idempotent)
          if (previousTxId === event.transactionHash) {
            INDEXER_LOGGER.debug(
              `DDO ${ddoInstance.getDid()} already indexed from same transaction ${
                event.transactionHash
              }. Skipping reprocessing.`
            )
            await ddoState.update(
              this.networkId,
              did,
              event.address,
              event.transactionHash,
              true,
              ' '
            )
            return
          }
          INDEXER_LOGGER.debug(
            `DDO ${ddoInstance.getDid()} is already registered as active from different transaction ${previousTxId}`
          )
          await ddoState.update(
            this.networkId,
            did,
            event.address,
            event.transactionHash,
            false,
            `DDO ${ddoInstance.getDid()} is already registered as active from transaction ${previousTxId}`
          )
          return
        }
      }

      if (eventName === EVENTS.METADATA_UPDATED) {
        if (!previousDdoInstance) {
          INDEXER_LOGGER.debug(
            `Previous DDO with did ${ddoInstance.getDid()} was not found the database`
          )
          return
        }
        const [isUpdateable, error] = this.isUpdateable(
          previousDdoInstance,
          event.transactionHash,
          event.blockNumber
        )
        if (!isUpdateable) {
          INDEXER_LOGGER.debug(`DDO ${did} not eligible for update: ${error}`)
          await ddoState.update(
            this.networkId,
            did,
            event.address,
            event.transactionHash,
            false,
            error
          )
          return
        }
      }
      const from = decodedEventData.args[0].toString()
      let ddoUpdatedWithPricing

      // we need to store the event data (either metadata created or update and is updatable)
      if (
        [EVENTS.METADATA_CREATED, EVENTS.METADATA_UPDATED].includes(eventName) &&
        this.isValidDtAddressFromServices(ddoInstance.getDDOFields().services)
      ) {
        const ddoWithPricing = await getPricingStatsForDddo(ddoInstance, signer)
        const nft = await this.getNFTInfo(
          ddoWithPricing.getDDOFields().nftAddress,
          signer,
          owner,
          parseInt(decodedEventData.args[6])
        )

        let block
        let datetime
        if (event.blockNumber) {
          block = event.blockNumber
          // try get block & timestamp from block (only wait 2.5 secs maximum)
          const promiseFn = provider.getBlock(event.blockNumber)
          const result = await asyncCallWithTimeout(promiseFn, 2500)
          if (result.data !== null && !result.timeout) {
            datetime = new Date(result.data.timestamp * 1000).toJSON()
          }
        }

        const fieldsToUpdate = {
          indexedMetadata: {
            nft,
            event: {
              txid: event.transactionHash,
              from,
              contract: event.address,
              block,
              datetime
            }
          }
        }
        ddoWithPricing.updateFields(fieldsToUpdate)

        // policyServer check
        const policyServer = new PolicyServer()
        let policyStatus
        if (eventName === EVENTS.METADATA_UPDATED)
          policyStatus = await policyServer.checkUpdateDDO(
            ddoWithPricing.getDDOData() as DDO,
            this.networkId,
            event.transactionHash,
            event
          )
        else
          policyStatus = await policyServer.checknewDDO(
            ddoWithPricing.getDDOData() as DDO,
            this.networkId,
            event.transactionHash,
            event
          )
        if (!policyStatus.success) {
          INDEXER_LOGGER.debug(
            `DDO ${did} rejected by policy server (tx ${event.transactionHash}): ${policyStatus.message}`
          )
          await ddoState.update(
            this.networkId,
            did,
            event.address,
            event.transactionHash,
            false,
            policyStatus.message
          )
          return
        }
        ddoUpdatedWithPricing = ddoWithPricing
      }
      // always call, but only create instance once
      const purgatory = Purgatory.getInstance(this.getConfig())
      // if purgatory is disabled just return false
      const updatedDDO = await this.updatePurgatoryStateDdo(
        ddoUpdatedWithPricing,
        from,
        purgatory
      )
      if (updatedDDO.getAssetFields().indexedMetadata.purgatory.state === false) {
        // TODO: insert in a different collection for purgatory DDOs
        const saveDDO = await this.createOrUpdateDDO(ddoUpdatedWithPricing, eventName)
        return saveDDO
      }
      INDEXER_LOGGER.debug(
        `DDO ${did} is in purgatory, not stored (tx ${event.transactionHash})`
      )
    } catch (error) {
      this.rethrowIfProviderError(error)
      const { ddoState } = await this.getDatabase()
      await ddoState.update(
        this.networkId,
        did,
        event.address,
        event.transactionHash,
        false,
        error.message
      )
      INDEXER_LOGGER.warn(
        `Chain ${chainId}: failed to index ${did} (tx ${event.transactionHash}): ${errorSummary(error)}`
      )
    }
  }

  async updatePurgatoryStateDdo(
    ddo: VersionedDDO,
    owner: string,
    purgatory: Purgatory
  ): Promise<VersionedDDO> {
    if (!purgatory.isEnabled()) {
      ddo.updateFields({
        indexedMetadata: {
          purgatory: {
            state: false
          }
        }
      })

      return ddo
    }

    const state: boolean =
      (await purgatory.isBannedAsset(ddo.getDid())) ||
      (await purgatory.isBannedAccount(owner))
    ddo.updateFields({
      indexedMetadata: {
        purgatory: {
          state
        }
      }
    })

    return ddo
  }

  isUpdateable(
    previousDdo: VersionedDDO,
    txHash: string,
    block: number
  ): [boolean, string] {
    let errorMsg: string
    const ddoTxId = previousDdo.getAssetFields().indexedMetadata?.event?.txid
    // do not update if we have the same txid
    if (txHash === ddoTxId) {
      errorMsg = `Previous DDO has the same tx id, no need to update: event-txid=${txHash} <> asset-event-txid=${ddoTxId}`
      INDEXER_LOGGER.debug(errorMsg)
      return [false, errorMsg]
    }
    const ddoBlock = previousDdo.getAssetFields().indexedMetadata?.event?.block
    // do not update if we have the same block
    if (block === ddoBlock) {
      errorMsg = `Asset was updated later (block: ${ddoBlock}) vs transaction block: ${block}`
      INDEXER_LOGGER.debug(errorMsg)
      return [false, errorMsg]
    }

    return [true, '']
  }
}
