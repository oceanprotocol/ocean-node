import {
  Contract,
  ethers,
  getAddress,
  hexlify,
  JsonRpcProvider,
  Signer,
  ZeroAddress
} from 'ethers'
import { assert, expect } from 'chai'
import { getEventFromTx } from '../../utils/util.js'
import ERC721Factory from '@oceanprotocol/contracts/artifacts/contracts/ERC721Factory.sol/ERC721Factory.json' assert { type: 'json' }
import { RPCS } from '../../@types/blockchain.js'
import { getOceanArtifactsAdresses } from '../../utils/address.js'
import ERC721Template from '@oceanprotocol/contracts/artifacts/contracts/templates/ERC721Template.sol/ERC721Template.json' assert { type: 'json' }
import { genericDDO } from '../data/ddo.js'
import { createHash } from 'crypto'
import { encrypt } from '../../utils/crypt.js'
import { delay, waitToIndex } from './testUtils.js'
import { Database } from '../../components/database/index.js'
import { OceanIndexer } from '../../components/Indexer/index.js'

describe('Should encrypt and decrypt DDO', () => {
  let database: Database
  let indexer: OceanIndexer
  let provider: JsonRpcProvider
  let publisherAccount: Signer
  let factoryContract: Contract
  let nftContract: Contract
  let dataNftAddress: string
  let datatokenAddress: string
  let genericAsset: any
  let assetDID: string

  const chainId = 8996
  const mockSupportedNetworks: RPCS = {
    '8996': {
      chainId: 8996,
      network: 'development',
      rpc: 'http://127.0.0.1:8545',
      chunkSize: 100
    }
  }

  before(async () => {
    // will be used later
    // const dbConfig = {
    //   url: 'http://localhost:8108/?apiKey=xyz'
    // }
    // database = await new Database(dbConfig)
    // indexer = new OceanIndexer(database, mockSupportedNetworks)
    const address = getOceanArtifactsAdresses()
    provider = new JsonRpcProvider('http://127.0.0.1:8545')
    process.env.PRIVATE_KEY =
      '0xc594c6e5def4bab63ac29eed19a134c130388f74f019bc74b8f4389df2837a58'
    process.env.RPCS = JSON.stringify(mockSupportedNetworks)
    publisherAccount = (await provider.getSigner(0)) as Signer
    genericAsset = genericDDO
    factoryContract = new ethers.Contract(
      address.development.ERC721Factory,
      ERC721Factory.abi,
      publisherAccount
    )
  })

  it('should publish a dataset', async function () {
    const tx = await (factoryContract as any).createNftWithErc20(
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
          ZeroAddress
        ],
        uints: [1000, 0],
        bytess: []
      }
    )
    const txReceipt = await tx.wait()
    assert(txReceipt, 'transaction failed')
    const nftEvent = getEventFromTx(txReceipt, 'NFTCreated')
    const erc20Event = getEventFromTx(txReceipt, 'TokenCreated')
    dataNftAddress = nftEvent.args[0]
    datatokenAddress = erc20Event.args[0]
    assert(dataNftAddress, 'find nft created failed')
    assert(datatokenAddress, 'find datatoken created failed')
  })

  it('should encrypt ddo and set metadata', async () => {
    nftContract = new ethers.Contract(
      dataNftAddress,
      ERC721Template.abi,
      publisherAccount
    )
    genericAsset.id =
      'did:op:' +
      createHash('sha256')
        .update(getAddress(dataNftAddress) + chainId.toString(10))
        .digest('hex')
    genericAsset.nftAddress = dataNftAddress
    genericAsset.services[0].datatokenAddress = datatokenAddress
    assetDID = genericAsset.id

    const stringDDO = JSON.stringify(genericAsset)
    const bytes = Buffer.from(stringDDO)
    const metadata = hexlify(bytes)
    const hash = createHash('sha256').update(metadata).digest('hex')

    const genericAssetData = Uint8Array.from(Buffer.from(JSON.stringify(genericAsset)))
    const encryptedData = await encrypt(genericAssetData, 'ECIES')
    const encryptedMetaData = hexlify(encryptedData)

    const setMetaDataTx = await nftContract.setMetaData(
      0,
      'http://v4.provider.oceanprotocol.com',
      '0x123',
      '0x02',
      encryptedMetaData,
      '0x' + hash,
      []
    )
    const txReceipt = await setMetaDataTx.wait()
    console.log(txReceipt)
    console.log(setMetaDataTx)
    assert(txReceipt, 'set metada failed')
  })

  // delay(30000)

  it('should store the ddo in the database and return it', async () => {
    // will be used later
    // const resolvedDDO = await waitToIndex(assetDID, database)
    // console.log('resolvedDDO', resolvedDDO)
    // expect(resolvedDDO.id).to.equal(genericAsset.id)
  })

  it('should decrypt ddo and return it', async () => {
    // should decrypt ddo and return it
  })
})
