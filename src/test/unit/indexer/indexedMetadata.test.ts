import { expect } from 'chai'
import { DDOManager } from '@oceanprotocol/ddo-js'

// The stats processors (OrderStarted/Reused, Exchange*, Dispenser*) initialise a missing
// indexedMetadata with updateFields({ indexedMetadata: {} }) and then read
// indexedMetadata.stats. With ddo-js 1.0.0 that call was a no-op on a DDO that had no
// indexedMetadata, so the next read threw a TypeError and the event was not indexed.
// ddo-js 1.1.0 creates indexedMetadata in updateFields; these tests pin that behaviour.
// Deprecated DDOs are left out: the node always builds them with indexedMetadata.nft
// (MetadataStateEventProcessor) and DeprecatedDDO keeps no stats.

const NFT_ADDRESS = '0xBB1081DbF3227bbB233Db68f7117114baBb43656'
const STATS: any[] = [
  {
    datatokenAddress: '0x0000000000000000000000000000000000000001',
    name: 'DT',
    serviceId: '0',
    orders: 0,
    prices: []
  }
]

function ddosWithoutIndexedMetadata(): Record<string, any>[] {
  return [
    {
      '@context': ['https://w3id.org/did/v1'],
      id: 'did:op:fa0e8fa9550e8eb13392d6eeb9ba9f8111801b332c8d2345b350b3bc66b379d5',
      version: '4.1.0',
      chainId: 137,
      nftAddress: NFT_ADDRESS,
      metadata: { type: 'dataset', name: 'v4' },
      services: []
    },
    {
      '@context': ['https://www.w3.org/ns/credentials/v2'],
      id: 'did:ope:fa0e8fa9550e8eb13392d6eeb9ba9f8111801b332c8d2345b350b3bc66b379d5',
      version: '5.0.0',
      credentialSubject: {
        id: 'did:ope:fa0e8fa9550e8eb13392d6eeb9ba9f8111801b332c8d2345b350b3bc66b379d5',
        chainId: 137,
        nftAddress: NFT_ADDRESS,
        metadata: { type: 'dataset', name: 'v5' },
        services: []
      }
    }
  ]
}

describe('Indexer stats on a DDO without indexedMetadata', () => {
  for (const ddo of ddosWithoutIndexedMetadata()) {
    it(`processor init sequence creates indexedMetadata.stats (version ${ddo.version})`, () => {
      const ddoInstance = DDOManager.getDDOClass(ddo)
      expect(ddoInstance.getAssetFields().indexedMetadata).to.equal(undefined)

      // Same sequence as the stats processors
      if (!ddoInstance.getAssetFields().indexedMetadata) {
        ddoInstance.updateFields({ indexedMetadata: {} })
      }
      if (!Array.isArray(ddoInstance.getAssetFields().indexedMetadata.stats)) {
        ddoInstance.updateFields({ indexedMetadata: { stats: [] } })
      }

      expect(ddoInstance.getAssetFields().indexedMetadata.stats).to.deep.equal([])
    })

    it(`updateFields({ indexedMetadata: { stats } }) writes stats directly (version ${ddo.version})`, () => {
      const ddoInstance = DDOManager.getDDOClass(ddo)
      ddoInstance.updateFields({ indexedMetadata: { stats: STATS } })
      expect(ddoInstance.getAssetFields().indexedMetadata.stats).to.deep.equal(STATS)
    })
  }
})
