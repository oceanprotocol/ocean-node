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
import { DecryptDdoHandler } from '../../components/core/ddoHandler.js'
import { DecryptDDOCommand, getConfig } from '../../utils/index.js'
import { OceanP2P } from '../../components/P2P/index.js'
import { OceanNodeConfig } from '../../@types/OceanNode.js'

describe('Should encrypt and decrypt DDO', () => {
  let config: OceanNodeConfig
  let database: Database
  let p2pNode: OceanP2P
  let indexer: OceanIndexer
  let provider: JsonRpcProvider
  let publisherAccount: Signer
  let publisherAddress: string
  let factoryContract: Contract
  let nftContract: Contract
  let dataNftAddress: string
  let datatokenAddress: string
  let genericAsset: any
  let assetDID: string
  const nonce = Date.now().toString()

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
    const artifactsAddresses = getOceanArtifactsAdresses()
    provider = new JsonRpcProvider('http://127.0.0.1:8545')
    publisherAccount = (await provider.getSigner(0)) as Signer
    publisherAddress = await publisherAccount.getAddress()
    genericAsset = genericDDO
    factoryContract = new ethers.Contract(
      artifactsAddresses.development.ERC721Factory,
      ERC721Factory.abi,
      publisherAccount
    )
    process.env.PRIVATE_KEY =
      '0xc594c6e5def4bab63ac29eed19a134c130388f74f019bc74b8f4389df2837a58'
    process.env.RPCS = JSON.stringify(mockSupportedNetworks)
    process.env.AUTHORIZED_DECRYPTERS = JSON.stringify([publisherAddress])
    const dbConfig = {
      url: 'http://localhost:8108/?apiKey=xyz'
    }
    config = await getConfig()
    database = await new Database(dbConfig)
    p2pNode = new OceanP2P(config, database)
    // will be used later
    // indexer = new OceanIndexer(database, mockSupportedNetworks)
  })

  it('should publish a dataset', async () => {
    const tx = await (factoryContract as any).createNftWithErc20(
      {
        name: '72120Bundle',
        symbol: '72Bundle',
        templateIndex: 1,
        tokenURI: 'https://oceanprotocol.com/nft/',
        transferable: true,
        owner: publisherAddress
      },
      {
        strings: ['ERC20B1', 'ERC20DT1Symbol'],
        templateIndex: 1,
        addresses: [publisherAddress, ZeroAddress, ZeroAddress, ZeroAddress],
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
    // console.log(txReceipt)
    // console.log(setMetaDataTx)
    assert(txReceipt, 'set metada failed')
  })

  // delay(30000)

  it('should store the ddo in the database and return it', async () => {
    // will be used later
    // const resolvedDDO = await waitToIndex(assetDID, database)
    // console.log('resolvedDDO', resolvedDDO)
    // expect(resolvedDDO.id).to.equal(genericAsset.id)
  })

  it('should return unsupported chain id', async () => {
    const decryptDDOTask: DecryptDDOCommand = {
      command: 'decryptDDO',
      decrypterAddress: publisherAddress,
      chainId: 123,
      nonce,
      signature: 'string'
    }
    const response = await new DecryptDdoHandler(p2pNode).handle(decryptDDOTask)
    expect(response.status.httpStatus).to.equal(400)
    expect(response.status.error).to.equal('Decrypt DDO: Unsupported chain id')
  })

  it('should return error duplicate nonce', async () => {
    const decryptDDOTask: DecryptDDOCommand = {
      command: 'decryptDDO',
      decrypterAddress: publisherAddress,
      chainId: 123,
      nonce,
      signature: 'string'
    }
    const response = await new DecryptDdoHandler(p2pNode).handle(decryptDDOTask)
    expect(response.status.httpStatus).to.equal(400)
    expect(response.status.error).to.equal(`Decrypt DDO: duplicate nonce`)
  })

  it('should return decrypter not authorized', async () => {
    const decryptDDOTask: DecryptDDOCommand = {
      command: 'decryptDDO',
      decrypterAddress: ZeroAddress,
      chainId,
      nonce: Date.now().toString(),
      signature: 'string'
    }
    const response = await new DecryptDdoHandler(p2pNode).handle(decryptDDOTask)
    expect(response.status.httpStatus).to.equal(400)
    expect(response.status.error).to.equal('Decrypt DDO: Decrypter not authorized')
  })

  it('should return asset not deployed by the data NFT factory', async () => {
    const decryptDDOTask: DecryptDDOCommand = {
      command: 'decryptDDO',
      decrypterAddress: publisherAddress,
      chainId,
      dataNftAddress: publisherAddress,
      nonce: Date.now().toString(),
      signature: 'string'
    }
    const response = await new DecryptDdoHandler(p2pNode).handle(decryptDDOTask)
    expect(response.status.httpStatus).to.equal(400)
    expect(response.status.error).to.equal(
      'Decrypt DDO: Asset not deployed by the data NFT factory'
    )
  })

  it('should decrypt ddo and return it', async () => {
    // const decryptDDOTask = {
    //   decrypterAddress: 'string',
    //   chainId: 'number',
    //   nonce: 'string',
    //   signature: 'string'
    // }
    // const response = await new DecryptDdoHandler(p2pNode).handle(decryptDDOTask)
  })
})
