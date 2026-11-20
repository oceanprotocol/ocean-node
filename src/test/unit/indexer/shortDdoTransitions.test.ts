import { expect } from 'chai'
import sinon from 'sinon'
import { AbiCoder, Interface, Signer, ethers, id } from 'ethers'
import { deriveDid } from '@oceanprotocol/ddo-js'
import ERC721Template from '@oceanprotocol/contracts/artifacts/contracts/templates/ERC721Template.sol/ERC721Template.json' with { type: 'json' }
import { EVENT_PROCESSOR_MAP } from '../../../components/Indexer/processor.js'
import { retrieveDdoByNft } from '../../../components/Indexer/utils.js'
import { EVENTS, MetadataStates } from '../../../utils/constants.js'
import { OceanNodeConfig } from '../../../@types/OceanNode.js'

// A revoked asset is stored as a short DDO that keeps indexedMetadata.event, so
// retrieveDdoByNft still picks it over an older publication under the other DID.
// DeprecatedDDO.getAssetFields() nulls that event in place, so a second state change
// (e.g. Revoked -> Deprecated) must not call it before the record is saved again.

const CHAIN_ID = 137 // has an ERC721Factory in the contracts address file
const NFT_ADDRESS = '0xBB1081DbF3227bbB233Db68f7117114baBb43656'
const OWNER = '0x0000000000000000000000000000000000000ABC'
const DID_V4 = deriveDid(NFT_ADDRESS, CHAIN_ID, '4')
const DID_V5 = deriveDid(NFT_ADDRESS, CHAIN_ID, '5')

const published = (did: string, block: number): Record<string, any> => {
  const indexedMetadata = { nft: { state: MetadataStates.ACTIVE }, event: { block } }
  return did === DID_V5
    ? {
        id: did,
        version: '5.0.0',
        credentialSubject: { id: did, nftAddress: NFT_ADDRESS, chainId: CHAIN_ID },
        indexedMetadata
      }
    : {
        id: did,
        version: '4.1.0',
        nftAddress: NFT_ADDRESS,
        chainId: CHAIN_ID,
        indexedMetadata
      }
}

// v4 published first, then republished as v5
const initialRecords = (): Record<string, any> => ({
  [DID_V4]: published(DID_V4, 100),
  [DID_V5]: published(DID_V5, 200)
})

function stubStorage(processor: any, stored: Record<string, any>) {
  const ddoDatabase = {
    retrieve: (did: string) => Promise.resolve(structuredClone(stored[did] ?? null))
  }
  sinon.stub(processor, 'getDatabase').resolves({ ddo: ddoDatabase, ddoState: {} })
  // createOrUpdateDDO replaces the stored record with the instance's data
  sinon.stub(processor, 'createOrUpdateDDO').callsFake((ddo: any) => {
    const data = structuredClone(ddo.getDDOData())
    stored[data.id] = data
    return Promise.resolve(data)
  })
  return ddoDatabase
}

async function expectCurrentShortDdo(
  ddoDatabase: { retrieve(did: string): Promise<Record<string, any> | null> },
  state: number
) {
  const { did, ddo } = await retrieveDdoByNft(ddoDatabase, NFT_ADDRESS, CHAIN_ID)
  expect(did).to.equal(DID_V5)
  expect(ddo.version).to.equal('deprecated')
  expect(ddo.indexedMetadata.nft.state).to.equal(state)
  expect(ddo.indexedMetadata.event).to.deep.equal({ block: 200 })
}

const log = { address: NFT_ADDRESS, transactionHash: '0x01' } as unknown as ethers.Log

describe('Short DDO keeps its event across state changes', () => {
  afterEach(() => {
    sinon.restore()
  })

  it('MetadataState: Active -> Revoked -> Deprecated', async () => {
    const stored = initialRecords()
    const processor = new EVENT_PROCESSOR_MAP[EVENTS.METADATA_STATE](
      CHAIN_ID,
      {} as OceanNodeConfig
    )
    const ddoDatabase = stubStorage(processor, stored)
    const getEventData = sinon.stub(processor as any, 'getEventData')
    const changeState = (state: number) => {
      getEventData.resolves({ args: [OWNER, BigInt(state)] })
      return processor.processEvent(log, CHAIN_ID, null, null)
    }

    await changeState(MetadataStates.REVOKED)
    await expectCurrentShortDdo(ddoDatabase, MetadataStates.REVOKED)

    await changeState(MetadataStates.DEPRECATED)
    await expectCurrentShortDdo(ddoDatabase, MetadataStates.DEPRECATED)
  })

  it('MetadataUpdated on a revoked asset that becomes deprecated', async () => {
    const stored = initialRecords()
    const processor = new EVENT_PROCESSOR_MAP[EVENTS.METADATA_UPDATED](
      CHAIN_ID,
      {} as OceanNodeConfig
    )
    const ddoDatabase = stubStorage(processor, stored)
    sinon.stub(processor as any, 'getEventData').resolves({
      args: [OWNER, 0, 'http://decryptor', '0x02', '0x', ethers.ZeroHash]
    })

    // Answers the factory check and the NFT's on-chain metadata state
    const erc721 = new Interface(ERC721Template.abi)
    const coder = AbiCoder.defaultAbiCoder()
    let onChainState: number = MetadataStates.ACTIVE
    const signer = {
      provider: null,
      call: (tx: { data: string }) => {
        const selector = tx.data.slice(0, 10)
        if (selector === id('erc721List(address)').slice(0, 10)) {
          return Promise.resolve(coder.encode(['address'], [NFT_ADDRESS]))
        }
        if (selector === erc721.getFunction('getMetaData').selector) {
          return Promise.resolve(
            erc721.encodeFunctionResult('getMetaData', ['', '', onChainState, true])
          )
        }
        return Promise.reject(new Error(`unexpected call ${selector}`))
      }
    } as unknown as Signer
    const metadataUpdated = (state: number) => {
      onChainState = state
      return processor.processEvent(log, CHAIN_ID, signer, null, EVENTS.METADATA_UPDATED)
    }

    await metadataUpdated(MetadataStates.REVOKED)
    await expectCurrentShortDdo(ddoDatabase, MetadataStates.REVOKED)

    await metadataUpdated(MetadataStates.DEPRECATED)
    await expectCurrentShortDdo(ddoDatabase, MetadataStates.DEPRECATED)
  })
})
