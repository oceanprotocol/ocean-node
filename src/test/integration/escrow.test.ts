import { assert, expect } from 'chai'
import { JsonRpcProvider, Signer, ethers, parseUnits } from 'ethers'
import { Readable } from 'stream'
import OceanToken from '@oceanprotocol/contracts/artifacts/contracts/utils/OceanToken.sol/OceanToken.json' with { type: 'json' }
import EscrowJson from '@oceanprotocol/contracts/artifacts/contracts/escrow/Escrow.sol/Escrow.json' with { type: 'json' }
import { Database } from '../../components/database/index.js'
import { OceanIndexer } from '../../components/Indexer/index.js'
import { OceanNode } from '../../OceanNode.js'
import { RPCS } from '../../@types/blockchain.js'
import { EscrowEventsHandler } from '../../components/core/handler/escrowHandler.js'
import { streamToString } from '../../utils/util.js'
import {
  DEVELOPMENT_CHAIN_ID,
  getOceanArtifactsAdresses,
  getOceanArtifactsAdressesByChainId
} from '../../utils/address.js'
import {
  ENVIRONMENT_VARIABLES,
  EVENTS,
  PROTOCOL_COMMANDS
} from '../../utils/constants.js'
import {
  DEFAULT_TEST_TIMEOUT,
  OverrideEnvConfig,
  buildEnvOverrideConfig,
  getMockSupportedNetworks,
  setupEnvironment,
  tearDownEnvironment
} from '../utils/utils.js'
import { waitForCondition } from './testUtils.js'
import { getConfiguration } from '../../utils/config.js'
import { homedir } from 'os'

describe('Indexer stores Escrow contract events', () => {
  let database: Database
  let oceanNode: OceanNode
  let indexer: OceanIndexer
  let provider: JsonRpcProvider
  let publisherAccount: Signer // payee that creates/claims locks
  let consumerAccount: Signer // payer that deposits/authorizes
  let payerAddress: string
  let payeeAddress: string
  let paymentToken: string
  let escrowAddress: string
  let tokenContract: any
  let escrowContract: any

  const chainId = DEVELOPMENT_CHAIN_ID
  const depositAmount = parseUnits('100', 18)
  const lockAmount = parseUnits('10', 18)
  const jobId = BigInt(Date.now())
  const expiry = 7200

  let depositTxHash: string
  let authTxHash: string
  let lockTxHash: string

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
          JSON.stringify([DEVELOPMENT_CHAIN_ID]),
          '0xc594c6e5def4bab63ac29eed19a134c130388f74f019bc74b8f4389df2837a58',
          `${homedir}/.ocean/ocean-contracts/artifacts/address.json`
        ]
      )
    )

    const config = await getConfiguration(true)
    database = await Database.init(config.dbConfig)

    const oldIndexer = OceanNode.getInstance(config, database).getIndexer()
    if (oldIndexer) {
      await oldIndexer.stopAllChainIndexers()
    }
    oceanNode = OceanNode.getInstance(
      config,
      database,
      null,
      null,
      null,
      null,
      null,
      true
    )

    let artifactsAddresses = getOceanArtifactsAdressesByChainId(DEVELOPMENT_CHAIN_ID)
    if (!artifactsAddresses) {
      artifactsAddresses = getOceanArtifactsAdresses().development
    }
    escrowAddress = artifactsAddresses?.Escrow
    paymentToken = artifactsAddresses?.Ocean

    provider = new JsonRpcProvider('http://127.0.0.1:8545')
    publisherAccount = (await provider.getSigner(0)) as Signer
    consumerAccount = (await provider.getSigner(1)) as Signer
    payerAddress = await consumerAccount.getAddress()
    payeeAddress = await publisherAccount.getAddress()

    const headBlock = await provider.getBlockNumber()
    await database.indexer.update(chainId, headBlock)

    indexer = new OceanIndexer(database, config, oceanNode.blockchainRegistry)
    oceanNode.addIndexer(indexer)

    if (escrowAddress && paymentToken) {
      tokenContract = new ethers.Contract(paymentToken, OceanToken.abi, publisherAccount)
      escrowContract = new ethers.Contract(escrowAddress, EscrowJson.abi, consumerAccount)
    }
  })

  after(async () => {
    await oceanNode.tearDownAll()
    await tearDownEnvironment(previousConfiguration)
  })

  it('escrow database is available', function () {
    if (!escrowAddress || !paymentToken) {
      // Escrow not deployed on this chain — nothing to index.
      this.skip()
    }
    assert(database.escrow, 'escrow database should be initialized')
  })

  it('indexes a Deposit event', async function () {
    if (!escrowAddress || !paymentToken) this.skip()
    this.timeout(DEFAULT_TEST_TIMEOUT * 3)

    let balance = await tokenContract.balanceOf(payerAddress)
    if (BigInt(balance.toString()) < depositAmount) {
      const mintTx = await tokenContract.mint(payerAddress, depositAmount)
      await mintTx.wait()
      balance = await tokenContract.balanceOf(payerAddress)
    }
    await (
      await tokenContract.connect(consumerAccount).approve(escrowAddress, depositAmount)
    ).wait()
    const tx = await escrowContract.deposit(paymentToken, depositAmount)
    const receipt = await tx.wait()
    depositTxHash = receipt.hash

    const events = await waitForCondition(
      () =>
        database.escrow.search({
          txHash: depositTxHash,
          eventType: EVENTS.ESCROW_DEPOSIT
        }),
      DEFAULT_TEST_TIMEOUT * 3 - 5000
    )
    assert(events && events.length > 0, 'Deposit event should be indexed')
    const event = events[0]
    expect(event.eventType).to.equal(EVENTS.ESCROW_DEPOSIT)
    expect(event.payer).to.equal(payerAddress.toLowerCase())
    expect(event.token).to.equal(paymentToken.toLowerCase())
    expect(event.amount).to.equal(depositAmount.toString())
    expect(event.chainId).to.equal(chainId)
  })

  it('indexes an Auth event', async function () {
    if (!escrowAddress || !paymentToken) this.skip()
    this.timeout(DEFAULT_TEST_TIMEOUT * 3)

    const tx = await escrowContract.authorize(
      paymentToken,
      payeeAddress,
      depositAmount,
      expiry,
      10
    )
    const receipt = await tx.wait()
    authTxHash = receipt.hash

    const events = await waitForCondition(
      () => database.escrow.search({ txHash: authTxHash, eventType: EVENTS.ESCROW_AUTH }),
      DEFAULT_TEST_TIMEOUT * 3 - 5000
    )
    assert(events && events.length > 0, 'Auth event should be indexed')
    const event = events[0]
    expect(event.payer).to.equal(payerAddress.toLowerCase())
    expect(event.payee).to.equal(payeeAddress.toLowerCase())
    expect(event.maxLockedAmount).to.equal(depositAmount.toString())
    expect(event.maxLockCounts).to.equal('10')
  })

  it('indexes a Lock event', async function () {
    if (!escrowAddress || !paymentToken) this.skip()
    this.timeout(DEFAULT_TEST_TIMEOUT * 3)

    const tx = await escrowContract
      .connect(publisherAccount)
      .createLock(jobId, paymentToken, payerAddress, lockAmount, expiry)
    const receipt = await tx.wait()
    lockTxHash = receipt.hash

    const events = await waitForCondition(
      () => database.escrow.search({ txHash: lockTxHash, eventType: EVENTS.ESCROW_LOCK }),
      DEFAULT_TEST_TIMEOUT * 3 - 5000
    )
    assert(events && events.length > 0, 'Lock event should be indexed')
    const event = events[0]
    expect(event.payer).to.equal(payerAddress.toLowerCase())
    expect(event.payee).to.equal(payeeAddress.toLowerCase())
    expect(event.jobId).to.equal(jobId.toString())
    expect(event.amount).to.equal(lockAmount.toString())
    expect(event.token).to.equal(paymentToken.toLowerCase())
  })

  it('returns indexed events through the EscrowEventsHandler (query command)', async function () {
    if (!escrowAddress || !paymentToken) this.skip()
    this.timeout(DEFAULT_TEST_TIMEOUT)

    const response = await new EscrowEventsHandler(oceanNode).handle({
      command: PROTOCOL_COMMANDS.GET_ESCROW_EVENTS,
      chainId,
      eventType: EVENTS.ESCROW_DEPOSIT,
      payer: payerAddress,
      caller: '127.0.0.1'
    })
    expect(response.status.httpStatus).to.equal(200)
    assert(response.stream, 'handler should return a stream')
    const result = JSON.parse(await streamToString(response.stream as Readable))
    assert(Array.isArray(result), 'result should be an array')
    assert(
      result.some((e: any) => e.txHash === depositTxHash),
      'query should return the indexed Deposit event'
    )
  })
})
