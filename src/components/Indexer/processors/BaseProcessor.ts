import { VersionedDDO, DeprecatedDDO } from '@oceanprotocol/ddo-js'
import {
  ZeroAddress,
  Signer,
  ethers,
  Interface,
  toUtf8Bytes,
  hexlify,
  getBytes,
  toUtf8String,
  FallbackProvider
} from 'ethers'
import { Readable } from 'winston-transport'
import { DecryptDDOCommand } from '../../../@types/commands.js'
import { OceanNode } from '../../../OceanNode.js'
import { EVENT_HASHES, PROTOCOL_COMMANDS } from '../../../utils/constants.js'
import { timestampToDateTime } from '../../../utils/conversions.js'
import { create256Hash, buildDecryptDDOSignatureMessage } from '../../../utils/crypt.js'
import { INDEXER_LOGGER } from '../../../utils/logging/common.js'
import { errorSummary } from '../../../utils/logging/redact.js'
import { URLUtils } from '../../../utils/url.js'
import { checkUrlHost, getSafeDispatcher } from '../../../utils/safeUrl.js'
import { fetch as undiciFetch } from 'undici'
import { streamToString, streamToUint8Array } from '../../../utils/util.js'
import ERC721Template from '@oceanprotocol/contracts/artifacts/contracts/templates/ERC721Template.sol/ERC721Template.json' with { type: 'json' }
import { toString as uint8ArrayToString } from 'uint8arrays/to-string'
import ERC20Template from '@oceanprotocol/contracts/artifacts/contracts/templates/ERC20TemplateEnterprise.sol/ERC20TemplateEnterprise.json' with { type: 'json' }
import { fetchTransactionReceipt } from '../../core/utils/validateOrders.js'
import { withRetrial, isProviderError } from '../utils.js'
import { OceanNodeConfig } from '../../../@types/OceanNode.js'
import { Database } from '../../../components/database/index.js'

/**
 * Byte cap for the DDO response body `decryptDDO` reads.
 *
 * The shared readers default to 64 MiB, which is a ceiling on heap growth, not a statement
 * about this payload. It comes from a node the indexer chose to trust only as far as the
 * on-chain `decryptorURL` says, and is read over P2P, so the cap should say what the payload
 * actually is: a DDO is comfortably under a MiB in practice, so 4 MiB leaves room for an
 * unusually large one while still refusing a peer that answers a `getDDO` with a gigabyte.
 *
 * (The nonce is no longer fetched from a remote endpoint — ON-02 uses a local monotonic nonce,
 * so there is no second remote body to bound here.)
 */
const MAX_DDO_RESPONSE_BYTES = 4 * 1024 * 1024

/**
 * Byte cap for the `GET /` status body read when resolving the destination peerId.
 *
 * The body is just `{ nodeId, ... }` and is comfortably under a KiB in practice, but it comes
 * from the attacker-publishable on-chain `decryptorURL`, so the read is bounded (on the declared
 * Content-Length and while consuming the stream) rather than parsed unbounded.
 */
const MAX_NODEID_RESPONSE_BYTES = 64 * 1024

export abstract class BaseEventProcessor {
  protected networkId: number
  private config: OceanNodeConfig

  // ON-02: cache of decryptorURL -> { destination peerId, expiry }. Only SUCCESSFUL
  // resolutions are cached, and only for a bounded TTL, so (a) a transient failure does not
  // permanently block HTTP decrypt for a URL and (b) a target node that rotates its identity
  // is re-learned after the TTL. Keeps the HTTP decrypt path from hitting the target's root
  // endpoint on every attempt.
  private static readonly decryptorPeerIdCache = new Map<
    string,
    { peerId: string; expiresAt: number }
  >()

  private static readonly DECRYPTOR_PEERID_TTL_MS = 10 * 60 * 1000
  // Bound the cache so an attacker publishing many assets with distinct public decryptorURLs
  // cannot grow it without limit (entries also expire via the TTL above).
  private static readonly DECRYPTOR_PEERID_CACHE_MAX = 512

  constructor(chainId: number, config: OceanNodeConfig) {
    this.networkId = chainId
    this.config = config
  }

  getConfig(): OceanNodeConfig {
    return this.config
  }

  /**
   * Rethrow transient provider/RPC failures so the crawl loop can retry the chunk instead of the
   * event processor swallowing them and letting the cursor advance past an un-stored asset.
   */
  protected rethrowIfProviderError(err: any): void {
    if (isProviderError(err)) throw err
  }

  async getDatabase(): Promise<Database> {
    return await OceanNode.getInstance().getDatabase()
  }

  protected isValidDtAddressFromServices(services: any[]): boolean {
    for (const service of services) {
      if (
        service.datatokenAddress === '0x0' ||
        service.datatokenAddress === ZeroAddress
      ) {
        return false
      }
    }
    return true
  }

  protected async getTokenInfo(services: any[], signer: Signer): Promise<any[]> {
    const datatokens: any[] = []

    for (const service of services) {
      const datatoken = new ethers.Contract(
        service.datatokenAddress,
        ERC20Template.abi,
        signer
      )
      let name: string
      let symbol: string
      if (
        service.datatokenAddress === '0x0' ||
        service.datatokenAddress === ZeroAddress
      ) {
        name = `Datatoken${services.indexOf(service)}`
        symbol = `DT${services.indexOf(service)}`
      } else {
        name = await datatoken.name()
        symbol = await datatoken.symbol()
        INDEXER_LOGGER.debug(
          `Datatoken ${service.datatokenAddress}: name=${name}, symbol=${symbol}`
        )
      }

      datatokens.push({
        address: service.datatokenAddress,
        name,
        symbol,
        serviceId: service.id
      })
    }

    return datatokens
  }

  protected async getEventData(
    provider: FallbackProvider,
    transactionHash: string,
    abi: any,
    eventType: string
  ): Promise<ethers.LogDescription> {
    const iface = new Interface(abi)
    let receipt: ethers.TransactionReceipt
    try {
      receipt = await fetchTransactionReceipt(transactionHash, provider)
    } catch {
      // fetchTransactionReceipt returns null instead of throwing
    }
    if (receipt) {
      let eventHash: string
      for (const [key, value] of Object.entries(EVENT_HASHES)) {
        if (value.type === eventType) {
          eventHash = key
          break
        }
      }
      if (eventHash === '') {
        INDEXER_LOGGER.error(`Event hash couldn't be found!`)
        return null
      }

      let eventObj: any
      for (const log of receipt.logs) {
        if (log.topics[0] === eventHash) {
          eventObj = {
            topics: log.topics,
            data: log.data
          }
          break
        }
      }

      if (!eventObj) {
        INDEXER_LOGGER.error(
          `Event object couldn't be retrieved! Event hash not present in logs topics`
        )
        return null
      }

      return iface.parseLog(eventObj)
    } else {
      INDEXER_LOGGER.error(
        `Receipt could not be fetched for tx ${transactionHash} on chain ${this.networkId}`
      )
    }
  }

  protected async getNFTInfo(
    nftAddress: string,
    signer: Signer,
    owner: string,
    timestamp: number
  ): Promise<any> {
    const nftContract = new ethers.Contract(nftAddress, ERC721Template.abi, signer)
    const state = parseInt((await nftContract.getMetaData())[2])
    const id = parseInt(await nftContract.getId())
    const tokenURI = await nftContract.tokenURI(id)
    return {
      state,
      address: nftAddress,
      name: await nftContract.name(),
      symbol: await nftContract.symbol(),
      owner,
      created: timestampToDateTime(timestamp),
      tokenURI
    }
  }

  protected async createOrUpdateDDO(ddo: VersionedDDO, method: string): Promise<any> {
    const db = await OceanNode.getInstance().getDatabase()
    try {
      const { ddo: ddoDatabase, ddoState } = db
      if (ddo instanceof DeprecatedDDO) {
        const { id, nftAddress } = ddo.getDDOFields()
        await Promise.all([ddoDatabase.delete(id), ddoState.delete(id)])
        const saveDDO = await ddoDatabase.create(ddo.getDDOData())
        await ddoState.create(this.networkId, saveDDO.id, nftAddress, undefined, true)

        return saveDDO
      }

      const saveDDO = await ddoDatabase.update({ ...ddo.getDDOData() })
      await ddoState.update(
        this.networkId,
        saveDDO.id,
        saveDDO.nftAddress,
        saveDDO.indexedMetadata?.event?.tx,
        true
      )
      INDEXER_LOGGER.debug(
        `Saved or updated DDO ${saveDDO.id} on chain ${this.networkId} (${method})`
      )
      return saveDDO
    } catch (err) {
      const { ddoState } = db
      const { id, nftAddress } = ddo.getDDOFields()
      const tx =
        ddo instanceof DeprecatedDDO
          ? undefined
          : ddo.getAssetFields().indexedMetadata?.event?.txid

      await ddoState.update(this.networkId, id, nftAddress, tx, true, err.message)
      INDEXER_LOGGER.error(
        `Chain ${this.networkId}: failed to save DDO ${id} (${method}): ${errorSummary(err)}`
      )
    }
  }

  protected checkDdoHash(decryptedDocument: any, documentHashFromContract: any): boolean {
    const utf8Bytes = toUtf8Bytes(JSON.stringify(decryptedDocument))
    const expectedMetadata = hexlify(utf8Bytes)
    if (create256Hash(expectedMetadata.toString()) !== documentHashFromContract) {
      INDEXER_LOGGER.debug(`DDO checksum does not match`)
      return false
    }
    return true
  }

  /**
   * ON-02: local, strictly-monotonic nonce for the DECRYPT_DDO signature.
   *
   * The remote `${decryptorURL}/api/services/nonce` GET was a nonce ORACLE: an attacker-chosen
   * host returned any value it liked (e.g. 9e15), which the node then signed over, so a harvested
   * signature sailed past every verifier's `nonce <= stored` check. We no longer trust a remote
   * nonce at all.
   *
   * `Date.now()` on its own is not enough: a backwards wall-clock adjustment, or two decrypts
   * within the same millisecond, can yield a non-increasing nonce. That is NOT self-healing — a
   * decrypt the verifier rejects with a 400/403 is deliberately not retried (see the status
   * handling in the `withRetrial` block below), so the DDO would silently fail to index until a
   * later Metadata event or a manual reindex. We therefore keep a per-processor high-water mark
   * and always return `max(now, last + 1)`: synchronous, so it is race-free on the single-threaded
   * indexer loop, and the value can only ever increase. No signature is ever leaked.
   */
  private lastLocalNonce = 0

  private getLocalNonce(): string {
    this.lastLocalNonce = Math.max(Date.now(), this.lastLocalNonce + 1)
    return this.lastLocalNonce.toString()
  }

  /**
   * ON-02: resolve (and cache) the DESTINATION node's peerId for the HTTP decrypt path.
   *
   * The signed DECRYPT_DDO message binds the verifier's peerId, so a signature minted for node A
   * cannot be replayed at node B. Over P2P the destination peerId is already known; over HTTP we
   * must learn it from the target node's root endpoint (`GET /` → `nodeId`). If it cannot be
   * obtained we return null and the caller MUST NOT send a (now cross-node-replayable) HTTP
   * decrypt — it fails the HTTP attempt instead.
   *
   * SSRF (#1575): the host is validated with `checkUrlHost` and the lookup goes through
   * `getSafeDispatcher`, so a malicious decryptorURL cannot point this fetch at a private
   * address, and the check re-runs on every redirect hop.
   */
  /**
   * Read an undici Response body as UTF-8 text, enforcing a hard byte cap while consuming the
   * stream. Returns null if there is no readable body or the cap is exceeded (the socket is
   * released in that case), so a malicious endpoint cannot stream an unbounded body into heap.
   */
  private async readCappedText(res: any, maxBytes: number): Promise<string | null> {
    const body = res?.body
    if (!body || typeof body.getReader !== 'function') {
      return null
    }
    const reader = body.getReader()
    const chunks: Uint8Array[] = []
    let received = 0
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (value) {
          received += value.length
          if (received > maxBytes) {
            try {
              await reader.cancel()
            } catch {}
            return null
          }
          chunks.push(value)
        }
      }
    } finally {
      try {
        reader.releaseLock?.()
      } catch {}
    }
    return Buffer.concat(chunks).toString('utf8')
  }

  private async getDecryptorPeerId(decryptorURL: string): Promise<string | null> {
    const cached = BaseEventProcessor.decryptorPeerIdCache.get(decryptorURL)
    if (cached && cached.expiresAt > Date.now()) {
      return cached.peerId
    }
    let peerId: string | null = null
    try {
      // SSRF (#1575): validate the host and route the lookup through the safe dispatcher so an
      // attacker-published decryptorURL cannot coerce the indexer into contacting a private /
      // loopback address; the dispatcher also re-checks every redirect hop.
      const ssrfErr = checkUrlHost(decryptorURL, this.config)
      if (ssrfErr) {
        INDEXER_LOGGER.error(
          `decryptDDO: refusing to resolve peerId from ${decryptorURL}: ${ssrfErr}`
        )
        return null
      }
      // Preserve any path prefix on decryptorURL (a node may be served under a sub-path, which
      // the decrypt POST `${decryptorURL}/api/services/decrypt` also keeps), and normalize the
      // trailing slash so the status endpoint is fetched from the same base without a `//`.
      const rootUrl = `${decryptorURL.replace(/\/+$/, '')}/`
      const res = (await (undiciFetch as any)(rootUrl, {
        dispatcher: getSafeDispatcher(this.config),
        signal: AbortSignal.timeout(20000)
      })) as Response
      if (res.status === 200) {
        // Bound the body before parsing: refuse an oversized declared Content-Length up front,
        // then cap the actual read while consuming the stream (so a chunked body without a
        // Content-Length is bounded too).
        const declaredLength = Number(res.headers.get('content-length'))
        if (
          Number.isFinite(declaredLength) &&
          declaredLength > MAX_NODEID_RESPONSE_BYTES
        ) {
          INDEXER_LOGGER.error(
            `decryptDDO: status body from ${decryptorURL} too large (${declaredLength} bytes); refusing peerId lookup`
          )
          try {
            await (res as any).body?.cancel?.()
          } catch {}
          return null
        }
        const text = await this.readCappedText(res, MAX_NODEID_RESPONSE_BYTES)
        if (text !== null) {
          const body = JSON.parse(text)
          if (body && typeof body.nodeId === 'string' && body.nodeId.length > 0) {
            peerId = body.nodeId
          }
        }
      }
    } catch (err) {
      INDEXER_LOGGER.error(
        `decryptDDO: could not resolve target peerId from ${decryptorURL}: ${errorSummary(
          err
        )}`
      )
    }
    // Only cache a successful resolution (with a TTL); never cache a failure, so a transient
    // error does not permanently disable HTTP decrypt for this URL.
    if (peerId) {
      // Evict the oldest entry when at capacity (simple FIFO cap; the TTL handles staleness).
      if (
        BaseEventProcessor.decryptorPeerIdCache.size >=
        BaseEventProcessor.DECRYPTOR_PEERID_CACHE_MAX
      ) {
        const oldest = BaseEventProcessor.decryptorPeerIdCache.keys().next().value
        if (oldest !== undefined) {
          BaseEventProcessor.decryptorPeerIdCache.delete(oldest)
        }
      }
      BaseEventProcessor.decryptorPeerIdCache.set(decryptorURL, {
        peerId,
        expiresAt: Date.now() + BaseEventProcessor.DECRYPTOR_PEERID_TTL_MS
      })
    } else {
      BaseEventProcessor.decryptorPeerIdCache.delete(decryptorURL)
    }
    return peerId
  }

  protected async decryptDDO(
    decryptorURL: string,
    flag: string,
    eventCreator: string,
    contractAddress: string,
    chainId: number,
    txId: string,
    metadataHash: string,
    metadata: any
  ): Promise<any> {
    let ddo
    // Log the flag value
    INDEXER_LOGGER.debug(`decryptDDO: flag=${flag}`)
    if ((parseInt(flag) & 2) !== 0) {
      INDEXER_LOGGER.debug(
        `Decrypting DDO from network: ${this.networkId} created by: ${eventCreator} encrypted by: ${decryptorURL}`
      )

      const oceanNode = OceanNode.getInstance()
      const keyManager = oceanNode.getKeyManager()
      const nodeId = keyManager.getPeerId().toString()
      const wallet = keyManager.getEthWallet()
      const ethAddress = wallet.address
      // ON-02: bind the signature to the exact resource. Checksum the nft address so it matches
      // the verifier, which checksum-normalizes `dataNftAddress` before rebuilding the message.
      const dataNftAddress = ethers.getAddress(contractAddress)

      if (URLUtils.isValidUrl(decryptorURL)) {
        // SSRF (#1575): reject a private/loopback decryptor host up front.
        const ssrfErrHttp = checkUrlHost(decryptorURL, this.config)
        if (ssrfErrHttp) {
          throw new Error(`Decryptor URL ${decryptorURL} rejected: ${ssrfErrHttp}`)
        }
        // ON-02: learn the DESTINATION node's peerId so the signature is bound to it. Without it
        // the signature would be cross-node replayable, so refuse to send an HTTP decrypt — the
        // crawl retries later (and a known-peer P2P path, where available, is bound instead).
        const targetPeerId = await this.getDecryptorPeerId(decryptorURL)
        if (!targetPeerId) {
          const message = `decryptDDO: cannot resolve destination peerId for ${decryptorURL}; refusing cross-node-replayable HTTP decrypt for tx ${txId}`
          INDEXER_LOGGER.error(message)
          throw new Error(message)
        }
        try {
          const response = await withRetrial(async () => {
            const nonce: string = this.getLocalNonce()
            INDEXER_LOGGER.debug(
              `decryptDDO: using local nonce ${nonce} for decrypt attempt`
            )

            const message = buildDecryptDDOSignatureMessage({
              decrypterAddress: ethAddress,
              nonce,
              issuerPeerId: targetPeerId,
              chainId,
              txId,
              dataNftAddress
            })
            const signature = await keyManager.signMessage(message)

            const payload = {
              transactionId: txId,
              chainId,
              decrypterAddress: ethAddress,
              dataNftAddress,
              signature,
              nonce
            }
            try {
              // fetch never throws on HTTP status; the manual status checks below
              // reproduce the previous axios validateStatus contract (2xx/400/403
              // handled here, everything else throws and is retried by withRetrial).
              const fetchRes = (await (undiciFetch as any)(
                `${decryptorURL}/api/services/decrypt`,
                {
                  method: 'POST',
                  headers: { 'content-type': 'application/json' },
                  body: JSON.stringify(payload),
                  dispatcher: getSafeDispatcher(this.config),
                  signal: AbortSignal.timeout(30000)
                }
              )) as Response
              // axios's default transformResponse parsed JSON regardless of the
              // content-type, falling back to the raw string. The decrypt endpoint
              // returns the DDO as JSON but with a text/plain content-type, so a
              // content-type gate would wrongly keep it a string and downstream
              // create256Hash would receive an object. Replicate axios here.
              const rawBody = await fetchRes.text()
              let parsedBody: any = rawBody
              try {
                parsedBody = JSON.parse(rawBody)
              } catch {
                // not JSON — keep the raw string, same as axios did
              }
              const res = {
                status: fetchRes.status,
                statusText: fetchRes.statusText,
                data: parsedBody
              }

              INDEXER_LOGGER.debug(
                `decryptDDO: response ${res.status} ${res.statusText} from ${decryptorURL}`
              )

              if (res.status === 400 || res.status === 403) {
                // Return error response, to avoid retry for unnecessary errors
                INDEXER_LOGGER.debug(
                  `Provider exception on decrypt DDO for tx ${txId}. Status: ${res.status}, ${res.statusText}`
                )
                return res
              }

              if (res.status !== 200 && res.status !== 201) {
                const message = `bProvider exception on decrypt DDO. Status: ${res.status}, ${res.statusText}`
                INDEXER_LOGGER.debug(message)
                throw new Error(message) // Retry 5XX errors
              }
              return res
            } catch (err: any) {
              // Retry ONLY on ECONNREFUSED. fetch wraps the OS error in
              // `err.cause`, so check both there and on the error itself.
              if (
                err.code === 'ECONNREFUSED' ||
                err.cause?.code === 'ECONNREFUSED' ||
                (err.message && err.message.includes('ECONNREFUSED'))
              ) {
                INDEXER_LOGGER.error(
                  `Decrypt request to ${decryptorURL} failed with ECONNREFUSED, retrying...`
                )
                throw err
              }

              throw err
            }
          })

          if (response.status === 400 || response.status === 403) {
            throw new Error(`Provider validation failed: ${response.statusText}`)
          }

          let responseHash
          if (response.data instanceof Object) {
            responseHash = create256Hash(JSON.stringify(response.data))
            ddo = response.data
          } else {
            ddo = JSON.parse(response.data)
            responseHash = create256Hash(ddo)
          }
          if (responseHash !== metadataHash) {
            const msg = `Hash check failed: response=${ddo}, decrypted ddo hash=${responseHash}\n metadata hash=${metadataHash}`
            INDEXER_LOGGER.debug(
              `decryptDDO: hash check failed for tx ${txId} (decrypted ${responseHash}, metadata ${metadataHash})`
            )
            throw new Error(msg)
          }
        } catch (err) {
          const message = `Provider exception on decrypt DDO. Status: ${errorSummary(err)}`
          INDEXER_LOGGER.error(
            `decryptDDO: decrypt via ${decryptorURL} failed for tx ${txId}: ${errorSummary(err)}`
          )
          throw new Error(message)
        }
      } else {
        if (nodeId === decryptorURL) {
          // ON-02: local decrypt — the verifier IS this node, so bind to our own peerId and use
          // a local monotonic nonce (no remote nonce oracle). Bound to chainId/txId/nft too.
          const nonceP2p: string = this.getLocalNonce()
          INDEXER_LOGGER.debug(
            `decryptDDO: using local nonce ${nonceP2p} for decrypt attempt on local nodeId ${nodeId}`
          )

          const message = buildDecryptDDOSignatureMessage({
            decrypterAddress: ethAddress,
            nonce: nonceP2p,
            issuerPeerId: nodeId,
            chainId,
            txId,
            dataNftAddress
          })
          const signature = await keyManager.signMessage(message)

          const decryptDDOTask: DecryptDDOCommand = {
            command: PROTOCOL_COMMANDS.DECRYPT_DDO,
            transactionId: txId,
            decrypterAddress: ethAddress,
            chainId,
            encryptedDocument: metadata,
            documentHash: metadataHash,
            dataNftAddress,
            signature,
            nonce: nonceP2p
          }
          try {
            const response = await oceanNode
              .getCoreHandlers()
              .getHandler(PROTOCOL_COMMANDS.DECRYPT_DDO)
              .handle(decryptDDOTask)
            ddo = JSON.parse(
              await streamToString(response.stream as Readable, MAX_DDO_RESPONSE_BYTES)
            )
          } catch (error) {
            const message = `Node exception on decrypt DDO from local nodeId ${nodeId}. Status: ${errorSummary(error)}`
            INDEXER_LOGGER.error(
              `decryptDDO: local decrypt failed for tx ${txId}: ${errorSummary(error)}`
            )
            throw new Error(message)
          }
        } else {
          // it's a remote node — the destination peerId IS `decryptorURL`.
          try {
            const p2pNode = await oceanNode.getP2PNode()
            // ON-02: local monotonic nonce (no remote nonce oracle), and the signature is bound
            // to the destination peerId (decryptorURL) + chainId/txId/nft, so it cannot be
            // replayed at any other node or for any other asset.
            const remoteNonce: string = this.getLocalNonce()
            INDEXER_LOGGER.debug(
              `decryptDDO: using local nonce ${remoteNonce} for decrypt attempt on remote node ${decryptorURL}`
            )

            const messageToSign = buildDecryptDDOSignatureMessage({
              decrypterAddress: ethAddress,
              nonce: remoteNonce,
              issuerPeerId: decryptorURL,
              chainId,
              txId,
              dataNftAddress
            })
            const signature = await keyManager.signMessage(messageToSign)

            const message = {
              command: PROTOCOL_COMMANDS.DECRYPT_DDO,
              transactionId: txId,
              decrypterAddress: ethAddress,
              chainId,
              encryptedDocument: metadata,
              documentHash: metadataHash,
              dataNftAddress,
              signature,
              nonce: remoteNonce
            }

            // No `signal`: `decryptDDO` takes none and owns no controller, so there is
            // nothing to thread. Setup is bounded by sendTo's own deadline and the response
            // body by the body ceiling; giving this call a locally-invented deadline would
            // mean picking a number tighter or looser than those, which is a budget decision
            // and belongs with the other P2P budgets rather than here.
            const response = await p2pNode.sendTo(decryptorURL, JSON.stringify(message))

            if (response.status.httpStatus !== 200) {
              const logMessage = `Node exception on decryptDDO from remote nodeId ${nodeId}. Status: ${response.status.httpStatus} ${response.status.error}`
              INDEXER_LOGGER.debug(
                `decryptDDO: decrypt request to remote node ${decryptorURL} failed (tx ${txId}): ${response.status.httpStatus} ${response.status.error}`
              )
              throw new Error(logMessage)
            }

            if (!response.stream) {
              const logMessage = `No stream for decryptDDO from remote nodeId ${nodeId}. Status: ${response.status.httpStatus} ${response.status.error}`
              INDEXER_LOGGER.debug(
                `decryptDDO: decrypt request to remote node ${decryptorURL} returned no stream (tx ${txId}): ${response.status.httpStatus} ${response.status.error}`
              )
              throw new Error(logMessage)
            }

            // Convert stream to Uint8Array
            const data = await streamToUint8Array(
              response.stream as Readable,
              MAX_DDO_RESPONSE_BYTES
            )
            ddo = JSON.parse(uint8ArrayToString(data))
          } catch (error) {
            const message = `Exception from remote nodeId ${nodeId}. Status: ${errorSummary(error)}`
            INDEXER_LOGGER.error(
              `decryptDDO: remote node ${decryptorURL} failed for tx ${txId}: ${errorSummary(error)}`
            )
            throw new Error(message)
          }
        }
      }
    } else {
      INDEXER_LOGGER.debug(
        `Decompressing DDO  from network: ${this.networkId} created by: ${eventCreator} encrypted by: ${decryptorURL}`
      )
      const byteArray = getBytes(metadata)
      const utf8String = toUtf8String(byteArray)
      ddo = JSON.parse(utf8String)
    }

    return ddo
  }

  public abstract processEvent(
    event: ethers.Log,
    chainId: number,
    signer: Signer,
    provider: FallbackProvider,
    eventName?: string
  ): Promise<any>
}
