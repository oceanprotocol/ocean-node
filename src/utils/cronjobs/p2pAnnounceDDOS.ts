// republish the ddos we have
// related: https://github.com/libp2p/go-libp2p-kad-dht/issues/323

import { OceanNode } from '../../OceanNode.js'
import { P2P_LOGGER } from '../logging/common.js'

export async function p2pAnnounceDDOS(node: OceanNode) {
  try {
    const db = node.getDatabase()
    const p2pNode = node.getP2PNode()
    if (!db || !db.ddo) {
      P2P_LOGGER.info(
        `republishStoredDDOS() attempt aborted because there is no database!`
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
      result[0].hits.forEach((hit: any) => {
        const ddo = hit.document
        p2pNode.advertiseString(ddo.id)
        p2pNode.cacheDDO(ddo)

        // todo check stuff like purgatory
      })
      // update time
    } else {
      P2P_LOGGER.logMessage('There is nothing to republish, skipping...', true)
    }
  } catch (err) {
    P2P_LOGGER.error(`Caught "${err.message}" on republishStoredDDOS()`)
  }
}
