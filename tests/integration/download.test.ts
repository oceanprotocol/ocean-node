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
  toUtf8Bytes,
  solidityPackedKeccak256,
  parseUnits
} from 'ethers'
import ERC721Factory from '@oceanprotocol/contracts/artifacts/contracts/ERC721Factory.sol/ERC721Factory.json' assert { type: 'json' }
import ERC721Template from '@oceanprotocol/contracts/artifacts/contracts/templates/ERC721Template.sol/ERC721Template.json' assert { type: 'json' }
import { Database } from '../../components/database/index.js'
import { OceanIndexer } from '../../components/Indexer/index.js'
import { RPCS } from '../../@types/blockchain.js'
import { genericDDO } from '../data/ddo.js'
import { getOceanArtifactsAdresses } from '../../utils/address.js'
import { handleDownload } from '../../components/core/downloadHandler.js'
import ERC20Template from '@oceanprotocol/contracts/artifacts/contracts/templates/ERC20TemplateEnterprise.sol/ERC20TemplateEnterprise.json' assert { type: 'json' }
import { getEventFromTx, sleep } from '../../utils/util.js'
import { signMessage, waitToIndex, delay } from './testUtils.js'
import { getConfig } from '../../utils/config.js'
import { OceanP2P } from '../../components/P2P/index.js'
import { ProviderFeeData } from '../../@types/Fees'
import { encrypt } from '../../utils/crypt.js'
import {
  checkFee,
  createFee,
  getProviderFeeAmount,
  getProviderFeeToken,
  getProviderWallet
} from '../../components/core/feesHandler.js'

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
  let dataNftAddress: string
  let datatokenAddress: string
  let message: string
  let providerData: string
  let orderTxId: string
  let dataTokenContractWithNewSigner: any
  let feeTx: string
  let feeData: ProviderFeeData | undefined
  let signedMessage: {
    v: string
    r: string
    s: string
  }

  const feeToken = '0x312213d6f6b5FCF9F56B7B8946A6C727Bf4Bc21f'
  const providerFeeAddress = ZeroAddress // publisherAddress
  const providerFeeToken = feeToken
  const serviceIndex = 0 // dummy index
  const providerFeeAmount = 0 // fee to be collected on top, requires approval
  const consumeMarketFeeAddress = ZeroAddress // marketplace fee Collector
  const consumeMarketFeeAmount = 0 // fee to be collected on top, requires approval
  const consumeMarketFeeToken = feeToken // token address for the feeAmount,
  const providerValidUntil = 0
  const timeout = 0

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
      type: 'url',
      url: 'https://github.com/datablist/sample-csv-files/raw/main/files/organizations/organizations-100.csv',
      method: 'get'
    }
    const data = Uint8Array.from(Buffer.from(JSON.stringify(files)))
    const encryptedData = await encrypt(data, 'ECIES')
    const encryptedDataString = encryptedData.toString('base64')

    nftContract = new ethers.Contract(nftAddress, ERC721Template.abi, publisherAccount)
    genericAsset.id =
      'did:op:' +
      createHash('sha256')
        .update(getAddress(nftAddress) + chainId.toString(10))
        .digest('hex')
    genericAsset.nftAddress = nftAddress
    genericAsset.services[0].datatokenAddress = datatokenAddress
    genericAsset.services[0].files = encryptedDataString

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

  delay(50000)

  it('should check the fees data and validate signature', async () => {
    const asset: any = resolvedDDO
    const wallet = await getProviderWallet()
    const { address } = wallet
    console.log('address', address)
    const { chainId } = asset // this chain id is a number
    const providerFeeToken = await getProviderFeeToken(chainId)
    const providerAmount = await getProviderFeeAmount()

    feeData = await createFee(asset, 0, 'null', resolvedDDO.services[0])

    if (feeData) {
      expect(feeData.providerFeeAddress).to.be.equal(address)
      expect(feeData.providerFeeToken).to.be.equal(providerFeeToken)
      expect(feeData.providerFeeAmount).to.be.equal(providerAmount)

      // will sign a new message with this data to simulate the txId and then check it
      const providerDataAsArray = ethers.toBeArray(feeData.providerData)
      const providerDataStr = Buffer.from(providerDataAsArray).toString('utf8')
      const providerData = JSON.parse(providerDataStr)

      // done previously as ethers.hexlify(ethers.toUtf8Bytes(JSON.stringify(providerData))),
      // check signature stuff now

      const messageHash = ethers.solidityPackedKeccak256(
        ['bytes', 'address', 'address', 'uint256', 'uint256'],
        [
          ethers.hexlify(ethers.toUtf8Bytes(JSON.stringify(providerData))),
          ethers.getAddress(feeData.providerFeeAddress), // signer address
          ethers.getAddress(feeData.providerFeeToken), // TODO check decimals on contract?
          feeData.providerFeeAmount,
          feeData.validUntil
        ]
      )

      const signableHash = ethers.solidityPackedKeccak256(
        ['bytes'],
        [ethers.toUtf8Bytes(messageHash)]
      )

      feeTx = await wallet.signMessage(ethers.toBeArray(signableHash))

      console.log('1. feeTx', feeTx)
      console.log('1. Test data', feeData)
      const checkFeeResult = await checkFee(feeTx, feeData)
      expect(checkFeeResult).to.be.equal(true)
    }
  })

  it('should start an order and then download the asset', async function () {
    this.timeout(65000) // Extend default Mocha test timeout
    console.log('should start an order and then download the asset')
    const dataTokenContract = new Contract(
      datatokenAddress,
      ERC20Template.abi,
      publisherAccount
    )
    console.log('dataTokenContract')
    const paymentCollector = await dataTokenContract.getPaymentCollector()
    console.log('paymentCollector', paymentCollector)
    assert(paymentCollector === publisherAddress, 'paymentCollector not correct')

    // sign provider data
    providerData = JSON.stringify({ timeout })
    message = solidityPackedKeccak256(
      ['bytes', 'address', 'address', 'uint256', 'uint256'],
      [
        hexlify(toUtf8Bytes(providerData)),
        providerFeeAddress,
        providerFeeToken,
        providerFeeAmount,
        providerValidUntil
      ]
    )
    signedMessage = await signMessage(message, publisherAddress, provider)

    // call the mint function on the dataTokenContract
    const mintTx = await dataTokenContract.mint(consumerAddress, parseUnits('1000', 18))
    await mintTx.wait()
    const consumerBalance = await dataTokenContract.balanceOf(consumerAddress)
    assert(consumerBalance === parseUnits('1000', 18), 'consumer balance not correct')

    dataTokenContractWithNewSigner = dataTokenContract.connect(consumerAccount) as any

    const orderTx = await dataTokenContractWithNewSigner.startOrder(
      consumerAddress,
      serviceIndex,
      {
        providerFeeAddress,
        providerFeeToken,
        providerFeeAmount,
        v: signedMessage.v,
        r: signedMessage.r,
        s: signedMessage.s,
        providerData: hexlify(toUtf8Bytes(providerData)),
        validUntil: providerValidUntil
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
    const p2pNode = new OceanP2P(dbconn, config)
    assert(p2pNode, 'Failed to instantiate OceanP2P')

    const wallet = new ethers.Wallet(
      '0xef4b441145c1d0f3b4bc6d61d29f5c6e502359481152f869247c7a4244d45209'
    )
    // message to sign
    const nonce = Date.now().toString()
    // sign message/nonce
    const signature = await wallet.signMessage(nonce)
    console.log('2. feeTx', feeTx)
    console.log('consumerAddress', consumerAddress)
    const downloadTask = {
      documentId: assetDID,
      serviceIndex,
      transferTxId: orderTxId,
      nonce,
      consumerAddress,
      signature,
      feeTx,
      feeData
    }
    const response = await handleDownload(downloadTask, p2pNode)
    console.log('response', response)

    assert(response)
  })
})
