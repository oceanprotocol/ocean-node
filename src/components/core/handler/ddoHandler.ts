import { CommandHandler } from './handler.js'
import { OceanNode } from '../../../OceanNode.js'
import { EVENTS, MetadataStates, PROTOCOL_COMMANDS } from '../../../utils/constants.js'
import { P2PCommandResponse, FindDDOResponse } from '../../../@types/index.js'
import { Readable } from 'stream'
import { create256Hash } from '../../../utils/crypt.js'
import {
  hasCachedDDO,
  sortFindDDOResults,
  findDDOLocally,
  formatService
} from '../utils/findDdoHandler.js'
import { toString as uint8ArrayToString } from 'uint8arrays/to-string'
import { GENERIC_EMOJIS, LOG_LEVELS_STR } from '../../../utils/logging/Logger.js'
import {
  readStream,
  streamToUint8Array,
  fetchEventFromTransaction
} from '../../../utils/util.js'
import { P2P_TIMEOUTS } from '../../P2P/timeouts.js'
import { CORE_LOGGER } from '../../../utils/logging/common.js'
import { ethers, isAddress } from 'ethers'
import ERC721Template from '@oceanprotocol/contracts/artifacts/contracts/templates/ERC721Template.sol/ERC721Template.json' with { type: 'json' }
// import lzma from 'lzma-native'
import lzmajs from 'lzma-purejs-requirejs'

import { isPolicyServerConfigured } from '../../../utils/config.js'
import { PolicyServer } from '../../policyServer/index.js'
import {
  GetDdoCommand,
  FindDDOCommand,
  DecryptDDOCommand,
  ValidateDDOCommand
} from '../../../@types/commands.js'
import { EncryptMethod } from '../../../@types/fileObject.js'
import {
  ValidateParams,
  buildInvalidRequestMessage,
  validateCommandParameters
} from '../../httpRoutes/validateCommands.js'
import {
  findEventByKey,
  getNetworkHeight,
  wasNFTDeployedByOurFactory
} from '../../Indexer/utils.js'
import { deleteIndexedMetadataIfExists, validateDDOHash } from '../../../utils/asset.js'
import { Asset, DDO, DDOManager } from '@oceanprotocol/ddo-js'
import { checkCredentialOnAccessList } from '../../../utils/credentials.js'

const MAX_NUM_PROVIDERS = 5
// byte cap on one provider's getDDO response. A DDO is comfortably under a MiB in practice,
// so this leaves room for an unusually large one while refusing a peer that answers with a
// gigabyte. The shared reader's default is 64 MiB, which is a heap ceiling for any
// accumulating read rather than a statement about this payload.
const MAX_DDO_RESPONSE_BYTES = 4 * 1024 * 1024

/**
 * DDO ids that a recent FindDDO could not locate anywhere - not locally, and not at any
 * provider the DHT returned.
 *
 * The ids callers ask for are frequently ids that do not exist: a stale link, a client polling
 * for an asset that was never published, a retry loop around a 404. Each of those costs a
 * provider walk plus a query to every provider it turns up, and it costs every peer asked the
 * same. One remembered answer collapses a hot loop into one lookup.
 *
 * Two properties make this safe rather than a source of phantom 404s. It is consulted **after**
 * the local database lookup, never before, so a DDO this node holds is always returned whatever
 * the cache says - the cache can only ever skip the *network* half of the search. And an entry
 * is only ever written when the search found nothing at all, so an id that was found locally
 * cannot have an entry in the first place.
 *
 * Module-level, like the P2P counters and the resolution cache, and for the same reason: one
 * node process, one instance of this handler, and a per-instance field would buy nothing.
 */
const notFoundDdos = new Map<string, number>()

/**
 * Ceiling on how many distinct missing ids are remembered at once. The ids callers ask for are
 * frequently ids that do not exist, and a caller can supply an unbounded number of *distinct*
 * non-existent ids - a scan, a retry loop over random dids - each of which would otherwise hold
 * a slot for the full TTL. Without this cap the cache grows without limit until each id happens
 * to be looked up again after it expired. At this size the map is a few hundred KB at most.
 */
const MAX_NOT_FOUND_DDOS = 50_000

/** Drops every entry whose TTL has already passed. */
function pruneExpiredNotFoundDdos(): void {
  const now = Date.now()
  for (const [id, expiresAt] of notFoundDdos) {
    if (expiresAt <= now) {
      notFoundDdos.delete(id)
    }
  }
}

/** True when `id` was searched for recently and found nowhere. Prunes as it reads. */
function isDdoKnownMissing(id: string): boolean {
  const expiresAt = notFoundDdos.get(id)
  if (expiresAt == null) {
    return false
  }
  if (expiresAt <= Date.now()) {
    notFoundDdos.delete(id)
    return false
  }
  return true
}

/**
 * Records that `id` was found nowhere.
 *
 * The lifetime is short on purpose: a DDO that genuinely appears becomes findable as soon as
 * its publisher has written a provider record, and an entry outliving that would make this
 * cache the reason a freshly published asset looked missing.
 */
function rememberDdoMissing(id: string): void {
  // Enforce the ceiling before adding a genuinely new id. Reclaim expired entries first, and if
  // that is not enough evict the oldest live ones - every entry shares the same TTL, so the
  // Map's insertion order is also expiry order, and the front is what is closest to expiring.
  if (notFoundDdos.size >= MAX_NOT_FOUND_DDOS && !notFoundDdos.has(id)) {
    pruneExpiredNotFoundDdos()
    while (notFoundDdos.size >= MAX_NOT_FOUND_DDOS) {
      const oldest = notFoundDdos.keys().next().value
      if (oldest === undefined) break
      notFoundDdos.delete(oldest)
    }
  }
  notFoundDdos.set(id, Date.now() + P2P_TIMEOUTS.ddoNotFoundCacheMs)
}

/** Test seam: only the unit tests clear this, a running node never does. */
export function resetDdoNotFoundCache(): void {
  notFoundDdos.clear()
}

// scans all receipt logs for a MetadataCreated/MetadataUpdated event emitted by the
// given data NFT. The metadata event is not necessarily the first log of the
// transaction (AA accounts, multisigs and relayers emit other events before it)
export function findMetadataEventInLogs(
  logs: readonly { address: string; topics: readonly string[]; data: string }[],
  dataNftAddress: string
): ethers.LogDescription | null {
  const abiInterface = new ethers.Interface(ERC721Template.abi)
  const nftLogs = logs.filter(
    (log) => log.address.toLowerCase() === dataNftAddress.toLowerCase()
  )
  for (const eventName of [EVENTS.METADATA_CREATED, EVENTS.METADATA_UPDATED]) {
    const events = fetchEventFromTransaction({ logs: nftLogs }, eventName, abiInterface)
    if (events && events.length > 0) {
      return events[0]
    }
  }
  return null
}

export class DecryptDdoHandler extends CommandHandler {
  validate(command: DecryptDDOCommand): ValidateParams {
    const validation = validateCommandParameters(command, [
      'decrypterAddress',
      'chainId',
      'nonce',
      'signature'
    ])
    if (validation.valid) {
      if (!isAddress(command.decrypterAddress)) {
        return buildInvalidRequestMessage(
          'Parameter : "decrypterAddress" is not a valid web3 address'
        )
      }
    }
    return validation
  }

  async handle(task: DecryptDDOCommand): Promise<P2PCommandResponse> {
    const validationResponse = await this.verifyParamsAndRateLimits(task)
    if (this.shouldDenyTaskHandling(validationResponse)) {
      return validationResponse
    }
    const chainId = String(task.chainId)
    const config = this.getOceanNode().getConfig()
    const supportedNetwork = config.supportedNetworks[chainId]

    // check if supported chainId
    if (!supportedNetwork) {
      CORE_LOGGER.logMessage(`Decrypt DDO: Unsupported chain id ${chainId}`, true)
      return {
        stream: null,
        status: {
          httpStatus: 400,
          error: `Decrypt DDO: Unsupported chain id`
        }
      }
    }
    const isAuthRequestValid = await this.validateTokenOrSignature(
      task.authorization,
      task.decrypterAddress,
      task.nonce,
      task.signature,
      task.command
    )
    if (isAuthRequestValid.status.httpStatus !== 200) {
      return isAuthRequestValid
    }

    try {
      let decrypterAddress: string
      try {
        decrypterAddress = ethers.getAddress(task.decrypterAddress)
      } catch (error) {
        CORE_LOGGER.logMessage(`Decrypt DDO: error ${error}`, true)
        return {
          stream: null,
          status: {
            httpStatus: 400,
            error: 'Decrypt DDO: invalid parameter decrypterAddress'
          }
        }
      }

      const ourEthAddress = this.getOceanNode().getKeyManager().getEthAddress()
      if (config.authorizedDecrypters.length > 0) {
        // allow if on authorized list or it is own node
        if (
          !config.authorizedDecrypters
            .map((address) => address?.toLowerCase())
            .includes(decrypterAddress?.toLowerCase()) &&
          decrypterAddress?.toLowerCase() !== ourEthAddress.toLowerCase()
        ) {
          CORE_LOGGER.logMessage('Decrypt DDO: Decrypter not authorized', true)
          return {
            stream: null,
            status: {
              httpStatus: 403,
              error: 'Decrypt DDO: Decrypter not authorized'
            }
          }
        }
      }
      const oceanNode = this.getOceanNode()
      const blockchain = oceanNode.getBlockchain(supportedNetwork.chainId)
      if (!blockchain) {
        return {
          stream: null,
          status: {
            httpStatus: 400,
            error: `Decrypt DDO: Blockchain instance not available for chain ${supportedNetwork.chainId}`
          }
        }
      }
      const { ready, error } = await blockchain.isNetworkReady()
      if (!ready) {
        return {
          stream: null,
          status: {
            httpStatus: 400,
            error: `Decrypt DDO: ${error}`
          }
        }
      }

      const provider = await blockchain.getProvider()
      const signer = await blockchain.getSigner()
      // note: "getOceanArtifactsAdresses()"" is broken for at least optimism sepolia
      // if we do: artifactsAddresses[supportedNetwork.network]
      // because on the contracts we have "optimism_sepolia" instead of "optimism-sepolia"
      // so its always safer to use the chain id to get the correct network and artifacts addresses

      const dataNftAddress = ethers.getAddress(task.dataNftAddress)
      const wasDeployedByUs = await wasNFTDeployedByOurFactory(
        supportedNetwork.chainId,
        signer,
        dataNftAddress
      )
      if (!wasDeployedByUs) {
        CORE_LOGGER.logMessage(
          'Decrypt DDO: Asset not deployed by the data NFT factory',
          true
        )
        return {
          stream: null,
          status: {
            httpStatus: 400,
            error: 'Decrypt DDO: Asset not deployed by the data NFT factory'
          }
        }
      }

      // access list checks, needs blockchain connection
      const { authorizedDecryptersList } = config

      const isAllowed = await checkCredentialOnAccessList(
        authorizedDecryptersList,
        chainId,
        decrypterAddress,
        signer
      )
      if (!isAllowed) {
        CORE_LOGGER.logMessage(
          'Decrypt DDO: Decrypter not authorized per access list',
          true
        )
        return {
          stream: null,
          status: {
            httpStatus: 403,
            error: `Decrypt DDO: Decrypter ${decrypterAddress} not authorized per access list`
          }
        }
      }

      const transactionId = task.transactionId ? String(task.transactionId) : ''
      let encryptedDocument: Uint8Array
      let flags: number
      let documentHash: string

      if (transactionId) {
        try {
          const receipt = await provider.getTransactionReceipt(transactionId)
          if (!receipt || !receipt.logs.length) {
            throw new Error('receipt logs 0')
          }
          const eventData = findMetadataEventInLogs(receipt.logs, dataNftAddress)
          if (!eventData) {
            throw new Error(
              `transaction ${transactionId} does not contain a MetadataCreated or MetadataUpdated event emitted by ${dataNftAddress}`
            )
          }
          flags = parseInt(eventData.args[3], 16)
          encryptedDocument = ethers.getBytes(eventData.args[4])
          documentHash = eventData.args[5]
        } catch (error) {
          CORE_LOGGER.logMessage(`Decrypt DDO: error ${error}`, true)
          return {
            stream: null,
            status: {
              httpStatus: 400,
              error: 'Decrypt DDO: Failed to process transaction id'
            }
          }
        }
      } else {
        try {
          encryptedDocument = ethers.getBytes(task.encryptedDocument)
          flags = Number(task.flags)
          // eslint-disable-next-line prefer-destructuring
          documentHash = task.documentHash
        } catch (error) {
          CORE_LOGGER.logMessage(`Decrypt DDO: error ${error}`, true)
          return {
            stream: null,
            status: {
              httpStatus: 400,
              error: 'Decrypt DDO: Failed to convert input args to bytes'
            }
          }
        }
      }

      const templateContract = new ethers.Contract(
        dataNftAddress,
        ERC721Template.abi,
        signer
      )
      const metaData = await templateContract.getMetaData()
      const metaDataState = Number(metaData[2])
      if ([MetadataStates.DEPRECATED, MetadataStates.REVOKED].includes(metaDataState)) {
        CORE_LOGGER.logMessage(`Decrypt DDO: error metadata state ${metaDataState}`, true)
        return {
          stream: null,
          status: {
            httpStatus: 403,
            error: 'Decrypt DDO: invalid metadata state'
          }
        }
      }

      if (
        ![
          MetadataStates.ACTIVE,
          MetadataStates.END_OF_LIFE,
          MetadataStates.ORDERING_DISABLED,
          MetadataStates.UNLISTED
        ].includes(metaDataState)
      ) {
        CORE_LOGGER.logMessage(`Decrypt DDO: error metadata state ${metaDataState}`, true)
        return {
          stream: null,
          status: {
            httpStatus: 400,
            error: 'Decrypt DDO: invalid metadata state'
          }
        }
      }

      let decryptedDocument: Buffer
      // check if DDO is ECIES encrypted
      if ((flags & 2) !== 0) {
        try {
          decryptedDocument = await oceanNode
            .getKeyManager()
            .decrypt(encryptedDocument, EncryptMethod.ECIES)
        } catch (error) {
          CORE_LOGGER.logMessage(`Decrypt DDO: error ${error}`, true)
          return {
            stream: null,
            status: {
              httpStatus: 400,
              error: 'Decrypt DDO: Failed to decrypt'
            }
          }
        }
      } else {
        try {
          decryptedDocument = lzmajs.decompressFile(decryptedDocument)
          /*
          lzma.decompress(
            decryptedDocument,
            { synchronous: true },
            (decompressedResult: any) => {
              decryptedDocument = decompressedResult
            }
          )
          */
        } catch (error) {
          CORE_LOGGER.logMessage(`Decrypt DDO: error ${error}`, true)
          return {
            stream: null,
            status: {
              httpStatus: 400,
              error: 'Decrypt DDO: Failed to lzma decompress'
            }
          }
        }
      }

      // did matches
      const ddo = JSON.parse(decryptedDocument.toString())
      const clonedDdo = structuredClone(ddo)
      const updatedDdo = deleteIndexedMetadataIfExists(clonedDdo)
      const ddoInstance = DDOManager.getDDOClass(updatedDdo)
      if (updatedDdo.id !== ddoInstance.makeDid(dataNftAddress, chainId)) {
        CORE_LOGGER.error(`Decrypted DDO ID is not matching the generated hash for DID.`)
        return {
          stream: null,
          status: {
            httpStatus: 400,
            error: 'Decrypt DDO: did does not match'
          }
        }
      }

      // checksum matches
      const decryptedDocumentHash = create256Hash(decryptedDocument.toString())
      if (decryptedDocumentHash !== documentHash) {
        CORE_LOGGER.logMessage(
          `Decrypt DDO: error checksum does not match ${decryptedDocumentHash} with ${documentHash}`,
          true
        )
        return {
          stream: null,
          status: {
            httpStatus: 400,
            error: 'Decrypt DDO: checksum does not match'
          }
        }
      }

      return {
        stream: Readable.from(decryptedDocument.toString()),
        status: { httpStatus: 200 }
      }
    } catch (error) {
      CORE_LOGGER.logMessage(`Decrypt DDO: error ${error}`, true)
      return {
        stream: null,
        status: { httpStatus: 500, error: `Decrypt DDO: Unknown error ${error}` }
      }
    }
  }
}

export class GetDdoHandler extends CommandHandler {
  validate(command: GetDdoCommand): ValidateParams {
    let validation = validateCommandParameters(command, ['id'])
    if (validation.valid) {
      validation = validateDDOIdentifier(command.id)
    }

    return validation
  }

  async handle(task: GetDdoCommand): Promise<P2PCommandResponse> {
    const validationResponse = await this.verifyParamsAndRateLimits(task)
    if (this.shouldDenyTaskHandling(validationResponse)) {
      return validationResponse
    }
    try {
      const database = await this.getOceanNode().getDatabase()
      if (!database || !database.ddo) {
        CORE_LOGGER.error('DDO database is not available')
        return {
          stream: null,
          status: { httpStatus: 503, error: 'DDO database is not available' }
        }
      }
      const ddo = await database.ddo.retrieve(task.id)
      if (!ddo) {
        return {
          stream: null,
          status: { httpStatus: 404, error: 'Not found' }
        }
      }
      return {
        stream: Readable.from(JSON.stringify(ddo)),
        status: { httpStatus: 200 }
      }
    } catch (error) {
      CORE_LOGGER.error(`Get DDO error: ${error}`)
      return {
        stream: null,
        status: { httpStatus: 500, error: 'Unknown error: ' + error.message }
      }
    }
  }
}

export class FindDdoHandler extends CommandHandler {
  validate(command: FindDDOCommand): ValidateParams {
    let validation = validateCommandParameters(command, ['id'])
    if (validation.valid) {
      validation = validateDDOIdentifier(command.id)
    }

    return validation
  }

  async handle(task: FindDDOCommand): Promise<P2PCommandResponse> {
    const validationResponse = await this.verifyParamsAndRateLimits(task)
    if (this.shouldDenyTaskHandling(validationResponse)) {
      return validationResponse
    }
    // assigned once the FindDDO deadline exists; the finally below runs it on
    // every exit path, including the outer-exception one
    let endFindDdo: () => void = () => {}
    try {
      const node = this.getOceanNode()
      const p2pNode = node.getP2PNode()

      // if not P2P node just look on local DB
      if (!node.hasP2PInterface() || !p2pNode) {
        // Checking locally only...
        const ddoInf = await findDDOLocally(node, task.id)
        const result = ddoInf ? [ddoInf] : []
        return {
          stream: Readable.from(JSON.stringify(result, null, 4)),
          status: { httpStatus: 200 }
        }
      }

      let updatedCache = false
      // result list
      const resultList: FindDDOResponse[] = []
      // if we have the result cached recently we return that result
      if (hasCachedDDO(task, p2pNode)) {
        // 'found cached DDO'
        CORE_LOGGER.logMessage('Found local cached version for DDO id: ' + task.id, true)
        resultList.push(p2pNode.getDDOCache().dht.get(task.id))
        return {
          stream: Readable.from(JSON.stringify(resultList, null, 4)),
          status: { httpStatus: 200 }
        }
      }
      // otherwise we need to contact other providers and get DDO from them
      const configuration = node.getConfig()

      // Checking locally...
      const ddoInfo = await findDDOLocally(node, task.id)
      if (ddoInfo) {
        // node has ddo
        // add to the result list anyway
        resultList.push(ddoInfo)

        updatedCache = true
      }

      // Deliberately *after* the local lookup, so a DDO this node holds is always returned no
      // matter what a previous search concluded. All this entry can do is skip the network half
      // of the search for a short while, which is the half a hot loop of requests for a
      // non-existent id is repeatedly paying for.
      if (isDdoKnownMissing(task.id)) {
        CORE_LOGGER.logMessage(
          `Skipping the provider search for DDO id ${task.id}: a recent search found it nowhere`,
          true
        )
        return {
          stream: Readable.from(JSON.stringify(sortFindDDOResults(resultList), null, 4)),
          status: { httpStatus: 200 }
        }
      }

      /**
       * Validates one provider's answer and folds it into the result list.
       *
       * @returns whether the answer was a legitimate DDO. The concurrent provider queries race
       *   on this: a peer that returns HTTP 200 with something that does not verify has not
       *   answered the question, so it must not cancel the peers that still might.
       */
      const processDDOResponse = async (
        peer: string,
        data: Uint8Array
      ): Promise<boolean> => {
        try {
          const ddo: any = JSON.parse(uint8ArrayToString(data))
          const isResponseLegit = await checkIfDDOResponseIsLegit(ddo, node)

          if (isResponseLegit) {
            const ddoInfo: FindDDOResponse = {
              id: ddo.id,
              lastUpdateTx: ddo.indexedMetadata.event.txid,
              lastUpdateTime: ddo.metadata.updated,
              provider: peer
            }
            resultList.push(ddoInfo)

            CORE_LOGGER.logMessage(
              `Successfully processed DDO info, id: ${ddo.id} from remote peer: ${peer}`,
              true
            )

            // Update cache
            const ddoCache = p2pNode.getDDOCache()
            if (ddoCache.dht.has(ddo.id)) {
              const localValue: FindDDOResponse = ddoCache.dht.get(ddo.id)
              if (
                new Date(ddoInfo.lastUpdateTime) > new Date(localValue.lastUpdateTime)
              ) {
                // update cached version
                ddoCache.dht.set(ddo.id, ddoInfo)
              }
            } else {
              // just add it to the list
              ddoCache.dht.set(ddo.id, ddoInfo)
            }
            updatedCache = true

            // Store locally if indexer is enabled
            if (configuration.hasIndexer) {
              const database = await node.getDatabase()
              if (database && database.ddo) {
                const ddoExistsLocally = await database.ddo.retrieve(ddo.id)
                if (!ddoExistsLocally) {
                  p2pNode.storeAndAdvertiseDDOS([ddo])
                }
              }
            }
            return true
          }
          CORE_LOGGER.warn(
            `Cannot confirm validity of ${ddo.id} from remote node, skipping it...`
          )
        } catch (err) {
          CORE_LOGGER.logMessageWithEmoji(
            'FindDDO: Error on sink function: ' + err.message,
            true,
            GENERIC_EMOJIS.EMOJI_CROSS_MARK,
            LOG_LEVELS_STR.LEVEL_ERROR
          )
        }
        return false
      }

      // Overall FindDDO deadline. Read from the P2P budgets rather than from a local literal:
      // the budget and its environment override already existed, and this file re-declared the
      // same 60s next to it, so `P2P_FINDDDO_TIMEOUT_MS` was documented but reached nothing.
      // Destructured inside the handler, not at module scope: the budget object is a set of
      // getters, so reading it per call is what keeps an environment override effective.
      const { findDdoMs } = P2P_TIMEOUTS
      // this is a real AbortController for the whole FindDDO: the deadline is
      // propagated into the provider lookup and into every peer query, so it
      // actually stops the work instead of just firing a timer callback
      const findDdoController = new AbortController()
      // a plain timer, not AbortSignal.timeout(): that one cannot be cancelled, so it
      // would still fire - and log a spurious 'Timeout reached' - long after the
      // request returned. clearTimeout below really does cancel it
      const findDdoDeadline = setTimeout(() => {
        CORE_LOGGER.log(LOG_LEVELS_STR.LEVEL_DEBUG, 'FindDDO: Timeout reached: ', true)
        findDdoController.abort(
          new Error(
            `FindDDO aborted after ${findDdoMs}ms, returning whatever info we have available`
          )
        )
      }, findDdoMs)
      const findDdoSignal = findDdoController.signal
      // releases the deadline and cancels anything still in flight (idempotent)
      endFindDdo = () => {
        clearTimeout(findDdoDeadline)
        findDdoController.abort(new Error('FindDDO finished'))
      }
      // rejects as soon as the FindDDO deadline fires, for callees that cannot
      // (yet) take a signal of their own
      const withFindDdoDeadline = <T>(promise: Promise<T>): Promise<T> => {
        if (findDdoSignal.aborted) {
          return Promise.reject(findDdoSignal.reason)
        }
        let onAbort: () => void = () => {}
        const aborted = new Promise<never>((resolve, reject) => {
          onAbort = () => reject(findDdoSignal.reason)
          findDdoSignal.addEventListener('abort', onAbort, { once: true })
        })
        return Promise.race([promise, aborted]).finally(() => {
          findDdoSignal.removeEventListener('abort', onAbort)
        })
      }

      /**
       * The single exit for a search that actually *finished* - every provider that was going
       * to answer has answered, or there were none to ask.
       *
       * It is the only place a "found nowhere" answer is remembered, and the distinction it
       * draws is the one that matters: a search the deadline cut short establishes nothing about
       * whether the DDO exists, only that looking took too long, so those exits deliberately do
       * not go through here.
       */
      const finishCompletedSearch = (): P2PCommandResponse => {
        // Only a search that ran to completion may write a "found nowhere" entry. The concurrent
        // provider loop swallows each branch's abort, so this exit is still reached when the
        // deadline fired mid-query - and a deadline establishes nothing about whether the DDO
        // exists (see the comment on this block). Remembering it missing then would let a slow
        // lookup poison the cache against an id that is simply expensive to find.
        if (resultList.length === 0 && !findDdoSignal.aborted) {
          rememberDdoMissing(task.id)
        }
        endFindDdo()
        return {
          stream: Readable.from(JSON.stringify(sortFindDDOResults(resultList), null, 4)),
          status: { httpStatus: 200 }
        }
      }

      // check other providers for this ddo
      let providers: Array<{ id: string; multiaddrs: any[] }> = []
      try {
        providers = await withFindDdoDeadline(
          p2pNode.getProvidersForString(task.id, undefined, findDdoSignal)
        )
      } catch (findProvidersError) {
        // only the deadline may be swallowed into a 200. Anything else - notably a
        // malformed task.id rejected by cidFromRawString(), which sits outside
        // getProvidersForString's own try - must keep its 500
        if (!findDdoSignal.aborted) {
          throw findProvidersError
        }
        // deadline reached while looking for providers: return what we already have
        CORE_LOGGER.warn(
          `FindDDO: provider lookup ended early for id ${task.id}: ${findProvidersError.message}`
        )
        endFindDdo()
        return {
          stream: Readable.from(JSON.stringify(sortFindDDOResults(resultList), null, 4)),
          status: { httpStatus: 200 }
        }
      }
      // check if includes self and exclude from check list
      if (providers.length > 0) {
        // exclude this node from the providers list if present
        let filteredProviders = providers.filter((provider: any) => {
          return provider.id.toString() !== p2pNode.getPeerId()
        })

        // work with the filtered list only
        if (filteredProviders.length > 0) {
          // only process a maximum of 5 provider entries per DDO (might never be that much anyway??)
          if (filteredProviders.length > MAX_NUM_PROVIDERS) {
            filteredProviders = filteredProviders.slice(0, MAX_NUM_PROVIDERS)
          }

          /**
           * Providers are queried **concurrently**, each with its own budget, and the first
           * legitimate answer ends the search.
           *
           * What this replaces: the providers were queried one at a time, with a fixed 5 second
           * sleep after each, wrapped in a `do/while` that could re-run the whole pass. At the
           * provider maximum of 5 that is 5 x (one whole `sendTo` setup budget + 5s) =
           * 5 x 50s = 250 seconds of structure, before counting the response-body read - and the
           * only reason a request did not take that long was the overall deadline cutting it
           * off, which meant the later providers in the list were never actually asked. So the
           * sequential shape did not just cost latency, it silently reduced the number of
           * providers consulted to however many fitted in the deadline.
           *
           * Concurrency removes both problems: every provider is asked at once, so the answer
           * arrives in roughly one provider round trip rather than in list order, and no
           * provider is skipped because an earlier one was slow. Nothing sleeps between
           * providers - there was never a reason to pause between two independent peers - and
           * there is no re-query pass, because asking the same providers the same question again
           * cannot produce a different answer inside one deadline.
           *
           * The trade, stated plainly: the result list now holds the first legitimate answer
           * rather than every provider's answer, so `sortFindDDOResults` has one remote entry to
           * choose between instead of up to five. The sort exists to prefer the most recently
           * updated DDO, and collecting all five to do that costs the latency of the slowest
           * provider on every request, for a difference that only appears when providers
           * disagree about the same asset.
           */
          const perProviderMs = P2P_TIMEOUTS.findDdoProviderMs
          // Cancels the losers the moment one provider answers legitimately. A separate
          // controller from the overall deadline so that "we have our answer" and "we ran out
          // of time" stay distinguishable in the logs.
          const answered = new AbortController()
          let haveAnswer = false

          await Promise.all(
            filteredProviders.map(async (provider: any) => {
              const peer = provider.id.toString()
              const getCommand: GetDdoCommand = {
                id: task.id,
                command: PROTOCOL_COMMANDS.GET_DDO
              }
              // Three ways this branch can end early: the overall deadline, another provider
              // having answered, and this provider taking too long on its own. The per-provider
              // budget is what makes concurrency safe - without it one unresponsive provider
              // would hold a branch open for the whole FindDDO deadline.
              const providerSignal = AbortSignal.any([
                findDdoSignal,
                answered.signal,
                AbortSignal.timeout(perProviderMs)
              ])
              // A provider record from the DHT usually carries the provider's addresses. Passing
              // them through means this send skips address resolution altogether - the addresses
              // are already in hand, and re-deriving them would repeat the lookup that produced
              // this provider. Falling back to no addresses lets `sendTo` resolve normally.
              //
              // Pinned addresses are used verbatim and are not re-resolved on failure, so a
              // provider whose advertised address no longer works is lost for this request. That
              // is the right trade here and only here: four other providers are being asked the
              // same question at the same moment, so the cost of dropping one is nothing, while
              // a DHT walk per provider would reintroduce exactly the latency this loop removes.
              const providerAddrs: string[] = Array.isArray(provider.multiaddrs)
                ? provider.multiaddrs.map((ma: any) => ma.toString())
                : []
              try {
                const response = await p2pNode.sendTo(
                  peer,
                  JSON.stringify(getCommand),
                  providerAddrs.length > 0 ? providerAddrs : undefined,
                  undefined,
                  providerSignal
                )
                if (response.status.httpStatus !== 200 || !response.stream) {
                  return
                }
                // Capped: this is one DDO from an untrusted provider, and the shared
                // reader's 64 MiB default is a heap ceiling rather than a statement about
                // this payload. A DDO is well under a MiB in practice. Time is already
                // bounded - the send above carries providerSignal - so only the size was
                // unbounded.
                const data = await streamToUint8Array(
                  response.stream as Readable,
                  MAX_DDO_RESPONSE_BYTES
                )
                const accepted = await processDDOResponse(peer, data)
                if (accepted && !haveAnswer) {
                  haveAnswer = true
                  answered.abort(
                    new Error(`FindDDO for ${task.id} answered by provider ${peer}`)
                  )
                }
              } catch (innerException) {
                // One provider failing, timing out, or being cancelled because another
                // answered is not a FindDDO failure. The overall outcome is whatever the
                // result list holds when every branch has settled.
                CORE_LOGGER.debug(
                  `FindDDO: provider ${peer} did not answer for ${task.id}: ${innerException.message}`
                )
              }
            })
          )

          if (updatedCache) {
            p2pNode.getDDOCache().updated = new Date().getTime()
          }

          // house cleaning
          return finishCompletedSearch()
        } else {
          // could empty list
          return finishCompletedSearch()
        }
      } else {
        // could be empty list
        return finishCompletedSearch()
      }
    } catch (error) {
      // 'FindDDO big error: '
      CORE_LOGGER.logMessageWithEmoji(
        `Error: '${error.message}' was caught while getting DDO info for id: ${task.id}`,
        true,
        GENERIC_EMOJIS.EMOJI_CROSS_MARK,
        LOG_LEVELS_STR.LEVEL_ERROR
      )
      return {
        stream: null,
        status: { httpStatus: 500, error: 'Unknown error: ' + error.message }
      }
    } finally {
      // every exit path releases the deadline listener/timer
      endFindDdo()
    }
  }

  // Function to use findDDO and get DDO in desired format
  async findAndFormatDdo(ddoId: string, force: boolean = false): Promise<DDO | null> {
    const node = this.getOceanNode()
    // First try to find the DDO Locally if findDDO is not enforced
    if (!force) {
      try {
        const database = await node.getDatabase()
        if (database && database.ddo) {
          const ddo = await database.ddo.retrieve(ddoId)
          return ddo as DDO
        } else {
          CORE_LOGGER.logMessage(
            `DDO database is not available. Proceeding to call findDDO`,
            true
          )
        }
      } catch (error) {
        CORE_LOGGER.logMessage(
          `Unable to find DDO locally. Proceeding to call findDDO`,
          true
        )
      }
    }
    try {
      const task: FindDDOCommand = {
        id: ddoId,
        command: PROTOCOL_COMMANDS.FIND_DDO,
        force
      }
      const response: P2PCommandResponse = await this.handle(task)

      if (response && response?.status?.httpStatus === 200 && response?.stream) {
        const streamData = await readStream(response.stream)
        const ddoList = JSON.parse(streamData)

        // Assuming the first DDO in the list is the one we want
        const ddoData = ddoList[0]
        if (!ddoData) {
          return null
        }

        // Format each service according to the Service interface
        const formattedServices = ddoData.services.map(formatService)

        // Map the DDO data to the DDO interface
        const ddo: Asset = {
          '@context': ddoData['@context'],
          id: ddoData.id,
          version: ddoData.version,
          nftAddress: ddoData.nftAddress,
          chainId: ddoData.chainId,
          metadata: ddoData.metadata,
          services: formattedServices,
          credentials: ddoData.credentials,
          indexedMetadata: {
            stats: ddoData.indexedMetadata.stats,
            event: ddoData.indexedMetadata.event,
            nft: ddoData.indexedMetadata.nft
          }
        }

        return ddo
      }

      return null
    } catch (error) {
      CORE_LOGGER.log(
        LOG_LEVELS_STR.LEVEL_ERROR,
        `Error finding DDO: ${error.message}`,
        true
      )
      return null
    }
  }
}

export class ValidateDDOHandler extends CommandHandler {
  validate(command: ValidateDDOCommand): ValidateParams {
    let validation = validateCommandParameters(command, ['ddo'])
    if (validation.valid) {
      validation = validateDDOIdentifier(command.ddo.id)
    }

    return validation
  }

  async handle(task: ValidateDDOCommand): Promise<P2PCommandResponse> {
    const validationResponse = await this.verifyParamsAndRateLimits(task)
    if (this.shouldDenyTaskHandling(validationResponse)) {
      return validationResponse
    }
    if (!task.ddo || !task.ddo.version) {
      return {
        stream: null,
        status: { httpStatus: 400, error: 'Missing DDO version' }
      }
    }
    let shouldSign = false
    const configuration = this.getOceanNode().getConfig()
    if (configuration.validateUnsignedDDO) {
      shouldSign = true
    }
    if (task.authorization || task.signature || task.nonce || task.publisherAddress) {
      const validationResponse = await this.validateTokenOrSignature(
        task.authorization,
        task.publisherAddress,
        task.nonce,
        task.signature,
        task.command
      )
      if (validationResponse.status.httpStatus !== 200) {
        return validationResponse
      }
      shouldSign = true
    }

    try {
      const ddoInstance = DDOManager.getDDOClass(task.ddo)
      const validation = await ddoInstance.validate()
      if (validation[0] === false) {
        CORE_LOGGER.logMessageWithEmoji(
          `Validation failed with error: ${validation[1]}`,
          true,
          GENERIC_EMOJIS.EMOJI_CROSS_MARK,
          LOG_LEVELS_STR.LEVEL_ERROR
        )
        return {
          stream: null,
          status: { httpStatus: 400, error: `Validation error: ${validation[1]}` }
        }
      }
      if (isPolicyServerConfigured()) {
        const policyServer = new PolicyServer()
        const response = await policyServer.validateDDO(
          task.ddo,
          task.publisherAddress,
          task.policyServer
        )
        if (!response.success) {
          CORE_LOGGER.logMessage(
            `Error: Validation for ${task.publisherAddress} was denied`,
            true
          )
          return {
            stream: null,
            status: {
              httpStatus: 403,
              error: `Error: Validation for ${task.publisherAddress} was denied`
            }
          }
        }
      }
      return {
        stream: shouldSign
          ? Readable.from(
              JSON.stringify(
                await this.getOceanNode().getValidationSignature(JSON.stringify(task.ddo))
              )
            )
          : null,
        status: { httpStatus: 200 }
      }
    } catch (error) {
      CORE_LOGGER.logMessageWithEmoji(
        `Error occurred on validateDDO command: ${error}`,
        true,
        GENERIC_EMOJIS.EMOJI_CROSS_MARK,
        LOG_LEVELS_STR.LEVEL_ERROR
      )
      return {
        stream: null,
        status: { httpStatus: 500, error: 'Unknown error: ' + error.message }
      }
    }
  }
}

export function validateDdoSignedByPublisher(
  ddo: DDO,
  nonce: string,
  signature: string,
  publisherAddress: string
): boolean {
  try {
    const message = ddo.id + nonce
    const messageHash = ethers.solidityPackedKeccak256(
      ['bytes'],
      [ethers.hexlify(ethers.toUtf8Bytes(message))]
    )
    const messageHashBytes = ethers.getBytes(messageHash)
    // Try both verification methods for backward compatibility
    const addressFromHashSignature = ethers.verifyMessage(messageHash, signature)
    const addressFromBytesSignature = ethers.verifyMessage(messageHashBytes, signature)
    return (
      addressFromHashSignature?.toLowerCase() === publisherAddress?.toLowerCase() ||
      addressFromBytesSignature?.toLowerCase() === publisherAddress?.toLowerCase()
    )
  } catch (error) {
    CORE_LOGGER.logMessage(`Error: ${error}`, true)
    return false
  }
}

export function validateDDOIdentifier(identifier: string): ValidateParams {
  const valid = identifier && identifier.length > 0 && identifier.startsWith('did:op')
  if (!valid) {
    return {
      valid: false,
      status: 400,
      reason: ' Missing or invalid required parameter "id'
    }
  }
  return {
    valid: true
  }
}

/**
 * Checks if the response is legit
 * @param ddo the DDO
 * @param oceanNode the OceanNode instance
 * @returns validation result
 */
async function checkIfDDOResponseIsLegit(
  ddo: any,
  oceanNode: OceanNode
): Promise<boolean> {
  const clonedDdo = structuredClone(ddo)
  const { indexedMetadata } = clonedDdo
  const updatedDdo = deleteIndexedMetadataIfExists(ddo)
  const { nftAddress, chainId } = updatedDdo
  let isValid = validateDDOHash(updatedDdo.id, nftAddress, chainId)
  // 1) check hash sha256(nftAddress + chainId)
  if (!isValid) {
    CORE_LOGGER.error(`Asset ${updatedDdo.id} does not have a valid hash`)
    return false
  }

  // 2) check event
  //
  // This tested a bare `event`, which is declared nowhere in this function - the only `event`
  // in the file is a `const` inside a `for` block further down, in a different scope. So the
  // check threw `ReferenceError: event is not defined` for every DDO that got past the hash
  // gate above, the caller's `try/catch` swallowed it as "Error on sink function", and the
  // answer was discarded. The effect was that **no** DDO fetched from a remote provider was
  // ever accepted: a FindDDO could only ever return what this node already held locally. It
  // was invisible because the failure looked identical to a provider that simply had nothing.
  //
  // TypeScript did not catch it because `target: ES2022` pulls in the default DOM library,
  // where `event` is a declared global.
  //
  // What the check is for is visible from step 5, which reads `indexedMetadata.event.block` and
  // `indexedMetadata.event.tx`: the DDO has to carry an indexed event before any of that can be
  // verified. Testing that also stops step 5 throwing on a DDO that has no `indexedMetadata`.
  if (!indexedMetadata?.event) {
    CORE_LOGGER.error(
      `Asset ${updatedDdo.id} carries no indexed event, cannot confirm validation.`
    )
    return false
  }

  // 3) check if we support this network
  const config = oceanNode.getConfig()
  const network = config.supportedNetworks[chainId.toString()]
  if (!network) {
    CORE_LOGGER.error(
      `We do not support the newtwork ${chainId}, cannot confirm validation.`
    )
    return false
  }
  // 4) check if was deployed by our factory
  const blockchain = oceanNode.getBlockchain(chainId as number)
  if (!blockchain) {
    CORE_LOGGER.error(
      `Blockchain instance not available for chain ${chainId}, cannot confirm validation.`
    )
    return false
  }
  const signer = await blockchain.getSigner()

  const wasDeployedByUs = await wasNFTDeployedByOurFactory(
    chainId as number,
    signer,
    ethers.getAddress(nftAddress)
  )

  if (!wasDeployedByUs) {
    CORE_LOGGER.error(`Asset ${updatedDdo.id} not deployed by the data NFT factory`)
    return false
  }

  // 5) check block & events
  const networkBlock = await getNetworkHeight(await blockchain.getProvider())
  if (
    !indexedMetadata.event.block ||
    indexedMetadata.event.block < 0 ||
    networkBlock < indexedMetadata.event.block
  ) {
    CORE_LOGGER.error(
      `Event block: ${indexedMetadata.event.block} is either missing or invalid`
    )
    return false
  }

  // check events on logs
  const txId: string = indexedMetadata.event.tx || indexedMetadata.event.txid // NOTE: DDO is txid, Asset is tx
  if (!txId) {
    CORE_LOGGER.error(`DDO event missing tx data, cannot confirm transaction`)
    return false
  }
  const provider = await blockchain.getProvider()
  const receipt = await provider.getTransactionReceipt(txId)
  let foundEvents = false
  if (receipt) {
    const { logs } = receipt
    for (const log of logs) {
      const event = findEventByKey(log.topics[0])
      if (event && Object.values(EVENTS).includes(event.type)) {
        if (
          event.type === EVENTS.METADATA_CREATED ||
          event.type === EVENTS.METADATA_UPDATED
        ) {
          foundEvents = true
          break
        }
      }
    }
    isValid = foundEvents
  } else {
    isValid = false
  }

  return isValid
}
