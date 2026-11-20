// republish the ddos we have
// related: https://github.com/libp2p/go-libp2p-kad-dht/issues/323

import { OceanNode } from '../../OceanNode.js'
import { P2P_LOGGER } from '../logging/common.js'
import { provideLimit } from '../../components/P2P/provideLimiter.js'
import type { Condition, SortSpec } from '../../components/database/BaseDatabase.js'
import { DDO_FIELDS } from '../../components/database/assetQuery.js'
import {
  classifyP2PError,
  logProvideFailure,
  P2P_ERROR
} from '../../components/P2P/errors.js'

/**
 * How many documents to ask for per round trip. Small enough that a page's worth of provides
 * drains through the shared limiter before the next page is fetched.
 */
const REPUBLISH_PAGE_SIZE = 100
const BY_ID: SortSpec[] = [{ paths: DDO_FIELDS.id, order: 'asc' }]

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
    // Walk all DDOs, every state, in the order of the id. Each page starts after the last
    // id of the page before, not at an offset: Elasticsearch refuses an offset past its
    // result window (10,000 documents).
    let lastId: string | undefined
    for (;;) {
      const afterLast: Condition[] = lastId
        ? [{ paths: DDO_FIELDS.id, range: { gt: lastId } }]
        : []
      const { results } = await ddoDb.find(afterLast, BY_ID, {
        offset: 0,
        limit: REPUBLISH_PAGE_SIZE
      })
      const documents = results.filter((document: any) => document && document.id)
      if (documents.length === 0) {
        break
      }
      seen += documents.length
      lastId = documents[documents.length - 1].id
      P2P_LOGGER.debug(`Will republish cid for ${documents.length} documents`)
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
      if (results.length < REPUBLISH_PAGE_SIZE) {
        break
      }
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
