import { ethers, Signer, FallbackProvider, Interface, getAddress } from 'ethers'
import { BlocksEvents, ProcessingEvents } from '../../@types/blockchain.js'
import { EVENTS } from '../../utils/constants.js'
import { getConfiguration } from '../../utils/config.js'
import { INDEXER_LOGGER } from '../../utils/logging/common.js'
import { LOG_LEVELS_STR } from '../../utils/logging/Logger.js'
import { fetchEventFromTransaction } from '../../utils/util.js'
import {
  BaseEventProcessor,
  MetadataEventProcessor,
  MetadataStateEventProcessor,
  OrderStartedEventProcessor,
  OrderReusedEventProcessor,
  DispenserCreatedEventProcessor,
  DispenserActivatedEventProcessor,
  DispenserDeactivatedEventProcessor,
  ExchangeCreatedEventProcessor,
  ExchangeActivatedEventProcessor,
  ExchangeDeactivatedEventProcessor,
  ExchangeRateChangedEventProcessor,
  ProcessorConstructor
} from './processors/index.js'
import { findEventByKey } from './utils.js'
import ERC20Template from '@oceanprotocol/contracts/artifacts/contracts/templates/ERC20TemplateEnterprise.sol/ERC20TemplateEnterprise.json' with { type: 'json' }
import AccessListContract from '@oceanprotocol/contracts/artifacts/contracts/accesslists/AccessList.sol/AccessList.json' with { type: 'json' }

const EVENT_PROCESSOR_MAP: Record<string, ProcessorConstructor> = {
  [EVENTS.METADATA_CREATED]: MetadataEventProcessor,
  [EVENTS.METADATA_UPDATED]: MetadataEventProcessor,
  [EVENTS.METADATA_STATE]: MetadataStateEventProcessor,
  [EVENTS.ORDER_STARTED]: OrderStartedEventProcessor,
  [EVENTS.ORDER_REUSED]: OrderReusedEventProcessor,
  [EVENTS.DISPENSER_CREATED]: DispenserCreatedEventProcessor,
  [EVENTS.DISPENSER_ACTIVATED]: DispenserActivatedEventProcessor,
  [EVENTS.DISPENSER_DEACTIVATED]: DispenserDeactivatedEventProcessor,
  [EVENTS.EXCHANGE_CREATED]: ExchangeCreatedEventProcessor,
  [EVENTS.EXCHANGE_ACTIVATED]: ExchangeActivatedEventProcessor,
  [EVENTS.EXCHANGE_DEACTIVATED]: ExchangeDeactivatedEventProcessor,
  [EVENTS.EXCHANGE_RATE_CHANGED]: ExchangeRateChangedEventProcessor
}

const processorInstances = new Map<string, BaseEventProcessor>()

function getEventProcessor(eventType: string, chainId: number): BaseEventProcessor {
  const cacheKey = `${eventType}-${chainId}`

  if (!processorInstances.has(cacheKey)) {
    const ProcessorClass = EVENT_PROCESSOR_MAP[eventType]
    if (!ProcessorClass) {
      throw new Error(`No processor found for event type: ${eventType}`)
    }
    processorInstances.set(cacheKey, new ProcessorClass(chainId))
  }

  return processorInstances.get(cacheKey)
}

export const processChunkLogs = async (
  logs: readonly ethers.Log[],
  signer: Signer,
  provider: FallbackProvider,
  chainId: number
): Promise<BlocksEvents> => {
  const storeEvents: BlocksEvents = {}
  if (logs.length > 0) {
    const { allowedValidators, allowedValidatorsList } = await getConfiguration() //  getAllowedValidators()
    const checkMetadataValidated =
      allowedValidators.length > 0 ||
      (allowedValidatorsList && Object.keys(allowedValidatorsList).length > 0)
    for (const log of logs) {
      const event = findEventByKey(log.topics[0])

      if (event && Object.values(EVENTS).includes(event.type)) {
        // only log & process the ones we support
        INDEXER_LOGGER.logMessage(
          `-- ${event.type} -- triggered for ${log.transactionHash}`,
          true
        )
        if (
          event.type === EVENTS.METADATA_CREATED ||
          event.type === EVENTS.METADATA_UPDATED ||
          event.type === EVENTS.METADATA_STATE
        ) {
          // ref: https://github.com/oceanprotocol/ocean-node/issues/257
          if (checkMetadataValidated) {
            const txReceipt = await provider.getTransactionReceipt(log.transactionHash)
            const metadataProofs = fetchEventFromTransaction(
              txReceipt,
              'MetadataValidated',
              new Interface(ERC20Template.abi)
            )
            if (!metadataProofs) {
              INDEXER_LOGGER.log(
                LOG_LEVELS_STR.LEVEL_ERROR,
                `Metadata Proof validator not allowed`,
                true
              )
              continue
              // do not process this one
            }
            const validators: string[] = metadataProofs.map((metadataProof) =>
              getAddress(metadataProof.args[0].toString())
            )
            // ALLOWED_VALIDATORS CHECK
            const allowed = allowedValidators.filter(
              (allowedValidator) => validators.indexOf(allowedValidator) !== -1
            )
            if (!allowed.length) {
              INDEXER_LOGGER.log(
                LOG_LEVELS_STR.LEVEL_ERROR,
                `Metadata Proof validators list is empty. Block/event for tx ${log.transactionHash} was NOT processed due to no allowed validators.`,
                true
              )
              continue
              // do not process this one
            }
            // ALLOWED_VALIDATORS_LIST
            // by default it is OK
            let isAllowed = true
            if (allowedValidatorsList && validators.length > 0) {
              // need to check then
              isAllowed = false
              // check accessList
              const chainsListed = Object.keys(allowedValidatorsList)
              const chain = String(chainId)
              // check the access lists for this chain
              if (chainsListed.length > 0 && chainsListed.includes(chain)) {
                for (const accessListAddress of allowedValidatorsList[chain]) {
                  // instantiate contract and check balanceOf
                  const accessListContract = new ethers.Contract(
                    accessListAddress,
                    AccessListContract.abi,
                    signer
                  )
                  for (const metaproofValidator of validators) {
                    // if has at least 1 token than it is authorized
                    // its enough one validator on the list
                    const balance = await accessListContract.balanceOf(metaproofValidator)
                    if (Number(balance) <= 0) {
                      INDEXER_LOGGER.error(
                        `Metadata validator: ${metaproofValidator} is NOT part of the access list group: ${accessListAddress}.`
                      )
                    } else {
                      isAllowed = true
                      break
                    }
                  }
                }
              } else {
                isAllowed = true // no rules for this specific chain, so ignore this
              }
              // move on to the next (do not process this event)
              if (isAllowed === false) {
                INDEXER_LOGGER.log(
                  LOG_LEVELS_STR.LEVEL_ERROR,
                  `Block/event for tx ${log.transactionHash} was NOT processed because none of the metadata validators are part of the access list group(s) for chain ${chainId}.`,
                  true
                )
                continue
              }
            } // end if (allowedValidatorsList) {
          } // end if if (checkMetadataValidated) {
        }
        if (event.type === EVENTS.TOKEN_URI_UPDATE) {
          storeEvents[event.type] = 'TOKEN_URI_UPDATE'
        } else {
          const processor = getEventProcessor(event.type, chainId)
          storeEvents[event.type] = await processor.processEvent(
            log,
            chainId,
            signer,
            provider,
            event.type
          )
        }
      }
    }

    return storeEvents
  }

  return {}
}

export const processBlocks = async (
  blockLogs: ethers.Log[],
  signer: Signer,
  provider: FallbackProvider,
  network: number,
  lastIndexedBlock: number,
  count: number
): Promise<ProcessingEvents> => {
  try {
    const events: any[] | BlocksEvents =
      blockLogs && blockLogs.length > 0
        ? await processChunkLogs(blockLogs, signer, provider, network)
        : []

    return {
      lastBlock: lastIndexedBlock + count,
      foundEvents: events
    }
  } catch (error) {
    throw new Error(`Error processing chunk of blocks events ${error.message}`)
  }
}
