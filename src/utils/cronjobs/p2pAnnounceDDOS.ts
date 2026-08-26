// republish the ddos we have
// related: https://github.com/libp2p/go-libp2p-kad-dht/issues/323

import { OceanNode } from '../../OceanNode.js'
import { P2P_LOGGER } from '../logging/common.js'
import { provideLimit } from '../../components/P2P/provideLimiter.js'

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
    const searchParameters = {
      q: '*'
    }

    const result: any = await ddoDb.search(searchParameters)
    if (result && result.length > 0 && result[0].found) {
      P2P_LOGGER.logMessage(`Will republish cid for ${result[0].found} documents`, true)
      // bounded concurrency and a real await. `hits.forEach(hit => advertiseString(...))`
      // returned before a single provide had completed, so nothing capped the fan-out and the
      // caller could not know when (or whether) the republish finished.
      let advertised = 0
      await Promise.all(
        result[0].hits.map((hit: any) =>
          provideLimit(async () => {
            const ddo = hit.document
            try {
              // `advertiseString` returns false when it could not provide right now and
              // queued the DID for a later flush instead, so only a true counts as
              // advertised. The DDO is cached either way - that is a local read path and
              // does not depend on the provider record being written.
              const provided = await p2pNode.advertiseString(ddo.id)
              p2pNode.cacheDDO(ddo)
              if (provided) {
                advertised++
              }
            } catch (e) {
              P2P_LOGGER.error(
                `Caught "${e.message}" while republishing ${ddo?.id} on republishStoredDDOS()`
              )
            }

            // todo check stuff like purgatory
          })
        )
      )
      // A real count: `advertiseString` rejects on a failed provide, so the catch above fires
      // and that hit is not counted, and it returns false when it only queued the DID.
      P2P_LOGGER.logMessage(
        `Republished cid for ${advertised}/${result[0].hits.length} documents`,
        true
      )
      // update time
    } else {
      P2P_LOGGER.logMessage('There is nothing to republish, skipping...', true)
    }
  } catch (err) {
    P2P_LOGGER.error(`Caught "${err.message}" on republishStoredDDOS()`)
  }
}
