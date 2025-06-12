import { DDOManager, DDO, VersionedDDO } from '@oceanprotocol/ddo-js'
import { ethers, Signer, JsonRpcApiProvider, getAddress } from 'ethers'
import {
  ENVIRONMENT_VARIABLES,
  EVENTS,
  MetadataStates
} from '../../../utils/constants.js'
import { deleteIndexedMetadataIfExists } from '../../../utils/asset.js'
import { getConfiguration } from '../../../utils/config.js'
import { checkCredentialOnAccessList } from '../../../utils/credentials.js'
import { getDatabase } from '../../../utils/database.js'
import { INDEXER_LOGGER } from '../../../utils/logging/common.js'
import { LOG_LEVELS_STR } from '../../../utils/logging/Logger.js'
import { asyncCallWithTimeout } from '../../../utils/util.js'
import { PolicyServer } from '../../policyServer/index.js'
import { wasNFTDeployedByOurFactory, getPricingStatsForDddo } from '../utils.js'
import { BaseEventProcessor } from './BaseProcessor.js'
import ERC721Template from '@oceanprotocol/contracts/artifacts/contracts/templates/ERC721Template.sol/ERC721Template.json' assert { type: 'json' }
import { Purgatory } from '../purgatory.js'

export class MetadataEventProcessor extends BaseEventProcessor {
  async processEvent(
    event: ethers.Log,
    chainId: number,
    signer: Signer,
    provider: JsonRpcApiProvider,
    eventName: string
  ): Promise<any> {
    let did = 'did:op'
    try {
      const { ddo: ddoDatabase, ddoState } = await getDatabase()
      const wasDeployedByUs = await wasNFTDeployedByOurFactory(
        chainId,
        signer,
        getAddress(event.address)
      )

      if (!wasDeployedByUs) {
        INDEXER_LOGGER.log(
          LOG_LEVELS_STR.LEVEL_ERROR,
          `NFT not deployed by OPF factory`,
          true
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
      INDEXER_LOGGER.logMessage(`clonedDdo: ${JSON.stringify(clonedDdo)}`)
      const updatedDdo = deleteIndexedMetadataIfExists(clonedDdo)
      const ddoInstance = DDOManager.getDDOClass(updatedDdo)
      if (updatedDdo.id !== ddoInstance.makeDid(event.address, chainId.toString(10))) {
        INDEXER_LOGGER.error(
          `Decrypted DDO ID is not matching the generated hash for DID.`
        )
        return
      }
      // for unencrypted DDOs
      if (parseInt(flag) !== 2 && !this.checkDdoHash(updatedDdo, metadataHash)) {
        return
      }

      // check authorized publishers
      const { authorizedPublishers, authorizedPublishersList } = await getConfiguration()
      if (authorizedPublishers.length > 0) {
        // if is not there, do not index
        const authorized: string[] = authorizedPublishers.filter((address) =>
          // do a case insensitive search
          address.toLowerCase().includes(owner.toLowerCase())
        )
        if (!authorized.length) {
          INDEXER_LOGGER.error(
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
          INDEXER_LOGGER.error(
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

      INDEXER_LOGGER.logMessage(
        `Processed new DDO data ${ddoInstance.getDid()} with txHash ${
          event.transactionHash
        } from block ${event.blockNumber}`,
        true
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
          INDEXER_LOGGER.logMessage(
            `DDO ${ddoInstance.getDid()} is already registered as active`,
            true
          )
          await ddoState.update(
            this.networkId,
            did,
            event.address,
            event.transactionHash,
            false,
            `DDO ${ddoInstance.getDid()} is already registered as active`
          )
          return
        }
      }

      if (eventName === EVENTS.METADATA_UPDATED) {
        if (!previousDdoInstance) {
          INDEXER_LOGGER.logMessage(
            `Previous DDO with did ${ddoInstance.getDid()} was not found the database. Maybe it was deleted/hidden to some violation issues`,
            true
          )
          await ddoState.update(
            this.networkId,
            did,
            event.address,
            event.transactionHash,
            false,
            `Previous DDO with did ${ddoInstance.getDid()} was not found the database. Maybe it was deleted/hidden to some violation issues`
          )
          return
        }
        const [isUpdateable, error] = this.isUpdateable(
          previousDdoInstance,
          event.transactionHash,
          event.blockNumber
        )
        if (!isUpdateable) {
          INDEXER_LOGGER.error(
            `Error encountered when checking if the asset is eligiable for update: ${error}`
          )
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
      const purgatory = await Purgatory.getInstance()
      // if purgatory is disabled just return false
      const updatedDDO = await this.updatePurgatoryStateDdo(
        ddoUpdatedWithPricing,
        from,
        purgatory
      )
      if (updatedDDO.getAssetFields().indexedMetadata.purgatory.state === false) {
        // TODO: insert in a different collection for purgatory DDOs
        const saveDDO = await this.createOrUpdateDDO(ddoUpdatedWithPricing, eventName)
        INDEXER_LOGGER.logMessage(`saved DDO: ${JSON.stringify(saveDDO)}`)
        return saveDDO
      }
    } catch (error) {
      const { ddoState } = await getDatabase()
      await ddoState.update(
        this.networkId,
        did,
        event.address,
        event.transactionHash,
        false,
        error.message
      )
      INDEXER_LOGGER.log(
        LOG_LEVELS_STR.LEVEL_ERROR,
        `Error processMetadataEvents: ${error}`,
        true
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
      INDEXER_LOGGER.log(LOG_LEVELS_STR.LEVEL_DEBUG, errorMsg, true)
      return [false, errorMsg]
    }
    const ddoBlock = previousDdo.getAssetFields().indexedMetadata?.event?.block
    // do not update if we have the same block
    if (block === ddoBlock) {
      errorMsg = `Asset was updated later (block: ${ddoBlock}) vs transaction block: ${block}`
      INDEXER_LOGGER.log(LOG_LEVELS_STR.LEVEL_DEBUG, errorMsg, true)
      return [false, errorMsg]
    }

    return [true, '']
  }
}
