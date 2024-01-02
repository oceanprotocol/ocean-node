import { expect, assert } from 'chai'
import { Readable } from 'stream'
import { createHash } from 'crypto'
import {
  JsonRpcProvider,
  Signer,
  Contract,
  ethers,
  getAddress,
  hexlify,
  ZeroAddress,
  parseUnits
} from 'ethers'
import ERC721Factory from '@oceanprotocol/contracts/artifacts/contracts/ERC721Factory.sol/ERC721Factory.json' assert { type: 'json' }
import ERC721Template from '@oceanprotocol/contracts/artifacts/contracts/templates/ERC721Template.sol/ERC721Template.json' assert { type: 'json' }
import { Database } from '../../components/database/index.js'
import { OceanIndexer } from '../../components/Indexer/index.js'
import { RPCS } from '../../@types/blockchain.js'
import { genericDDO } from '../data/ddo.js'
import { getOceanArtifactsAdresses } from '../../utils/address.js'
import { DownloadHandler } from '../../components/core/downloadHandler.js'
import ERC20Template from '@oceanprotocol/contracts/artifacts/contracts/templates/ERC20TemplateEnterprise.sol/ERC20TemplateEnterprise.json' assert { type: 'json' }
import { getEventFromTx, sleep } from '../../utils/util.js'
import { waitToIndex, delay } from './testUtils.js'
import { getConfig } from '../../utils/config.js'
import { OceanP2P } from '../../components/P2P/index.js'
import { ProviderFeeData } from '../../@types/Fees'
import { encrypt } from '../../utils/crypt.js'
import { createFee } from '../../components/core/utils/feesHandler.js'

describe('Download Tests', () => {
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
  let publisherAddress: string
  let consumerAccount: Signer
  let consumerAddress: string
  let datatokenAddress: string
  let orderTxId: string
  let dataTokenContractWithNewSigner: any
  let feeTx: string
  let feeData: ProviderFeeData | undefined

  const feeToken = '0x312213d6f6b5FCF9F56B7B8946A6C727Bf4Bc21f'
  const serviceId = '0' // dummy index
  const consumeMarketFeeAddress = ZeroAddress // marketplace fee Collector
  const consumeMarketFeeAmount = 0 // fee to be collected on top, requires approval
  const consumeMarketFeeToken = feeToken // token address for the feeAmount,

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
    //    process.env.PRIVATE_KEY =      '0xc594c6e5def4bab63ac29eed19a134c130388f74f019bc74b8f4389df2837a58'
    consumerAccount = (await provider.getSigner(1)) as Signer
    publisherAccount = (await provider.getSigner(0)) as Signer
    publisherAddress = await publisherAccount.getAddress()
    consumerAddress = await consumerAccount.getAddress()
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
    const nftEvent = getEventFromTx(txReceipt, 'NFTCreated')
    const erc20Event = getEventFromTx(txReceipt, 'TokenCreated')

    nftAddress = nftEvent.args[0]
    datatokenAddress = erc20Event.args[0]
    console.log('### datatokenAddress', datatokenAddress)

    assert(nftAddress, 'find nft created failed')
    assert(datatokenAddress, 'find datatoken created failed')
  })

  it('should set metadata and save ', async () => {
    // Encrypt the files
    const files = {
      datatokenAddress: '0x0',
      nftAddress: '0x0',
      files: [
        {
          type: 'url',
          url: 'https://github.com/datablist/sample-csv-files/raw/main/files/organizations/organizations-100.csv',
          method: 'GET'
        }
      ]
    }

    const data = Uint8Array.from(Buffer.from(JSON.stringify(files)))
    const encryptedData = await encrypt(data, 'ECIES')
    // const encryptedDataString = encryptedData.toString('base64')

    nftContract = new ethers.Contract(nftAddress, ERC721Template.abi, publisherAccount)
    genericAsset.id =
      'did:op:' +
      createHash('sha256')
        .update(getAddress(nftAddress) + chainId.toString(10))
        .digest('hex')
    genericAsset.nftAddress = nftAddress
    genericAsset.services[0].datatokenAddress = datatokenAddress
    genericAsset.services[0].files = encryptedData

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

  delay(35000)
  it('should store the ddo in the database and return it ', async () => {
    resolvedDDO = await waitToIndex(assetDID, database)
    console.log('resolvedDDO', resolvedDDO)
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

  delay(35000)

  it('should start an order and then download the asset', async function () {
    const asset: any = resolvedDDO
    this.timeout(65000) // Extend default Mocha test timeout

    console.log('should start an order and then download the asset')
    const dataTokenContract = new Contract(
      datatokenAddress,
      ERC20Template.abi,
      publisherAccount
    )
    const paymentCollector = await dataTokenContract.getPaymentCollector()
    assert(paymentCollector === publisherAddress, 'paymentCollector not correct')

    feeData = await createFee(asset, 0, 'null', resolvedDDO.services[0])
    // call the mint function on the dataTokenContract
    const mintTx = await dataTokenContract.mint(consumerAddress, parseUnits('1000', 18))
    await mintTx.wait()
    const consumerBalance = await dataTokenContract.balanceOf(consumerAddress)
    assert(consumerBalance === parseUnits('1000', 18), 'consumer balance not correct')

    dataTokenContractWithNewSigner = dataTokenContract.connect(consumerAccount) as any
    const orderTx = await dataTokenContractWithNewSigner.startOrder(
      consumerAddress,
      serviceId,
      {
        providerFeeAddress: feeData.providerFeeAddress,
        providerFeeToken: feeData.providerFeeToken,
        providerFeeAmount: feeData.providerFeeAmount,
        v: feeData.v,
        r: feeData.r,
        s: feeData.s,
        providerData: feeData.providerData,
        validUntil: feeData.validUntil
      },
      {
        consumeMarketFeeAddress,
        consumeMarketFeeToken,
        consumeMarketFeeAmount
      }
    )

    const orderTxReceipt = await orderTx.wait()
    assert(orderTxReceipt, 'order transaction failed')
    orderTxId = orderTxReceipt.hash
    assert(orderTxId, 'transaction id not found')

    const config = await getConfig()
    config.supportedNetworks[8996] = {
      chainId: 8996,
      network: 'development',
      rpc: 'http://127.0.0.1:8545',
      chunkSize: 100
    }

    const dbconn = await new Database(config.dbConfig)
    const p2pNode = new OceanP2P(config, dbconn)
    assert(p2pNode, 'Failed to instantiate OceanP2P')

    const wallet = new ethers.Wallet(
      '0xef4b441145c1d0f3b4bc6d61d29f5c6e502359481152f869247c7a4244d45209'
    )
    // message to sign
    const nonce = Date.now().toString()
    const message = String(asset.id + nonce)
    // sign message/nonce
    const consumerMessage = ethers.solidityPackedKeccak256(
      ['bytes'],
      [ethers.hexlify(ethers.toUtf8Bytes(message))]
    )
    const messageHashBytes = ethers.toBeArray(consumerMessage)
    const signature = await wallet.signMessage(messageHashBytes)
    console.log('2. feeTx', feeTx)
    console.log('consumerAddress', consumerAddress)
    const downloadTask = {
      fileIndex: 0,
      documentId: assetDID,
      serviceId,
      transferTxId: orderTxId,
      nonce,
      consumerAddress,
      signature
    }
    const response = await new DownloadHandler(p2pNode).handle(downloadTask)

    assert(response)
    assert(response.stream, 'stream not present')
    assert(response.status.httpStatus === 200, 'http status not 200')
    expect(response.stream).to.be.instanceOf(Readable)
  })

  it('should not allow to download the asset with different consumer address', async function () {
    const downloadTask = {
      fileIndex: 0,
      documentId: assetDID,
      serviceId,
      transferTxId: orderTxId,
      nonce: Date.now().toString(),
      consumerAddress: '0xBE5449a6A97aD46c8558A3356267Ee5D2731ab57',
      signature: ''
    }
    const config = await getConfig()
    const dbconn = await new Database(config.dbConfig)
    const p2pNode = new OceanP2P(config, dbconn)
    assert(p2pNode, 'Failed to instantiate OceanP2P')
    const response = await new DownloadHandler(p2pNode).handle(downloadTask)
    console.log(response)
    assert(response.stream === null, 'stream not null')
    assert(response.status.httpStatus === 500, 'http status not 500')
    assert(
      response.status.error === `Error: Access to asset ${assetDID} was denied`,
      'error contains access denied'
    )
  })
})
