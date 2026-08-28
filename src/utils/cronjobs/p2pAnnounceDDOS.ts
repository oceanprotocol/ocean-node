// republish the ddos we have
// related: https://github.com/libp2p/go-libp2p-kad-dht/issues/323

import { OceanNode } from '../../OceanNode.js'
import { P2P_LOGGER } from '../logging/common.js'
import { provideLimit } from '../../components/P2P/provideLimiter.js'
import { logProvideFailure } from '../../components/P2P/errors.js'

/**
 * How many documents to ask each schema for per round trip. Kept well under the Typesense
 * per-page cap (250) so the same number is legal on both backends, and small enough that a
 * page's worth of provides drains through the shared limiter before the next page is fetched.
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
   * True when at least one schema filled its page, which is the only signal either backend
   * gives that there may be more. Neither returns a reliable total across all schemas: the
   * Elasticsearch path returns bare document arrays with no count at all, and the Typesense
   * path returns a per-collection `found` that says nothing about the other collections.
   */
  hasFullBatch: boolean
}

/**
 * The two DDO backends answer a search with different shapes, and the republish has to read
 * both:
 *
 *  - Elasticsearch returns one plain array of documents per schema that had hits (schemas with
 *    no hits are simply absent), each document already flattened out of `hits.hits[]._source`.
 *  - Typesense returns one response object per collection, always, each with `found` (that
 *    collection's total) and `hits[]`, where the document sits under `hit.document`.
 *
 * Reading only `result[0].found` / `result[0].hits` - a Typesense-only shape - meant the
 * Elasticsearch path never iterated at all, and the Typesense path only ever looked at the
 * first collection, which for a node holding current DDOs is the empty deprecated-DDO one.
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
    let rawCount = 0
    let batch: any[] = []
    if (Array.isArray(perSchema)) {
      rawCount = perSchema.length
      batch = perSchema.filter((document: any) => document && document.id)
    } else if (perSchema && Array.isArray(perSchema.hits)) {
      rawCount = perSchema.hits.length
      batch = perSchema.hits
        .map((hit: any) => hit?.document)
        .filter((document: any) => document && document.id)
    }
    documents.push(...batch)
    if (rawCount >= pageSize) {
      hasFullBatch = true
    }
  }
  return { documents, hasFullBatch }
}

/**
 * Ask for one page of every DDO the node holds, in the form the backend in front of us
 * actually accepts.
 *
 * On Elasticsearch the query object is spread straight into the request body, so `q` - a URI
 * search parameter, not a body key - makes the whole request fail with `Unknown key for a
 * VALUE_STRING in [q]`. That failure is caught and skipped per schema, which is why the
 * republish used to find nothing on the default backend without ever reporting an error. The
 * body form of match-everything is `query: { match_all: {} }`; note that `from` there is a
 * 1-based *page number*, not a document offset - that layer converts it.
 *
 * On Typesense `q: '*'` is the documented match-everything wildcard and needs no `query_by`,
 * and paging is passed as the second and third arguments rather than inside the query.
 *
 * Known ceiling, stated so it is not rediscovered as a bug: Elasticsearch refuses a
 * `from` + `size` window larger than `index.max_result_window` (10000 by default) with
 * "Result window is too large", and the database layer catches that per schema like any other
 * failure - so a *single* index holding more than 10000 DDOs re-provides only the first 10000
 * of them, quietly. Lifting that means paging with `search_after` or a point-in-time cursor
 * instead of an offset, which is a change to the database layer, not to this job.
 */
function searchDdoPage(
  ddoDb: any,
  useElasticQuery: boolean,
  page: number,
  pageSize: number
): Promise<any> {
  if (useElasticQuery) {
    return ddoDb.search({ query: { match_all: {} }, size: pageSize, from: page })
  }
  return ddoDb.search({ q: '*' }, pageSize, page)
}

/**
 * Which query form to send, decided from the shape of the schemas the DDO database carries: an
 * Elasticsearch schema names an `index`, a Typesense one a `name`. Read off the schemas rather
 * than off the configured database type because the schemas are what the search call is going
 * to be issued against, and they are reachable through the public interface.
 */
function usesElasticQuery(ddoDb: any): boolean {
  const schemas = typeof ddoDb.getSchemas === 'function' ? ddoDb.getSchemas() : []
  return Array.isArray(schemas) && schemas.length > 0 && schemas[0]?.index !== undefined
}

export async function p2pAnnounceDDOS(node: OceanNode) {
  try {
    const db = await node.getDatabase()
    const p2pNode = node.getP2PNode()
    if (!db || !db.ddo || !p2pNode) {
      P2P_LOGGER.info(
        `republishStoredDDOS() attempt aborted because there is no database or P2P is not available!`
      )
      return
    }
    const ddoDb = db.ddo
    const useElasticQuery = usesElasticQuery(ddoDb)

    let advertised = 0
    let seen = 0
    let page = 1
    // Walk until the store is exhausted. Fetching a single page and stopping meant everything
    // past the first page - and, on Typesense, everything outside the first collection - was
    // never re-provided, so those DIDs stayed unreachable until something else advertised them.
    while (page <= MAX_REPUBLISH_PAGES) {
      const result = await searchDdoPage(
        ddoDb,
        useElasticQuery,
        page,
        REPUBLISH_PAGE_SIZE
      )
      const { documents, hasFullBatch } = extractPage(result, REPUBLISH_PAGE_SIZE)
      if (documents.length === 0) {
        break
      }
      seen += documents.length
      P2P_LOGGER.logMessage(
        `Will republish cid for ${documents.length} documents (page ${page})`,
        true
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
      P2P_LOGGER.logMessage('There is nothing to republish, skipping...', true)
      return
    }
    // A real count: `advertiseString` rejects on a failed provide, so the catch above fires
    // and that hit is not counted, and it returns false when it only queued the DID.
    P2P_LOGGER.logMessage(`Republished cid for ${advertised}/${seen} documents`, true)
  } catch (err) {
    P2P_LOGGER.error(`Caught "${err.message}" on republishStoredDDOS()`)
  }
}
