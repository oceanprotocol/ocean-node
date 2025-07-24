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
  parseUnits
} from 'ethers'
import { Readable } from 'stream'
import ERC721Factory from '@oceanprotocol/contracts/artifacts/contracts/ERC721Factory.sol/ERC721Factory.json' assert { type: 'json' }
import ERC721Template from '@oceanprotocol/contracts/artifacts/contracts/templates/ERC721Template.sol/ERC721Template.json' assert { type: 'json' }
import ERC20Template from '@oceanprotocol/contracts/artifacts/contracts/templates/ERC20TemplateEnterprise.sol/ERC20TemplateEnterprise.json' assert { type: 'json' }
import { Database } from '../../components/database/index.js'
import {
  INDEXER_CRAWLING_EVENT_EMITTER,
  OceanIndexer
} from '../../components/Indexer/index.js'
import { RPCS } from '../../@types/blockchain.js'
import { getEventFromTx, sleep, streamToObject } from '../../utils/util.js'
import { waitToIndex, expectedTimeoutFailure } from './testUtils.js'
import { genericDDO } from '../data/ddo.js'
import {
  DEVELOPMENT_CHAIN_ID,
  getOceanArtifactsAdresses,
  getOceanArtifactsAdressesByChainId
} from '../../utils/address.js'
import { createFee } from '../../components/core/utils/feesHandler.js'
import { Asset, DDO } from '@oceanprotocol/ddo-js'
import {
  DEFAULT_TEST_TIMEOUT,
  OverrideEnvConfig,
  TEST_ENV_CONFIG_FILE,
  buildEnvOverrideConfig,
  getMockSupportedNetworks,
  setupEnvironment,
  tearDownEnvironment
} from '../utils/utils.js'
import {
  ENVIRONMENT_VARIABLES,
  EVENTS,
  INDEXER_CRAWLING_EVENTS,
  PROTOCOL_COMMANDS
} from '../../utils/constants.js'
import { homedir } from 'os'
import { QueryDdoStateHandler } from '../../components/core/handler/queryHandler.js'
import { OceanNode } from '../../OceanNode.js'
import { QueryCommand } from '../../@types/commands.js'
import {
  getDeployedContractBlock,
  getNetworkHeight
} from '../../components/Indexer/utils.js'
import { Blockchain } from '../../utils/blockchain.js'
import { getConfiguration } from '../../utils/config.js'
import { OceanNodeConfig } from '../../@types/OceanNode.js'
import { encrypt } from '../../utils/crypt.js'
import { EncryptMethod } from '../../@types/fileObject.js'
import { deleteIndexedMetadataIfExists } from '../../utils/asset.js'

describe('Indexer stores a new metadata events and orders.', () => {
  let database: Database
  let oceanNode: OceanNode
  let provider: JsonRpcProvider
  let factoryContract: Contract
  let nftContract: Contract
  let publisherAccount: Signer
  let consumerAccount: Signer
  let nftAddress: string
  let datatokenAddress: string
  const chainId = 8996
  let assetDID: string
  let resolvedDDO: Asset
  let genericAsset: any
  let setMetaDataTxReceipt: any
  let orderTxId: string
  let reuseOrderTxId: string
  let dataTokenContractWithNewSigner: any
  let orderEvent: any
  let reusedOrderEvent: any
  let initialOrderCount: number
  let indexer: OceanIndexer
  const feeToken = '0x312213d6f6b5FCF9F56B7B8946A6C727Bf4Bc21f'
  const serviceIndex = 0 // dummy index
  const consumeMarketFeeAddress = ZeroAddress // marketplace fee Collector
  const consumeMarketFeeAmount = 0 // fee to be collected on top, requires approval
  const consumeMarketFeeToken = feeToken // token address for the feeAmount
  const mockSupportedNetworks: RPCS = getMockSupportedNetworks()
  let previousConfiguration: OverrideEnvConfig[]

  before(async () => {
    previousConfiguration = await setupEnvironment(
      null,
      buildEnvOverrideConfig(
        [
          ENVIRONMENT_VARIABLES.RPCS,
          ENVIRONMENT_VARIABLES.INDEXER_NETWORKS,
          ENVIRONMENT_VARIABLES.PRIVATE_KEY,
          ENVIRONMENT_VARIABLES.ADDRESS_FILE
        ],
        [
          JSON.stringify(mockSupportedNetworks),
          JSON.stringify([8996]),
          '0xc594c6e5def4bab63ac29eed19a134c130388f74f019bc74b8f4389df2837a58',
          `${homedir}/.ocean/ocean-contracts/artifacts/address.json`
        ]
      )
    )

    const config = await getConfiguration(true)
    database = await new Database(config.dbConfig)
    oceanNode = await OceanNode.getInstance(config, database)
    indexer = new OceanIndexer(database, mockSupportedNetworks)
    oceanNode.addIndexer(indexer)
    let artifactsAddresses = getOceanArtifactsAdressesByChainId(DEVELOPMENT_CHAIN_ID)
    if (!artifactsAddresses) {
      artifactsAddresses = getOceanArtifactsAdresses().development
    }

    provider = new JsonRpcProvider('http://127.0.0.1:8545')
    publisherAccount = (await provider.getSigner(0)) as Signer
    consumerAccount = (await provider.getSigner(1)) as Signer
    genericAsset = JSON.parse(JSON.stringify(genericDDO))
    factoryContract = new ethers.Contract(
      artifactsAddresses.ERC721Factory,
      ERC721Factory.abi,
      publisherAccount
    )
  })

  it('instance Database', () => {
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
    // create proper service.files string
    genericAsset.services[0].datatokenAddress = datatokenAddress
    genericAsset.services[0].files.datatokenAddress = datatokenAddress
    genericAsset.services[0].files.nftAddress = nftAddress
    // let's call node to encrypt

    const data = Uint8Array.from(
      Buffer.from(JSON.stringify(genericAsset.services[0].files))
    )
    const encryptedData = await encrypt(data, EncryptMethod.ECIES)
    const encryptedDataString = encryptedData.toString('hex')
    genericAsset.services[0].files = encryptedDataString
    const stringDDO = JSON.stringify(genericAsset)
    const bytes = Buffer.from(stringDDO)
    const metadata = hexlify(bytes)
    const hash = createHash('sha256').update(metadata).digest('hex')

    const setMetaDataTx = await nftContract.setMetaData(
      0,
      'http://v4.provider.oceanprotocol.com',
      '0x123',
      '0x01',
      metadata,
      '0x' + hash,
      []
    )
    setMetaDataTxReceipt = await setMetaDataTx.wait()
    assert(setMetaDataTxReceipt, 'set metada failed')
    // for testing purpose
    genericAsset.event.tx = setMetaDataTxReceipt.transactionHash
    genericAsset.event.block = setMetaDataTxReceipt.blockNumber
    genericAsset.event.from = setMetaDataTxReceipt.from
    genericAsset.event.contract = setMetaDataTxReceipt.contractAddress
    genericAsset.event.datetime = '2023-02-15T16:42:22'
  })

  it('should store the ddo in the database and return it ', async function () {
    this.timeout(DEFAULT_TEST_TIMEOUT * 2)
    const { ddo, wasTimeout } = await waitToIndex(
      assetDID,
      EVENTS.METADATA_CREATED,
      DEFAULT_TEST_TIMEOUT * 2
    )
    if (ddo) {
      resolvedDDO = ddo
      expect(resolvedDDO.id).to.equal(genericAsset.id)
    } else expect(expectedTimeoutFailure(this.test.title)).to.be.equal(wasTimeout)
  })

  it('should have nft field stored in ddo', async function () {
    assert(resolvedDDO.indexedMetadata.nft, 'NFT field is not present')
    assert(
      resolvedDDO.indexedMetadata.nft.address?.toLowerCase() ===
        nftAddress?.toLowerCase(),
      'NFT address mismatch'
    )
    assert(resolvedDDO.indexedMetadata.nft.state === 0, 'NFT state mismatch') // ACTIVE
    assert(
      resolvedDDO.indexedMetadata.nft.name === (await nftContract.name()),
      'NFT name mismatch'
    )
    assert(
      resolvedDDO.indexedMetadata.nft.symbol === (await nftContract.symbol()),
      'NFT symbol mismatch'
    )
    assert(
      resolvedDDO.indexedMetadata.nft.tokenURI ===
        (await nftContract.tokenURI(await nftContract.getId())),
      'NFT tokeURI mismatch'
    )
    assert(
      resolvedDDO.indexedMetadata.nft.owner?.toLowerCase() ===
        setMetaDataTxReceipt.from?.toLowerCase(),
      'NFT owner mismatch'
    )
    assert(
      resolvedDDO.indexedMetadata.nft.created,
      'NFT created timestamp does not exist'
    )
  })

  it('should store the ddo state in the db with no errors and retrieve it using did', async function () {
    const ddoState = await database.ddoState.retrieve(resolvedDDO.id)
    console.log('ddoState: ', ddoState)
    assert(ddoState, 'ddoState not found')
    expect(resolvedDDO.id).to.equal(ddoState.did)
    expect(ddoState.valid).to.equal(true)
    expect(ddoState.error).to.equal(' ')
    // add txId check once we have that as change merged and the event will be indexed
  })

  it('should find the state of the ddo using query ddo state handler', async function () {
    const queryDdoStateHandler = new QueryDdoStateHandler(oceanNode)
    // query using the did
    const queryDdoState: QueryCommand = {
      query: {
        q: resolvedDDO.id,
        query_by: 'did'
      },
      command: PROTOCOL_COMMANDS.QUERY
    }
    const response = await queryDdoStateHandler.handle(queryDdoState)
    console.log('queryDdoStateHandler response: ', response)
    assert(response, 'Failed to get response')
    assert(response.status.httpStatus === 200, 'Failed to get 200 response')
    assert(response.stream, 'Failed to get stream')
    const result = await streamToObject(response.stream as Readable)
    if (result) {
      // Elastic Search returns Array type
      const ddoState = Array.isArray(result) ? result[0] : result.hits[0].document
      expect(resolvedDDO.id).to.equal(ddoState.did)
      expect(ddoState.valid).to.equal(true)
      expect(ddoState.error).to.equal(' ')
    }

    // add txId check once we have that as change merged and the event will be indexed
  })

  it('should update ddo metadata fields ', async () => {
    resolvedDDO.metadata.name = 'dataset-name-updated'
    resolvedDDO.metadata.description =
      'Updated description for the Ocean protocol test dataset'
    resolvedDDO = deleteIndexedMetadataIfExists(resolvedDDO)
    const stringDDO = JSON.stringify(resolvedDDO)
    const bytes = Buffer.from(stringDDO)
    const metadata = hexlify(bytes)
    const hash = createHash('sha256').update(metadata).digest('hex')

    const setMetaDataTx = await nftContract.setMetaData(
      0,
      'http://v4.provider.oceanprotocol.com',
      '0x123',
      '0x01',
      metadata,
      '0x' + hash,
      []
    )
    const trxReceipt = await setMetaDataTx.wait()
    assert(trxReceipt, 'set metada failed')
  })

  it('should detect update event and store the udpdated ddo in the database', async function () {
    const { ddo, wasTimeout } = await waitToIndex(
      assetDID,
      EVENTS.METADATA_UPDATED,
      DEFAULT_TEST_TIMEOUT,
      true
    )
    const updatedDDO: any = ddo
    if (updatedDDO) {
      expect(updatedDDO.metadata.name).to.equal('dataset-name-updated')
      expect(updatedDDO.metadata.description).to.equal(
        'Updated description for the Ocean protocol test dataset'
      )
    } else expect(expectedTimeoutFailure(this.test.title)).to.be.equal(wasTimeout)
  })

  it('should change metadata state of the published DDO', async () => {
    const setMetaDataStateTx = await nftContract.setMetaDataState(4)
    const trxReceipt = await setMetaDataStateTx.wait()
    assert(trxReceipt, 'set metada state failed')
  })

  it('should get the updated state', async function () {
    const result = await nftContract.getMetaData()
    const { ddo, wasTimeout } = await waitToIndex(
      assetDID,
      EVENTS.METADATA_UPDATED,
      DEFAULT_TEST_TIMEOUT,
      true
    )
    const retrievedDDO: any = ddo
    if (retrievedDDO) {
      expect(retrievedDDO.indexedMetadata.nft).to.not.equal(undefined)
      expect(retrievedDDO).to.have.nested.property('indexedMetadata.nft.state')
      // Expect the result from contract
      expect(retrievedDDO.indexedMetadata.nft.state).to.equal(
        parseInt(result[2].toString())
      )
    } else expect(expectedTimeoutFailure(this.test.title)).to.be.equal(wasTimeout)
  })

  it('should change metadata state back to ACTIVE state', async () => {
    const setMetaDataStateTx = await nftContract.setMetaDataState(0)
    const trxReceipt = await setMetaDataStateTx.wait()
    assert(trxReceipt, 'set metada state failed')
  })

  it('should get the active state', async function () {
    const { ddo, wasTimeout } = await waitToIndex(
      assetDID,
      EVENTS.METADATA_UPDATED,
      DEFAULT_TEST_TIMEOUT,
      true
    )
    const retrievedDDO: any = ddo
    if (retrievedDDO != null) {
      // Expect the result from contract
      expect(retrievedDDO.id).to.equal(assetDID)
      expect(retrievedDDO.indexedMetadata.nft.state).to.equal(0)
    } else expect(expectedTimeoutFailure(this.test.title)).to.be.equal(wasTimeout)
  })

  it('should get OrderStarted event', async function () {
    const publisherAddress = await publisherAccount.getAddress()
    const consumerAddress = await consumerAccount.getAddress()
    const dataTokenContract = new Contract(
      datatokenAddress,
      ERC20Template.abi,
      publisherAccount
    )
    const paymentCollector = await dataTokenContract.getPaymentCollector()
    assert(
      paymentCollector?.toLowerCase() === publisherAddress?.toLowerCase(),
      'paymentCollector not correct'
    )

    const feeData = await createFee(
      resolvedDDO as DDO,
      0,
      'null',
      resolvedDDO.services[0]
    )

    // call the mint function on the dataTokenContract
    const mintTx = await dataTokenContract.mint(consumerAddress, parseUnits('1000', 18))
    await mintTx.wait()
    const consumerBalance = await dataTokenContract.balanceOf(consumerAddress)
    assert(consumerBalance === parseUnits('1000', 18), 'consumer balance not correct')
    // handle fees
    // get provider fees in our account as well
    const providerFeeTokenContract = new Contract(
      feeData.providerFeeToken,
      ERC20Template.abi,
      publisherAccount
    )
    const feeMintTx = await providerFeeTokenContract.mint(
      await consumerAccount.getAddress(),
      feeData.providerFeeAmount
    )
    await feeMintTx.wait()

    const approveTx = await (
      providerFeeTokenContract.connect(consumerAccount) as any
    ).approve(await dataTokenContract.getAddress(), feeData.providerFeeAmount)
    await approveTx.wait()

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

  it('should get number of orders', async function () {
    this.timeout(DEFAULT_TEST_TIMEOUT * 2)
    const { ddo, wasTimeout } = await waitToIndex(
      assetDID,
      EVENTS.ORDER_STARTED,
      DEFAULT_TEST_TIMEOUT * 2,
      true
    )
    if (ddo) {
      const retrievedDDO = ddo
      console.log('indexer retrieved ddo: ', JSON.stringify(retrievedDDO))
      for (const stat of retrievedDDO.indexedMetadata.stats) {
        if (stat.datatokenAddress === datatokenAddress) {
          expect(stat.orders).to.equal(1)
          initialOrderCount = stat.orders
          break
        }
      }
      const resultOrder = await database.order.retrieve(orderTxId)
      if (resultOrder) {
        if (resultOrder.id) {
          // typesense response
          expect(resultOrder.id).to.equal(orderTxId)
        } else if (resultOrder.orderId) {
          // elastic search response
          expect(resultOrder.orderId).to.equal(orderTxId)
        }

        expect(resultOrder.payer).to.equal(await consumerAccount.getAddress())
        expect(resultOrder.type).to.equal('startOrder')
        const timestamp = orderEvent.args[4].toString()
        expect(resultOrder.timestamp.toString()).to.equal(timestamp)
      }
    } else {
      expect(expectedTimeoutFailure(this.test.title)).to.be.equal(wasTimeout)
    }
  })

  it('should detect OrderReused event', async function () {
    this.timeout(DEFAULT_TEST_TIMEOUT * 2)
    const feeData = await createFee(
      resolvedDDO as DDO,
      0,
      'null',
      resolvedDDO.services[0]
    )
    // handle fees
    // get provider fees in our account as well
    const providerFeeTokenContract = new Contract(
      feeData.providerFeeToken,
      ERC20Template.abi,
      publisherAccount
    )
    const feeMintTx = await providerFeeTokenContract.mint(
      await consumerAccount.getAddress(),
      feeData.providerFeeAmount
    )
    await feeMintTx.wait()

    const approveTx = await (
      providerFeeTokenContract.connect(consumerAccount) as any
    ).approve(
      await dataTokenContractWithNewSigner.getAddress(),
      feeData.providerFeeAmount
    )
    await approveTx.wait()
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

  it('should increase number of orders', async function () {
    this.timeout(DEFAULT_TEST_TIMEOUT * 3)
    const { ddo, wasTimeout } = await waitToIndex(
      assetDID,
      EVENTS.ORDER_REUSED,
      DEFAULT_TEST_TIMEOUT * 3,
      true
    )

    const retrievedDDO = ddo

    if (retrievedDDO) {
      for (const stat of retrievedDDO.indexedMetadata.stats) {
        if (stat.datatokenAddress === datatokenAddress) {
          expect(stat.orders).to.be.greaterThan(initialOrderCount)
          break
        }
      }
      const resultOrder = await database.order.retrieve(reuseOrderTxId)
      if (resultOrder) {
        if (resultOrder.id) {
          // typesense
          expect(resultOrder.id).to.equal(reuseOrderTxId)
        } else if (resultOrder.orderId) {
          // elastic
          expect(resultOrder.orderId).to.equal(reuseOrderTxId)
        }

        expect(resultOrder.payer).to.equal(await consumerAccount.getAddress())
        expect(resultOrder.type).to.equal('reuseOrder')
        const timestamp = reusedOrderEvent.args[2].toString()
        expect(resultOrder.timestamp.toString()).to.equal(timestamp)
        expect(resultOrder.startOrderId).to.equal(orderTxId)
      }

      // }
    } else {
      expect(expectedTimeoutFailure(this.test.title)).to.be.equal(wasTimeout)
    }
  })

  it('should change metadata state to DEPRECATED', async () => {
    // Deprecated state for this asset
    const setMetaDataStateTx = await nftContract.setMetaDataState(2)
    const trxReceipt = await setMetaDataStateTx.wait()
    assert(trxReceipt, 'set metada state failed')
  })

  it('Deprecated asset should have a short version of ddo', async function () {
    const result = await nftContract.getMetaData()
    expect(parseInt(result[2].toString())).to.equal(2)

    const { ddo, wasTimeout } = await waitToIndex(
      assetDID,
      EVENTS.METADATA_STATE,
      DEFAULT_TEST_TIMEOUT,
      true
    )
    const resolvedDDO: any = ddo
    if (resolvedDDO) {
      // Expect a short version of the DDO
      expect(Object.keys(resolvedDDO).length).to.equal(5)
      expect(
        'id' in resolvedDDO &&
          'nftAddress' in resolvedDDO &&
          'nft' in resolvedDDO.indexedMetadata
      ).to.equal(true)
    } else {
      expect(expectedTimeoutFailure(this.test.title)).to.be.equal(wasTimeout)
    }
  })

  it('should add reindex task', () => {
    const reindexTask = {
      txId: setMetaDataTxReceipt.hash,
      chainId: 8996
    }
    indexer.addReindexTask(reindexTask)
  })

  it('should get reindex queue', () => {
    const queue = indexer.getIndexingQueue()
    expect(queue.length).to.be.greaterThanOrEqual(1)
  })

  it('should store ddo reindex', async function () {
    const { ddo, wasTimeout } = await waitToIndex(
      assetDID,
      EVENTS.METADATA_CREATED,
      DEFAULT_TEST_TIMEOUT
    )
    const resolvedDDO: any = ddo
    if (resolvedDDO) {
      expect(resolvedDDO.id).to.equal(genericAsset.id)
    } else {
      expect(expectedTimeoutFailure(this.test.title)).to.be.equal(wasTimeout)
    }
  })

  it('should get empty reindex queue', () => {
    setTimeout(() => {
      // needs to wait for indexer task to run at least once
      const queue = indexer.getIndexingQueue()
      expect(queue.length).to.be.equal(0)
    }, DEFAULT_TEST_TIMEOUT / 2)
  })

  after(async () => {
    await tearDownEnvironment(previousConfiguration)
    indexer.stopAllThreads()
  })
})

describe('OceanIndexer - crawler threads', () => {
  let envOverrides: OverrideEnvConfig[]
  let config: OceanNodeConfig
  let db: Database
  let blockchain: Blockchain

  let oceanIndexer: OceanIndexer
  const supportedNetworks: RPCS = getMockSupportedNetworks()
  const chainID = DEVELOPMENT_CHAIN_ID.toString()

  let netHeight = 0
  let deployBlock = 0
  let startingBlock = 0

  before(async () => {
    blockchain = new Blockchain(
      supportedNetworks[chainID].rpc,
      supportedNetworks[chainID].network,
      supportedNetworks[chainID].chainId
    )

    deployBlock = getDeployedContractBlock(supportedNetworks[chainID].chainId)
    netHeight = await getNetworkHeight(blockchain.getProvider())
    startingBlock = deployBlock + 1
    supportedNetworks[chainID].startBlock = startingBlock

    envOverrides = buildEnvOverrideConfig(
      [ENVIRONMENT_VARIABLES.RPCS, ENVIRONMENT_VARIABLES.ADDRESS_FILE],
      [
        JSON.stringify(supportedNetworks),
        `${homedir}/.ocean/ocean-contracts/artifacts/address.json`
      ]
    )
    envOverrides = await setupEnvironment(TEST_ENV_CONFIG_FILE, envOverrides)
    config = await getConfiguration(true)
    db = await new Database(config.dbConfig)
  })

  it('should start a worker thread and handle RPCS "startBlock"', async () => {
    INDEXER_CRAWLING_EVENT_EMITTER.addListener(
      INDEXER_CRAWLING_EVENTS.CRAWLING_STARTED,
      (data: any) => {
        const { startBlock, contractDeploymentBlock, networkHeight } = data
        expect(startBlock).to.be.equal(startingBlock)
        expect(contractDeploymentBlock).to.be.equal(deployBlock)
        expect(networkHeight).to.be.equal(netHeight)
      }
    )
    oceanIndexer = new OceanIndexer(db, supportedNetworks)
    await sleep(DEFAULT_TEST_TIMEOUT / 2)
  })

  after(async () => {
    await tearDownEnvironment(envOverrides)
    oceanIndexer.stopAllThreads()
    INDEXER_CRAWLING_EVENT_EMITTER.removeAllListeners(
      INDEXER_CRAWLING_EVENTS.CRAWLING_STARTED
    )
  })
})
