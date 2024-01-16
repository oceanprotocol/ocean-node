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
import { getEventFromTx, streamToString } from '../../utils/util.js'
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
import { Readable } from 'stream'

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
  let txReceiptEncryptDDO: any
  let encryptedMetaData: any
  let documentHash: any
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

    const metadata = hexlify(Buffer.from(JSON.stringify(genericAsset)))
    documentHash = '0x' + createHash('sha256').update(metadata).digest('hex')

    const genericAssetData = Uint8Array.from(Buffer.from(JSON.stringify(genericAsset)))
    const encryptedData = await encrypt(genericAssetData, 'ECIES')
    encryptedMetaData = hexlify(encryptedData)

    const setMetaDataTx = await nftContract.setMetaData(
      0,
      'http://v4.provider.oceanprotocol.com',
      '0x123',
      '0x02',
      encryptedMetaData,
      documentHash,
      []
    )
    txReceiptEncryptDDO = await setMetaDataTx.wait()
    assert(txReceiptEncryptDDO, 'set metada failed')
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

  it('should return failed to process transaction id', async () => {
    const decryptDDOTask: DecryptDDOCommand = {
      command: 'decryptDDO',
      decrypterAddress: publisherAddress,
      chainId,
      transactionId: 'string',
      dataNftAddress,
      nonce: Date.now().toString(),
      signature: 'string'
    }
    const response = await new DecryptDdoHandler(p2pNode).handle(decryptDDOTask)
    expect(response.status.httpStatus).to.equal(400)
    expect(response.status.error).to.equal(
      'Decrypt DDO: Failed to process transaction id'
    )
  })

  it('should return failed to convert input args to bytes', async () => {
    const decryptDDOTask: DecryptDDOCommand = {
      command: 'decryptDDO',
      decrypterAddress: publisherAddress,
      chainId,
      encryptedDocument: '1234',
      flags: 1,
      documentHash: '1234',
      dataNftAddress,
      nonce: Date.now().toString(),
      signature: 'string'
    }
    const response = await new DecryptDdoHandler(p2pNode).handle(decryptDDOTask)
    expect(response.status.httpStatus).to.equal(400)
    expect(response.status.error).to.equal(
      'Decrypt DDO: Failed to convert input args to bytes'
    )
  })

  it('should return checksum does not match', async () => {
    const decryptDDOTask: DecryptDDOCommand = {
      command: 'decryptDDO',
      decrypterAddress: publisherAddress,
      chainId,
      encryptedDocument: encryptedMetaData,
      flags: 2,
      documentHash: '0x1234',
      dataNftAddress,
      nonce: Date.now().toString(),
      signature: 'string'
    }
    const response = await new DecryptDdoHandler(p2pNode).handle(decryptDDOTask)
    expect(response.status.httpStatus).to.equal(400)
    expect(response.status.error).to.equal('Decrypt DDO: checksum does not match')
  })

  it('should decrypt ddo with transactionId and return it', async () => {
    const decryptDDOTask: DecryptDDOCommand = {
      command: 'decryptDDO',
      decrypterAddress: publisherAddress,
      chainId,
      transactionId: txReceiptEncryptDDO.hash,
      dataNftAddress,
      nonce: Date.now().toString(),
      signature: 'string'
    }
    const response = await new DecryptDdoHandler(p2pNode).handle(decryptDDOTask)
    expect(response.status.httpStatus).to.equal(200)
    const decryptedStringDDO = await streamToString(response.stream as Readable)
    const stringDDO = JSON.stringify(genericAsset)
    expect(decryptedStringDDO).to.equal(stringDDO)
  })

  it('should decrypt ddo with encryptedDocument, flags, documentHash and return it', async () => {
    const decryptDDOTask: DecryptDDOCommand = {
      command: 'decryptDDO',
      decrypterAddress: publisherAddress,
      chainId,
      encryptedDocument: encryptedMetaData,
      flags: 2,
      documentHash,
      dataNftAddress,
      nonce: Date.now().toString(),
      signature: 'string'
    }
    const response = await new DecryptDdoHandler(p2pNode).handle(decryptDDOTask)
    expect(response.status.httpStatus).to.equal(200)
    const decryptedStringDDO = await streamToString(response.stream as Readable)
    const stringDDO = JSON.stringify(genericAsset)
    expect(decryptedStringDDO).to.equal(stringDDO)
  })
})
