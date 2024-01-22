import { expect, assert } from 'chai'
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
  parseUnits,
  Log,
  TransactionResponse,
  Block,
  TransactionReceipt,
  OrphanFilter
} from 'ethers'
import fs from 'fs'
import { homedir } from 'os'
import ERC721Factory from '@oceanprotocol/contracts/artifacts/contracts/ERC721Factory.sol/ERC721Factory.json' assert { type: 'json' }
import ERC721Template from '@oceanprotocol/contracts/artifacts/contracts/templates/ERC721Template.sol/ERC721Template.json' assert { type: 'json' }
import ERC20Template from '@oceanprotocol/contracts/artifacts/contracts/templates/ERC20TemplateEnterprise.sol/ERC20TemplateEnterprise.json' assert { type: 'json' }
import { Database } from '../../components/database/index.js'
import { OceanIndexer } from '../../components/Indexer/index.js'
import { RPCS } from '../../@types/blockchain.js'
import { getEventFromTx } from '../../utils/util.js'
import { delay, waitToIndex, signMessage } from './testUtils.js'
import { genericDDO } from '../data/ddo.js'
import { getOceanArtifactsAdresses } from '../../utils/address.js'
import { createFee } from '../../components/core/utils/feesHandler.js'
import { DDO } from '../../@types/DDO/DDO.js'
import {
  MetadataEventProcessor,
  MetadataStateEventProcessor,
  OrderStartedEventProcessor
} from '../../components/Indexer/processor.js'
import { EVENTS } from '../../utils/constants.js'

describe('Indexer stores a new metadata events and orders.', () => {
  let database: Database
  let indexer: OceanIndexer
  let provider: JsonRpcProvider
  let factoryContract: Contract
  let nftContract: Contract
  let datatokenContract: Contract
  let publisherAccount: Signer
  let consumerAccount: Signer
  let nftAddress: string
  let datatokenAddress: string
  const chainId = 8996
  let assetDID: string
  let resolvedDDO: Record<string, any>
  let genericAsset: any
  let setMetaDataTxReceipt: any
  let orderTxId: string
  let reuseOrderTxId: string
  let dataTokenContractWithNewSigner: any
  let signedMessage: { v: string; r: string; s: string }
  let message: string
  let providerData: string
  let orderEvent: any
  let reusedOrderEvent: any
  let initialOrderCount: number
  const timeout = 0
  const feeToken = '0x312213d6f6b5FCF9F56B7B8946A6C727Bf4Bc21f'
  const providerFeeAddress = ZeroAddress // publisherAddress
  const providerFeeToken = feeToken
  const serviceIndex = 0 // dummy index
  const providerFeeAmount = 0 // fee to be collected on top, requires approval
  const consumeMarketFeeAddress = ZeroAddress // marketplace fee Collector
  const consumeMarketFeeAmount = 0 // fee to be collected on top, requires approval
  const consumeMarketFeeToken = feeToken // token address for the feeAmount,
  const providerValidUntil = 0

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
    publisherAccount = (await provider.getSigner(0)) as Signer
    consumerAccount = (await provider.getSigner(1)) as Signer
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

  it('should process metadat created event', async () => {
    const processor = new MetadataEventProcessor(8996, database)
    const event: Log = {
      provider,
      transactionHash:
        '0x4fd20001e832156962586802bdc04cca87219e247581f42fbee1d0b9b949f033',
      blockHash: '0x79a82533981c38c743b94a9aa05d4215b565adf4bd6daa04b09b8af1934372fa',
      blockNumber: 1126,
      removed: false,
      address: '0x181e8a7f8767808bea51F61044E27C5F8bf7C939',
      data: '0x000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000e0000000000000000000000000000000000000000000000000000000000000014000000000000000000000000000000000000000000000000000000000000001800f2b0119d26de67e5a15abd91c15df34e93515bb0eb157b3cf0f7da48b3a632f0000000000000000000000000000000000000000000000000000000065aa63d900000000000000000000000000000000000000000000000000000000000004660000000000000000000000000000000000000000000000000000000000000024687474703a2f2f76342e70726f76696465722e6f6365616e70726f746f636f6c2e636f6d000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001020000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000003ed7b2240636f6e74657874223a5b2268747470733a2f2f773369642e6f72672f6469642f7631225d2c226964223a226469643a6f703a31326231376565343735333664633334326636376135666162326630313464646562313062653034303138626336626335333935333635356532663766386666222c2276657273696f6e223a22342e312e30222c22636861696e4964223a383939362c226e667441646472657373223a22307831383165386137663837363738303862656135314636313034344532374335463862663743393339222c226d65746164617461223a7b2263726561746564223a22323032312d31322d32305431343a33353a32305a222c2275706461746564223a22323032312d31322d32305431343a33353a32305a222c2274797065223a2264617461736574222c226e616d65223a22646174617365742d6e616d65222c226465736372697074696f6e223a224f6365616e2070726f746f636f6c20746573742064617461736574206465736372697074696f6e222c22617574686f72223a226f6365616e70726f746f636f6c2d7465616d222c226c6963656e7365223a224d4954222c2274616773223a5b2277686974652d706170657273225d2c226164646974696f6e616c496e666f726d6174696f6e223a7b22746573742d6b6579223a22746573742d76616c7565227d2c226c696e6b73223a5b22687474703a2f2f646174612e636564612e61632e756b2f626164632f756b637030392f225d7d2c227365727669636573223a5b7b226964223a2230222c2274797065223a22616363657373222c226465736372697074696f6e223a22446f776e6c6f61642073657276696365222c2266696c6573223a5b7b2275726c223a2268747470733a2f2f7261772e67697468756275736572636f6e74656e742e636f6d2f6f6365616e70726f746f636f6c2f746573742d616c676f726974686d2f6d61737465722f6a6176617363726970742f616c676f2e6a73222c22636f6e74656e7454797065223a22746578742f6a73222c22656e636f64696e67223a225554462d38227d5d2c2264617461746f6b656e41646472657373223a22307830222c2273657276696365456e64706f696e74223a22687474703a2f2f3137322e31352e302e343a38303330222c2274696d656f7574223a307d5d2c2263726564656e7469616c73223a7b22616c6c6f77223a5b7b2274797065223a2261646472657373222c2276616c756573223a5b22307842453534343961364139376144343663383535384133333536323637456535443237333161623565225d7d5d2c2264656e79223a5b7b2274797065223a2261646472657373222c2276616c756573223a5b223078313233225d7d5d7d7d00000000000000000000000000000000000000',
      topics: [
        '0x5463569dcc320958360074a9ab27e809e8a6942c394fb151d139b5f7b4ecb1bd',
        '0x000000000000000000000000e2dd09d719da89e5a3d0f2549c7e24566e947260'
      ],
      index: 0,
      transactionIndex: 0,
      toJSON: function () {
        throw new Error('Function not implemented.')
      },
      getBlock: function (): Promise<Block> {
        throw new Error('Function not implemented.')
      },
      getTransaction: function (): Promise<TransactionResponse> {
        throw new Error('Function not implemented.')
      },
      getTransactionReceipt: function (): Promise<TransactionReceipt> {
        throw new Error('Function not implemented.')
      },
      removedEvent: function (): OrphanFilter {
        throw new Error('Function not implemented.')
      }
    }

    const ddo = await processor.processEvent(
      event,
      8996,
      provider,
      EVENTS.METADATA_CREATED
    )
    assert(ddo, 'DDO not indexed')
  })

  it('should process metadata state event', async () => {
    const processor = new MetadataStateEventProcessor(8996, database)
    const event: Log = {
      provider,
      transactionHash:
        '0x469873c0e2edc59832e96b53d899358a21afd2fba02e229d19ea0106426c44c5',
      blockHash: '0xf62d51b3f9e7613620a9a81e9a9f568b4fad8d0c53869d9925166d5ac9f39749',
      blockNumber: 1128,
      removed: false,
      address: '0x181e8a7f8767808bea51F61044E27C5F8bf7C939',
      data: '0x00000000000000000000000000000000000000000000000000000000000000040000000000000000000000000000000000000000000000000000000065aa641d0000000000000000000000000000000000000000000000000000000000000468',
      topics: [
        '0xa8336411cc72db0e5bdc4dff989eeb35879bafaceffb59b54b37645c3395adb9',
        '0x000000000000000000000000e2dd09d719da89e5a3d0f2549c7e24566e947260'
      ],
      index: 0,
      transactionIndex: 0,
      toJSON: function () {
        throw new Error('Function not implemented.')
      },
      getBlock: function (): Promise<Block> {
        throw new Error('Function not implemented.')
      },
      getTransaction: function (): Promise<TransactionResponse> {
        throw new Error('Function not implemented.')
      },
      getTransactionReceipt: function (): Promise<TransactionReceipt> {
        throw new Error('Function not implemented.')
      },
      removedEvent: function (): OrphanFilter {
        throw new Error('Function not implemented.')
      }
    }
    const ddo = await processor.processEvent(event, 8996, provider)
    assert(ddo, 'DDO not indexed')
  })
  it('should process order started event', async () => {
    const processor = new OrderStartedEventProcessor(8996, database)
    const event: Log = {
      provider,
      transactionHash:
        '0xce2659a3877b0b9aeeb664c0f23d2a6c20a0f07e4e49f254e63fa3d1f13172af',
      blockHash: '0x9140a5c57fe612e7454759b58202208ef4ffdc5ddff2dc63164752859fa66da7',
      blockNumber: 1124,
      removed: false,
      address: '0x3cfE814D86e34d7af0B60f39C3B9463AaCB4910b',
      data: '0x000000000000000000000000be5449a6a97ad46c8558a3356267ee5d2731ab5e0000000000000000000000000000000000000000000000000de0b6b3a764000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000065aa5dfb0000000000000000000000000000000000000000000000000000000000000464',
      topics: [
        '0xe1c4fa794edfa8f619b8257a077398950357b9c6398528f94480307352f9afcc',
        '0x000000000000000000000000be5449a6a97ad46c8558a3356267ee5d2731ab5e',
        '0x0000000000000000000000000000000000000000000000000000000000000000'
      ],
      index: 0,
      transactionIndex: 0,
      toJSON: function () {
        throw new Error('Function not implemented.')
      },
      getBlock: function (): Promise<Block> {
        throw new Error('Function not implemented.')
      },
      getTransaction: function (): Promise<TransactionResponse> {
        throw new Error('Function not implemented.')
      },
      getTransactionReceipt: function (): Promise<TransactionReceipt> {
        throw new Error('Function not implemented.')
      },
      removedEvent: function (): OrphanFilter {
        throw new Error('Function not implemented.')
      }
    }
    const ddo = await processor.processEvent(event, 8996, provider)
    assert(ddo, 'DDO not indexed')
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
    const datatokenEvent = getEventFromTx(txReceipt, 'TokenCreated')
    datatokenAddress = datatokenEvent.args[0]
    assert(datatokenAddress, 'find datatoken created failed')
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
    setMetaDataTxReceipt = await setMetaDataTx.wait()
    assert(setMetaDataTxReceipt, 'set metada failed')
  })

  delay(30000)

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

  delay(30000)

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

  delay(30000)

  it('should get the active state', async () => {
    const retrievedDDO = await waitToIndex(assetDID, database)
    // Expect the result from contract
    expect(retrievedDDO.nft.state).to.equal(0)
  })

  it('should get OrderStarted event', async function () {
    this.timeout(15000) // Extend default Mocha test timeout
    const publisherAddress = await publisherAccount.getAddress()
    const consumerAddress = await consumerAccount.getAddress()
    const dataTokenContract = new Contract(
      datatokenAddress,
      ERC20Template.abi,
      publisherAccount
    )
    const paymentCollector = await dataTokenContract.getPaymentCollector()
    assert(paymentCollector === publisherAddress, 'paymentCollector not correct')

    const feeData = await createFee(
      resolvedDDO as DDO,
      0,
      'null',
      resolvedDDO.services[0]
    )

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

    orderEvent = getEventFromTx(orderTxReceipt, 'OrderStarted')
    expect(orderEvent.args[1]).to.equal(consumerAddress) // payer
    expect(parseInt(orderEvent.args[3].toString())).to.equal(serviceIndex) // serviceIndex
  })

  delay(30000)

  it('should get number of orders', async () => {
    const retrievedDDO = await waitToIndex(assetDID, database)
    expect(retrievedDDO.stats.orders).to.equal(1)
    initialOrderCount = retrievedDDO.stats.orders
    const resultOrder = await database.order.retrieve(orderTxId)
    expect(resultOrder?.id).to.equal(orderTxId)
    expect(resultOrder?.payer).to.equal(await consumerAccount.getAddress())
    expect(resultOrder?.type).to.equal('startOrder')
    const timestamp = orderEvent.args[4].toString()
    expect(resultOrder?.timestamp.toString()).to.equal(timestamp)
  })

  it('should detect OrderReused event', async function () {
    this.timeout(15000) // Extend default Mocha test timeout

    const feeData = await createFee(
      resolvedDDO as DDO,
      0,
      'null',
      resolvedDDO.services[0]
    )

    const orderTx = await dataTokenContractWithNewSigner.reuseOrder(
      orderTxId,
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
    reuseOrderTxId = orderTxReceipt.hash
    assert(reuseOrderTxId, 'transaction id not found')

    reusedOrderEvent = getEventFromTx(orderTxReceipt, 'OrderReused')
    expect(reusedOrderEvent.args[0]).to.equal(orderTxId)
  })

  delay(30000)

  it('should increase number of orders', async () => {
    const retrievedDDO = await waitToIndex(assetDID, database)
    expect(retrievedDDO.stats.orders).to.be.greaterThan(initialOrderCount)
    const resultOrder = await database.order.retrieve(reuseOrderTxId)
    expect(resultOrder?.id).to.equal(reuseOrderTxId)
    expect(resultOrder?.payer).to.equal(await consumerAccount.getAddress())
    expect(resultOrder?.type).to.equal('reuseOrder')
    const timestamp = reusedOrderEvent.args[2].toString()
    expect(resultOrder?.timestamp.toString()).to.equal(timestamp)
    expect(resultOrder?.startOrderId).to.equal(orderTxId)
  })

  it('should change metadata state to DEPRECATED', async () => {
    // Deprecated state for this asset
    const setMetaDataStateTx = await nftContract.setMetaDataState(2)
    const trxReceipt = await setMetaDataStateTx.wait()
    assert(trxReceipt, 'set metada state failed')
  })

  delay(30000)

  it('should have a short version of ddo', async () => {
    const result = await nftContract.getMetaData()
    expect(parseInt(result[2].toString())).to.equal(2)
    const resolvedDDO = await waitToIndex(assetDID, database)
    // Expect a short version of the DDO
    expect(Object.keys(resolvedDDO).length).to.equal(4)
    expect(
      'id' in resolvedDDO && 'nftAddress' in resolvedDDO && 'nft' in resolvedDDO
    ).to.equal(true)
  })

  it('should add reindex task', async () => {
    const reindexTask = {
      txId: setMetaDataTxReceipt.hash,
      chainId: '8996'
    }
    await OceanIndexer.addReindexTask(reindexTask)
  })

  it('should store ddo reindex', async () => {
    const resolvedDDO = await waitToIndex(assetDID, database)
    expect(resolvedDDO.id).to.equal(genericAsset.id)
  })
})
