import { expect, assert } from 'chai'
import { createHash } from 'crypto'
import {
  JsonRpcProvider,
  Signer,
  Contract,
  ethers,
  getAddress,
  hexlify,
  ZeroAddress
} from 'ethers'
import fs from 'fs'
import { homedir } from 'os'
import ERC721Factory from '@oceanprotocol/contracts/artifacts/contracts/ERC721Factory.sol/ERC721Factory.json' assert { type: 'json' }
import ERC721Template from '@oceanprotocol/contracts/artifacts/contracts/templates/ERC721Template.sol/ERC721Template.json' assert { type: 'json' }
import { Database } from '../../src/components/database/index.js'
import { OceanIndexer } from '../../src/components/Indexer/index.js'
import { RPCS } from '../../src/@types/blockchain.js'
import { getEventFromTx } from '../../src/utils/util.js'
import { delay, waitToIndex } from './testUtils.js'
import { genericDDO } from '../data/ddo.js'
import { getOceanArtifactsAdresses } from '../../src/utils/address.js'

describe('Indexer stores a new published DDO', () => {
  let database: Database
  let indexer: OceanIndexer
  let provider: JsonRpcProvider
  let factoryContract: Contract
  let nftContract: Contract
  let publisherAccount: Signer
  let nftAddress: string
  const chainId = 8996
  let assetDID: string
  let resolvedDDO: Record<string, any>
  let genericAsset: any

  const mockSupportedNetworks: RPCS = {
    '8996': {
      chainId: 8996,
      network: 'development',
      rpc: 'http://127.0.0.1:8545',
      chunkSize: 100
    }
  }

  before(async () => {
    const dbConfig = {
      url: 'http://localhost:8108/?apiKey=xyz'
    }
    database = await new Database(dbConfig)
    indexer = new OceanIndexer(database, mockSupportedNetworks)

    const data = getOceanArtifactsAdresses()

    provider = new JsonRpcProvider('http://127.0.0.1:8545')
    process.env.PRIVATE_KEY =
      '0xc594c6e5def4bab63ac29eed19a134c130388f74f019bc74b8f4389df2837a58'
    publisherAccount = (await provider.getSigner(0)) as Signer
    genericAsset = genericDDO
    factoryContract = new ethers.Contract(
      data.development.ERC721Factory,
      ERC721Factory.abi,
      publisherAccount
    )
  })

  it('instance Database', async () => {
    expect(database).to.be.instanceOf(Database)
  })

  it('should publish a dataset', async () => {
    const tx = await factoryContract.createNftWithErc20(
      {
        name: '72120Bundle',
        symbol: '72Bundle',
        templateIndex: 1,
        tokenURI: 'https://oceanprotocol.com/nft/',
        transferable: true,
        owner: await publisherAccount.getAddress()
      },
      {
        strings: ['ERC20B1', 'ERC20DT1Symbol'],
        templateIndex: 1,
        addresses: [
          await publisherAccount.getAddress(),
          ZeroAddress,
          ZeroAddress,
          '0x0000000000000000000000000000000000000000'
        ],
        uints: [1000, 0],
        bytess: []
      }
    )
    const txReceipt = await tx.wait()
    assert(txReceipt, 'transaction failed')
    const event = getEventFromTx(txReceipt, 'NFTCreated')
    nftAddress = event.args[0]
    assert(nftAddress, 'find nft created failed')
  })

  it('should set metadata and save ', async () => {
    nftContract = new ethers.Contract(nftAddress, ERC721Template.abi, publisherAccount)
    genericAsset.id =
      'did:op:' +
      createHash('sha256')
        .update(getAddress(nftAddress) + chainId.toString(10))
        .digest('hex')
    genericAsset.nftAddress = nftAddress

    assetDID = genericAsset.id
    const stringDDO = JSON.stringify(genericAsset)
    const bytes = Buffer.from(stringDDO)
    const metadata = hexlify(bytes)
    const hash = createHash('sha256').update(metadata).digest('hex')

    const setMetaDataTx = await nftContract.setMetaData(
      0,
      'http://v4.provider.oceanprotocol.com',
      '0x123',
      '0x02',
      metadata,
      '0x' + hash,
      []
    )
    const trxReceipt = await setMetaDataTx.wait()
    assert(trxReceipt, 'set metada failed')
  })

  delay(50000)

  it('should store the ddo in the database and return it ', async () => {
    resolvedDDO = await waitToIndex(assetDID, database)
    expect(resolvedDDO.id).to.equal(genericAsset.id)
  })

  it('should update ddo metadata fields ', async () => {
    resolvedDDO.metadata.name = 'dataset-name-updated'
    resolvedDDO.metadata.description =
      'Updated description for the Ocean protocol test dataset'
    const stringDDO = JSON.stringify(resolvedDDO)
    const bytes = Buffer.from(stringDDO)
    const metadata = hexlify(bytes)
    const hash = createHash('sha256').update(metadata).digest('hex')

    const setMetaDataTx = await nftContract.setMetaData(
      0,
      'http://v4.provider.oceanprotocol.com',
      '0x123',
      '0x02',
      metadata,
      '0x' + hash,
      []
    )
    const trxReceipt = await setMetaDataTx.wait()
    assert(trxReceipt, 'set metada failed')
  })

  delay(50000)

  it('should detect update event and store the udpdated ddo in the database', async () => {
    const updatedDDO = await waitToIndex(assetDID, database)
    expect(updatedDDO.metadata.name).to.equal('dataset-name-updated')
    expect(updatedDDO.metadata.description).to.equal(
      'Updated description for the Ocean protocol test dataset'
    )
  })

  it('should change metadata state of the published DDO', async () => {
    const setMetaDataStateTx = await nftContract.setMetaDataState(4)
    const trxReceipt = await setMetaDataStateTx.wait()
    assert(trxReceipt, 'set metada state failed')
  })

  delay(50000)

  it('should get the updated state', async () => {
    const result = await nftContract.getMetaData()
    const retrievedDDO = await waitToIndex(assetDID, database)
    expect(retrievedDDO.nft).to.not.equal(undefined)
    expect(retrievedDDO).to.have.nested.property('nft.state')
    // Expect the result from contract
    expect(retrievedDDO.nft.state).to.equal(parseInt(result[2].toString()))
  })

  it('should change metadata state back to ACTIVE state', async () => {
    const setMetaDataStateTx = await nftContract.setMetaDataState(0)
    const trxReceipt = await setMetaDataStateTx.wait()
    assert(trxReceipt, 'set metada state failed')
  })

  delay(100000)

  it('should change metadata state to DEPRECATED', async () => {
    // Deprecated state for this asset
    const setMetaDataStateTx = await nftContract.setMetaDataState(2)
    const trxReceipt = await setMetaDataStateTx.wait()
    assert(trxReceipt, 'set metada state failed')
  })

  delay(100000)

  it('should have a short version of ddo', async () => {
    const result = await nftContract.getMetaData()
    expect(parseInt(result[2].toString())).to.equal(2)
    const resolvedDDO = await waitToIndex(assetDID, database)
    // Expect a short version of the DDO
    expect(Object.keys(resolvedDDO).length).to.equal(3)
    expect(
      'id' in resolvedDDO && 'nftAddress' in resolvedDDO && 'nft' in resolvedDDO
    ).to.equal(true)
  })
})
