import { expect, assert } from 'chai'
import { JsonRpcProvider, Signer, FallbackProvider } from 'ethers'
import { validateOrderTransaction } from '../../components/core/utils/validateOrders.js'
import { expectedTimeoutFailure, waitToIndex } from './testUtils.js'
import { genericDDO } from '../data/ddo.js'
import { Database } from '../../components/database/index.js'
import {
  DEVELOPMENT_CHAIN_ID,
  getOceanArtifactsAdresses,
  getOceanArtifactsAdressesByChainId
} from '../../utils/address.js'
import { publishAsset, orderAsset, reOrderAsset } from '../utils/assets.js'
import { RPCS } from '../../@types/blockchain.js'
import { OceanIndexer } from '../../components/Indexer/index.js'
import { OceanNode } from '../../OceanNode.js'
import { OceanNodeConfig } from '../../@types/OceanNode.js'
import { ENVIRONMENT_VARIABLES, EVENTS, getConfiguration } from '../../utils/index.js'
import {
  DEFAULT_TEST_TIMEOUT,
  OverrideEnvConfig,
  TEST_ENV_CONFIG_FILE,
  buildEnvOverrideConfig,
  getMockSupportedNetworks,
  setupEnvironment,
  tearDownEnvironment
} from '../utils/utils.js'
import { homedir } from 'os'
describe('validateOrderTransaction Function with Orders', () => {
  let database: Database
  let oceanNode: OceanNode
  let provider: JsonRpcProvider
  let fallbackProvider: FallbackProvider
  let publisherAccount: Signer
  let consumerAccount: Signer
  let consumerAddress: string
  let dataNftAddress: string
  let datatokenAddress: string
  let orderTxId: string
  let reOrderTxId: string
  let resolvedDDO: any
  let publishedDataset: any
  let indexer: OceanIndexer

  const serviceId = '0' // dummy index
  const timeout = 0
  let config: OceanNodeConfig
  const mockSupportedNetworks: RPCS = getMockSupportedNetworks()
  let previousConfiguration: OverrideEnvConfig[]
  before(async () => {
    previousConfiguration = await setupEnvironment(
      TEST_ENV_CONFIG_FILE,
      buildEnvOverrideConfig(
        [
          ENVIRONMENT_VARIABLES.RPCS,
          ENVIRONMENT_VARIABLES.INDEXER_NETWORKS,
          ENVIRONMENT_VARIABLES.PRIVATE_KEY,
          ENVIRONMENT_VARIABLES.AUTHORIZED_DECRYPTERS,
          ENVIRONMENT_VARIABLES.ADDRESS_FILE
        ],
        [
          JSON.stringify(mockSupportedNetworks),
          JSON.stringify([8996]),
          '0xc594c6e5def4bab63ac29eed19a134c130388f74f019bc74b8f4389df2837a58',
          JSON.stringify(['0xe2DD09d719Da89e5a3D0F2549c7E24566e947260']),
          `${homedir}/.ocean/ocean-contracts/artifacts/address.json`
        ]
      )
    )

    config = await getConfiguration(true) // Force reload the configuration
    const dbconn = await Database.init(config.dbConfig)
    oceanNode = await OceanNode.getInstance(config, dbconn)
    indexer = new OceanIndexer(
      dbconn,
      config.indexingNetworks,
      oceanNode.blockchainRegistry
    )
    oceanNode.addIndexer(indexer)

    let network = getOceanArtifactsAdressesByChainId(DEVELOPMENT_CHAIN_ID)
    if (!network) {
      network = getOceanArtifactsAdresses().development
    }

    provider = new JsonRpcProvider('http://127.0.0.1:8545')
    fallbackProvider = new FallbackProvider([provider])

    publisherAccount = (await provider.getSigner(0)) as Signer
    consumerAccount = (await provider.getSigner(1)) as Signer
    consumerAddress = await consumerAccount.getAddress()

    let artifactsAddresses = getOceanArtifactsAdressesByChainId(DEVELOPMENT_CHAIN_ID)
    if (!artifactsAddresses) {
      artifactsAddresses = getOceanArtifactsAdresses().development
    }

    const { dbConfig } = await getConfiguration(true)
    database = await Database.init(dbConfig)
  })

  it('Start instance of Database', () => {
    expect(database).to.be.instanceOf(Database)
  })

  it('should publish a dataset', async function () {
    this.timeout(DEFAULT_TEST_TIMEOUT * 2)
    publishedDataset = await publishAsset(genericDDO, publisherAccount)

    const { ddo, wasTimeout } = await waitToIndex(
      publishedDataset.ddo.id,
      EVENTS.METADATA_CREATED,
      DEFAULT_TEST_TIMEOUT * 2
    )

    if (!ddo) {
      expect(expectedTimeoutFailure(this.test.title)).to.be.equal(wasTimeout)
    } else {
      dataNftAddress = publishedDataset.nftAddress
      // eslint-disable-next-line prefer-destructuring
      datatokenAddress = publishedDataset.datatokenAddress
      assert(dataNftAddress, 'find nft created failed')
      assert(datatokenAddress, 'find datatoken created failed')
    }
  })

  it('should get the active state', async function () {
    const { ddo, wasTimeout } = await waitToIndex(
      publishedDataset.ddo.id,
      EVENTS.METADATA_CREATED,
      DEFAULT_TEST_TIMEOUT,
      true
    )
    resolvedDDO = ddo
    if (resolvedDDO) {
      expect(resolvedDDO.id).to.be.equal(publishedDataset.ddo.id)
    } else {
      expect(expectedTimeoutFailure(this.test.title)).to.be.equal(wasTimeout)
    }
  })

  it('should start an order and validate the transaction', async function () {
    const orderTx = await orderAsset(
      resolvedDDO,
      0,
      consumerAccount,
      await consumerAccount.getAddress(),
      publisherAccount,
      oceanNode
    )
    orderTxId = orderTx.hash
    assert(orderTxId, 'transaction id not found')

    // Use the transaction receipt in validateOrderTransaction

    const validationResult = await validateOrderTransaction(
      orderTxId,
      consumerAddress,
      fallbackProvider,
      dataNftAddress,
      datatokenAddress,
      parseInt(serviceId),
      timeout,
      consumerAccount
    )
    assert(validationResult.isValid, 'Transaction is not valid.')
    assert(
      validationResult.message === 'Transaction is valid.',
      'Invalid transaction validation message.'
    )
  })

  it('should reuse an order and validate the transaction', async function () {
    const reOrderTx = await reOrderAsset(
      orderTxId,
      resolvedDDO,
      0,
      consumerAccount,
      await consumerAccount.getAddress(),
      publisherAccount,
      oceanNode
    )
    reOrderTxId = reOrderTx.hash
    // Use the transaction receipt in validateOrderTransaction

    const validationResult = await validateOrderTransaction(
      reOrderTxId,
      consumerAddress,
      fallbackProvider,
      dataNftAddress,
      datatokenAddress,
      parseInt(serviceId),
      timeout,
      consumerAccount
    )

    assert(validationResult.isValid, 'Reuse order transaction is not valid.')
    assert(
      validationResult.message === 'Transaction is valid.',
      'Invalid reuse order transaction validation message.'
    )
  })

  it('should reject reuse an order with invald serviceId', async function () {
    const validationResult = await validateOrderTransaction(
      reOrderTxId,
      consumerAddress,
      fallbackProvider,
      dataNftAddress,
      datatokenAddress,
      parseInt('999'),
      timeout,
      consumerAccount
    )

    assert(!validationResult.isValid, 'Reuse order transaction should not be valid.')
    assert(
      validationResult.message === 'Invalid service index.',
      'Invalid reuse order transaction validation message.'
    )
  })

  it('should reject reuse an order with invald user address', async function () {
    const validationResult = await validateOrderTransaction(
      reOrderTxId,
      '0x0',
      fallbackProvider,
      dataNftAddress,
      datatokenAddress,
      parseInt(serviceId),
      timeout,
      consumerAccount
    )

    assert(!validationResult.isValid, 'Reuse order transaction should not be valid.')
    assert(
      validationResult.message ===
        'Tx id used not valid, one of the NFT addresses, Datatoken address or the User address contract address does not match.'
    )
  })
  after(async () => {
    await tearDownEnvironment(previousConfiguration)
    indexer.stopAllChainIndexers()
  })
})
