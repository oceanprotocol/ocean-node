// republish the ddos we have
// related: https://github.com/libp2p/go-libp2p-kad-dht/issues/323

import { OceanNode } from '../../OceanNode.js'
import { P2P_LOGGER } from '../logging/common.js'
import { provideLimit } from '../../components/P2P/provideLimiter.js'
import {
  classifyP2PError,
  logProvideFailure,
  P2P_ERROR
} from '../../components/P2P/errors.js'

/**
 * How many documents to ask each schema for per round trip. Small enough that a page's worth
 * of provides drains through the shared limiter before the next page is fetched.
 */
const REPUBLISH_PAGE_SIZE = 100

/**
 * A stop so a backend that keeps answering with full pages - a paging bug, a store that grows
 * while we walk it - cannot turn startup into an unbounded loop. At the page size above this
 * is a million documents, far past any real node.
 */
const MAX_REPUBLISH_PAGES = 10_000

interface DdoPage {
  documents: any[]
  /**
   * True when at least one schema filled its page, which is the only signal the DDO store
   * gives that there may be more: it returns bare document arrays with no count at all.
   */
  hasFullBatch: boolean
}

/**
 * The DDO store returns one plain array of documents per schema that had hits (schemas with
 * no hits are simply absent).
 */
function extractPage(result: any, pageSize: number): DdoPage {
  const documents: any[] = []
  let hasFullBatch = false
  if (!Array.isArray(result)) {
    return { documents, hasFullBatch }
  }
  for (const perSchema of result) {
    // The raw page size decides whether the page was full - measured before filtering, because a
    // page that came back full but held documents without an id still means the store may have
    // more pages. Testing the filtered count instead would drop `hasFullBatch` to false on such
    // a page and stop the walk early, leaving later pages never re-provided.
    if (!Array.isArray(perSchema)) continue
    documents.push(...perSchema.filter((document: any) => document && document.id))
    if (perSchema.length >= pageSize) {
      hasFullBatch = true
    }
  }
  return { documents, hasFullBatch }
}

/**
 * Ask for one page of every DDO the node holds.
 *
 * The match-everything query is `query: { match_all: {} }`; note that `from` there is a
 * 1-based *page number*, not a document offset - the database layer converts it.
 *
 * Known ceiling, stated so it is not rediscovered as a bug: a backend can refuse a deep
 * `from` + `size` window (10000 documents by default on one backend), and the database layer
 * catches that per schema like any other failure - so a *single* schema holding more DDOs
 * than that re-provides only the first ones, quietly. Lifting that means paging with a
 * cursor instead of an offset, which is a change to the database layer, not to this job.
 */
function searchDdoPage(ddoDb: any, page: number, pageSize: number): Promise<any> {
  return ddoDb.search({ query: { match_all: {} }, size: pageSize, from: page })
}

export async function p2pAnnounceDDOS(node: OceanNode) {
  try {
    const db = await node.getDatabase()
    const p2pNode = node.getP2PNode()
    if (!db || !db.ddo || !p2pNode) {
      P2P_LOGGER.debug(
        'republishStoredDDOS() skipped: no database or P2P is not available'
      )
      return
    }
    const ddoDb = db.ddo

    let advertised = 0
    let seen = 0
    let failed = 0
    let cacheFailed = 0
    let page = 1
    // Walk until the store is exhausted. Fetching a single page and stopping meant everything
    // past the first page was
    // never re-provided, so those DIDs stayed unreachable until something else advertised them.
    while (page <= MAX_REPUBLISH_PAGES) {
      const result = await searchDdoPage(ddoDb, page, REPUBLISH_PAGE_SIZE)
      const { documents, hasFullBatch } = extractPage(result, REPUBLISH_PAGE_SIZE)
      if (documents.length === 0) {
        break
      }
      seen += documents.length
      P2P_LOGGER.debug(
        `Will republish cid for ${documents.length} documents (page ${page})`
      )
      // bounded concurrency and a real await. `hits.forEach(hit => advertiseString(...))`
      // returned before a single provide had completed, so nothing capped the fan-out and the
      // caller could not know when (or whether) the republish finished.
      await Promise.all(
        documents.map((ddo: any) =>
          provideLimit(async () => {
            try {
              // `advertiseString` returns false when it could not provide right now and
              // queued the DID for a later flush instead, so only a true counts as
              // advertised.
              if (await p2pNode.advertiseString(ddo.id)) {
                advertised++
              }
            } catch (e) {
              // timeouts are normal in a sparse DHT: only other failures count towards the summary
              if (classifyP2PError(e).name !== P2P_ERROR.timeout) failed++
              logProvideFailure(
                P2P_LOGGER,
                e,
                `Caught error while republishing ${ddo?.id} on republishStoredDDOS()`
              )
            }
            try {
              // Cached either way - that is a local read path and does not depend on the
              // provider record being written. Guarded separately from the provide because
              // `cacheDDO` dereferences `ddo.metadata.updated` unconditionally: one stored
              // document without a `metadata` object used to throw *after* a successful
              // provide, which both suppressed that document's count and, sharing a catch with
              // the provide, made the failure read as a DHT failure it was not.
              p2pNode.cacheDDO(ddo)
            } catch (e) {
              cacheFailed++
              P2P_LOGGER.error(
                `Caught "${e.message}" while caching ${ddo?.id} on republishStoredDDOS()`
              )
            }

            // todo check stuff like purgatory
          })
        )
      )
      if (!hasFullBatch) {
        break
      }
      page++
    }

    if (page > MAX_REPUBLISH_PAGES) {
      P2P_LOGGER.warn(
        `Stopped republishing after ${MAX_REPUBLISH_PAGES} pages; the store still reports more documents`
      )
    }

    if (seen === 0) {
      P2P_LOGGER.debug('There is nothing to republish, skipping...')
      return
    }
    // A real count: `advertiseString` rejects on a failed provide, so the catch above fires
    // and that hit is not counted, and it returns false when it only queued the DID.
    const summary = `Re-announced ${advertised}/${seen} DDOs to the DHT`
    if (failed > 0 || cacheFailed > 0) {
      P2P_LOGGER.warn(
        `${summary} (${failed} provide failures, ${cacheFailed} cache failures)`
      )
    } else {
      P2P_LOGGER.info(summary)
    }
  } catch (err) {
    P2P_LOGGER.error(`Caught "${err.message}" on republishStoredDDOS()`)
  }
}
