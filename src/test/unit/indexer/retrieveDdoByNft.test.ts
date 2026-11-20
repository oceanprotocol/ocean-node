import { expect } from 'chai'
import { deriveDid } from '@oceanprotocol/ddo-js'
import {
  buildShortDdoRecord,
  retrieveDdoByNft
} from '../../../components/Indexer/utils.js'

// Contract events (orders, prices, dispensers, metadata state) only give the NFT address and
// chain id. Before, the processors derived the v4 DID (did:op:) only, so events for a v5 asset
// (indexed under did:ope:) were never applied to it.

const NFT_ADDRESS = '0xBB1081DbF3227bbB233Db68f7117114baBb43656'
const CHAIN_ID = 137
const DID_V4 = deriveDid(NFT_ADDRESS, CHAIN_ID, '4')
const DID_V5 = deriveDid(NFT_ADDRESS, CHAIN_ID, '5')

function fakeDdoDatabase(stored: Record<string, any>) {
  const lookups: string[] = []
  return {
    lookups,
    retrieve(did: string): Promise<Record<string, any> | null> {
      lookups.push(did)
      return Promise.resolve(stored[did] ?? null)
    }
  }
}

describe('retrieveDdoByNft', () => {
  it('finds a v4 DDO', async () => {
    const db = fakeDdoDatabase({ [DID_V4]: { id: DID_V4 } })
    const { did, ddo } = await retrieveDdoByNft(db, NFT_ADDRESS, CHAIN_ID)
    expect(did).to.equal(DID_V4)
    expect(ddo).to.deep.equal({ id: DID_V4 })
    expect(db.lookups).to.deep.equal([DID_V4, DID_V5])
  })

  it('finds a v5 DDO indexed under did:ope:', async () => {
    const db = fakeDdoDatabase({ [DID_V5]: { id: DID_V5 } })
    const { did, ddo } = await retrieveDdoByNft(db, NFT_ADDRESS, CHAIN_ID)
    expect(did).to.equal(DID_V5)
    expect(ddo).to.deep.equal({ id: DID_V5 })
    expect(db.lookups).to.deep.equal([DID_V4, DID_V5])
  })

  // Republishing an NFT with the other DDO version indexes it under the other DID and
  // leaves the old record, so both can exist. Events must go to the current one.
  // v4 keeps nftAddress at the top level, v5 under credentialSubject
  const published = (id: string, block?: number): Record<string, any> => {
    const indexedMetadata = block === undefined ? {} : { event: { block } }
    return id === DID_V5
      ? {
          id,
          version: '5.0.0',
          credentialSubject: { id, nftAddress: NFT_ADDRESS, chainId: CHAIN_ID },
          indexedMetadata
        }
      : {
          id,
          version: '4.1.0',
          nftAddress: NFT_ADDRESS,
          chainId: CHAIN_ID,
          indexedMetadata
        }
  }

  it('returns the later published DDO when both DIDs are indexed', async () => {
    const v4ThenV5 = fakeDdoDatabase({
      [DID_V4]: published(DID_V4, 100),
      [DID_V5]: published(DID_V5, 200)
    })
    expect((await retrieveDdoByNft(v4ThenV5, NFT_ADDRESS, CHAIN_ID)).did).to.equal(DID_V5)
    const v5ThenV4 = fakeDdoDatabase({
      [DID_V4]: published(DID_V4, 300),
      [DID_V5]: published(DID_V5, 200)
    })
    const { did, ddo } = await retrieveDdoByNft(v5ThenV4, NFT_ADDRESS, CHAIN_ID)
    expect(did).to.equal(DID_V4)
    expect(ddo.id).to.equal(DID_V4)
  })

  it('prefers the v5 DDO when both DIDs are indexed without a later block', async () => {
    const sameBlock = fakeDdoDatabase({
      [DID_V4]: published(DID_V4, 100),
      [DID_V5]: published(DID_V5, 100)
    })
    expect((await retrieveDdoByNft(sameBlock, NFT_ADDRESS, CHAIN_ID)).did).to.equal(
      DID_V5
    )
    const noBlocks = fakeDdoDatabase({
      [DID_V4]: published(DID_V4),
      [DID_V5]: published(DID_V5)
    })
    expect((await retrieveDdoByNft(noBlocks, NFT_ADDRESS, CHAIN_ID)).did).to.equal(DID_V5)
  })

  it('keeps the current publication selected after it is revoked', async () => {
    const stored: Record<string, any> = {
      [DID_V4]: published(DID_V4, 100),
      [DID_V5]: published(DID_V5, 200)
    }
    const db = fakeDdoDatabase(stored)
    const before = await retrieveDdoByNft(db, NFT_ADDRESS, CHAIN_ID)
    expect(before.did).to.equal(DID_V5)

    // MetadataState / MetadataEvent processors replace the revoked DDO with a short one
    stored[before.did] = buildShortDdoRecord(before.ddo, CHAIN_ID, 8)
    expect(stored[DID_V5].indexedMetadata.event.block).to.equal(200)

    const after = await retrieveDdoByNft(db, NFT_ADDRESS, CHAIN_ID)
    expect(after.did).to.equal(DID_V5)
    expect(after.ddo.version).to.equal('deprecated')
    expect(after.ddo.indexedMetadata.nft.state).to.equal(8)
  })

  it('builds a short DDO without event when the full DDO has none', () => {
    const shortDdo = buildShortDdoRecord(published(DID_V4), CHAIN_ID, 2)
    expect(shortDdo).to.deep.equal({
      id: DID_V4,
      version: 'deprecated',
      chainId: CHAIN_ID,
      nftAddress: NFT_ADDRESS,
      indexedMetadata: { nft: { state: 2 } }
    })
  })

  // createOrUpdateDDO recreates the DDO and its state from the short record, so a missing
  // address would drop the NFT identity of a revoked v5 asset
  it('keeps the nested v5 NFT address in the short DDO', () => {
    const v5 = published(DID_V5, 200)
    expect(v5.nftAddress).to.equal(undefined)
    const shortDdo = buildShortDdoRecord(v5, CHAIN_ID, 8)
    expect(shortDdo).to.deep.equal({
      id: DID_V5,
      version: 'deprecated',
      chainId: CHAIN_ID,
      nftAddress: NFT_ADDRESS,
      indexedMetadata: { nft: { state: 8 }, event: { block: 200 } }
    })
  })

  it('returns a null DDO and the v4 DID when neither is indexed', async () => {
    const db = fakeDdoDatabase({})
    const { did, ddo } = await retrieveDdoByNft(db, NFT_ADDRESS, CHAIN_ID)
    expect(did).to.equal(DID_V4)
    expect(ddo).to.equal(null)
  })

  it('matches the NFT address in any letter case', async () => {
    const db = fakeDdoDatabase({ [DID_V5]: { id: DID_V5 } })
    const { did } = await retrieveDdoByNft(db, NFT_ADDRESS.toLowerCase(), CHAIN_ID)
    expect(did).to.equal(DID_V5)
  })
})
