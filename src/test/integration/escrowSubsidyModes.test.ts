import { assert, expect } from 'chai'
import { JsonRpcProvider, Signer, ethers, parseUnits } from 'ethers'
import OceanToken from '@oceanprotocol/contracts/artifacts/contracts/utils/OceanToken.sol/OceanToken.json' with { type: 'json' }
import EscrowJson from '@oceanprotocol/contracts/artifacts/contracts/escrow/Escrow.sol/Escrow.json' with { type: 'json' }
import OPFSubsidyProvider from '@oceanprotocol/contracts/artifacts/contracts/subsidy/OPFSubsidyProvider.sol/OPFSubsidyProvider.json' with { type: 'json' }
import OneTimeSubsidyProvider from '@oceanprotocol/contracts/artifacts/contracts/subsidy/OneTimeSubsidyProvider.sol/OneTimeSubsidyProvider.json' with { type: 'json' }
import { Database } from '../../components/database/index.js'
import { OceanIndexer } from '../../components/Indexer/index.js'
import { OceanNode } from '../../OceanNode.js'
import { RPCS } from '../../@types/blockchain.js'
import {
  DEVELOPMENT_CHAIN_ID,
  getOceanArtifactsAdresses,
  getOceanArtifactsAdressesByChainId
} from '../../utils/address.js'
import { ENVIRONMENT_VARIABLES, EVENTS, JobType } from '../../utils/constants.js'
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

// End-to-end coverage for the Escrow v2 subsidy flows against BOTH subsidy-provider implementations
// (OPFSubsidyProvider and OneTimeSubsidyProvider), each in REFUND_ONLY and PREPAID_ONLY modes:
//   - PREPAID_ONLY: the provider pre-funds the lock at createLock → escrow emits `LockSponsored`.
//   - REFUND_ONLY:  the provider reimburses at claim      → escrow emits `Subsidized`.
// and asserts the node's indexer stores the right event with the right provider.
//
// The providers are DEPLOYED BY THE TEST (they have no constructor args and need no linking), so the
// test signer owns them and can set mode / limits / funding deterministically — Barge's default
// deploy does not ship these providers. The Escrow + Ocean token come from the local Barge address
// file; the whole suite skips when those are not deployed.
describe('Escrow v2 subsidy modes (OPF + OneTime, REFUND_ONLY + PREPAID_ONLY)', () => {
  // SubsidyModeConfig enum: BOTH=0, REFUND_ONLY=1, PREPAID_ONLY=2
  const MODE_REFUND_ONLY = 1
  const MODE_PREPAID_ONLY = 2
  const jobType = JobType.COMPUTE

  let database: Database
  let oceanNode: OceanNode
  let indexer: OceanIndexer
  let provider: JsonRpcProvider
  let nodeAccount: Signer // payee — creates & claims locks
  let payerAccount: Signer // payer — deposits & authorizes
  let nodeAddress: string
  let payerAddress: string
  let paymentToken: string
  let escrowAddress: string
  let tokenContract: any
  let escrowAsNode: any
  let opfProviderAddress: string | null = null
  let oneTimeProviderAddress: string | null = null

  const chainId = DEVELOPMENT_CHAIN_ID
  const LOCK_AMOUNT = parseUnits('1', 18)
  const LOCK_DURATION = 100000 // seconds (createLock expiry is a duration)
  const FUND = parseUnits('100000', 18)
  const BIG = parseUnits('1000000', 18)
  let jobSeq = BigInt(Date.now())
  const nextJobId = () => (jobSeq += 1n)

  let previousConfiguration: OverrideEnvConfig[]
  const mockSupportedNetworks: RPCS = getMockSupportedNetworks()

  // search() returns [] (truthy) when empty, which would resolve waitForCondition on the first poll;
  // return null until a matching row is indexed.
  const waitForEscrowEvents = (filters: Record<string, any>) =>
    waitForCondition(
      async () => {
        const found = await database.escrow.search(filters)
        return found && found.length ? found : null
      },
      DEFAULT_TEST_TIMEOUT * 3 - 5000
    )

  // Deploy a fresh subsidy provider (test signer = owner) so mode/limits/funding are fully ours.
  async function deployProvider(artifact: any): Promise<string> {
    const factory = new ethers.ContractFactory(
      artifact.abi,
      artifact.bytecode,
      nodeAccount
    )
    const contract = await factory.deploy()
    await contract.waitForDeployment()
    return await contract.getAddress()
  }

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
    nodeAccount = (await provider.getSigner(0)) as Signer
    payerAccount = (await provider.getSigner(1)) as Signer
    nodeAddress = await nodeAccount.getAddress()
    payerAddress = await payerAccount.getAddress()

    const headBlock = await provider.getBlockNumber()
    await database.indexer.update(chainId, headBlock)

    indexer = new OceanIndexer(database, config, oceanNode.blockchainRegistry)
    oceanNode.addIndexer(indexer)

    if (!escrowAddress || !paymentToken) return // suite will skip

    tokenContract = new ethers.Contract(paymentToken, OceanToken.abi, nodeAccount)
    escrowAsNode = new ethers.Contract(escrowAddress, EscrowJson.abi, nodeAccount)

    // Fund the payer, then deposit + authorize generously so every lock below succeeds regardless
    // of how much the provider ends up sponsoring (payer covers only the unsponsored portion).
    await (await tokenContract.mint(payerAddress, BIG)).wait()
    await (await tokenContract.connect(payerAccount).approve(escrowAddress, BIG)).wait()
    await (
      await new ethers.Contract(escrowAddress, EscrowJson.abi, payerAccount).deposit(
        paymentToken,
        parseUnits('1000', 18)
      )
    ).wait()
    await (
      await new ethers.Contract(escrowAddress, EscrowJson.abi, payerAccount).authorize(
        paymentToken,
        nodeAddress,
        BIG, // maxLockedAmount
        BIG, // maxLockSeconds (>= LOCK_DURATION)
        1000, // maxLockCounts
        0 // expiryTimestamp: indefinite
      )
    ).wait()

    // Deploy both providers once (owned by nodeAccount).
    opfProviderAddress = await deployProvider(OPFSubsidyProvider)
    oneTimeProviderAddress = await deployProvider(OneTimeSubsidyProvider)
  })

  after(async () => {
    await oceanNode.tearDownAll()
    await tearDownEnvironment(previousConfiguration)
  })

  // Configure a provider for a given mode: fund it, allow the jobType + token, authorize the escrow,
  // and set the subsidy mode. OPF uses setTokenLimits; OneTime uses setTokenConfig (per-user credit).
  async function configureProvider(
    kind: 'opf' | 'onetime',
    providerAddress: string,
    mode: number
  ) {
    const abi = kind === 'opf' ? OPFSubsidyProvider.abi : OneTimeSubsidyProvider.abi
    const c = new ethers.Contract(providerAddress, abi, nodeAccount)
    // Fund the provider so it has budget to sponsor / reimburse.
    await (await tokenContract.mint(providerAddress, FUND)).wait()
    if (kind === 'opf') {
      // pctBps=10000 (100%), daily/monthly generous, weekly 0 (unused), enabled
      await (await c.setTokenLimits(paymentToken, 10000, BIG, 0, BIG, true)).wait()
    } else {
      // pctBps=0 (no per-job cap), generous default one-time credit per user, enabled
      await (await c.setTokenConfig(paymentToken, 0, BIG, true)).wait()
    }
    await (await c.setAllowedJobTypes([jobType])).wait()
    await (await c.setAuthorizedEscrow(escrowAddress, true)).wait()
    await (await c.setSubsidyMode(mode)).wait()
  }

  // Drive one mode end-to-end and assert the indexed event.
  async function runPrepaid(providerAddress: string) {
    const jobId = nextJobId()
    // createLock naming the provider → onSubsidyLock pre-funds → escrow emits LockSponsored.
    const tx = await escrowAsNode.createLock(
      jobId,
      paymentToken,
      payerAddress,
      LOCK_AMOUNT,
      LOCK_DURATION,
      jobType,
      [providerAddress]
    )
    const receipt = await tx.wait()
    const events = await waitForEscrowEvents({
      txHash: receipt.hash,
      eventType: EVENTS.ESCROW_LOCK_SPONSORED
    })
    assert(events && events.length > 0, 'LockSponsored event should be indexed')
    const event = events[0]
    expect(event.provider).to.equal(providerAddress.toLowerCase())
    expect(event.payer).to.equal(payerAddress.toLowerCase())
    expect(event.payee).to.equal(nodeAddress.toLowerCase())
    expect(event.jobId).to.equal(jobId.toString())
    expect(event.token).to.equal(paymentToken.toLowerCase())
    assert(event.amount !== undefined, 'sponsored amount should be populated')
    expect(BigInt(event.amount) > 0n, 'sponsored amount should be > 0').to.equal(true)
  }

  async function runRefund(providerAddress: string) {
    const jobId = nextJobId()
    // Plain payer-funded lock (no providers at lock), then claim naming the provider →
    // onSubsidyClaim reimburses → escrow emits Subsidized.
    await (
      await escrowAsNode.createLock(
        jobId,
        paymentToken,
        payerAddress,
        LOCK_AMOUNT,
        LOCK_DURATION,
        jobType,
        []
      )
    ).wait()
    const claimTx = await escrowAsNode.claimLock(
      jobId,
      paymentToken,
      payerAddress,
      LOCK_AMOUNT,
      ethers.toUtf8Bytes('subsidy-proof'),
      jobType,
      [providerAddress]
    )
    const receipt = await claimTx.wait()
    const events = await waitForEscrowEvents({
      txHash: receipt.hash,
      eventType: EVENTS.ESCROW_SUBSIDIZED
    })
    assert(events && events.length > 0, 'Subsidized event should be indexed')
    const event = events[0]
    expect(event.provider).to.equal(providerAddress.toLowerCase())
    expect(event.payer).to.equal(payerAddress.toLowerCase())
    expect(event.payee).to.equal(nodeAddress.toLowerCase())
    expect(event.jobId).to.equal(jobId.toString())
    expect(event.token).to.equal(paymentToken.toLowerCase())
    assert(event.subsidyAmount !== undefined, 'subsidyAmount should be populated')
    expect(BigInt(event.subsidyAmount) > 0n, 'subsidyAmount should be > 0').to.equal(true)
  }

  it('OPFSubsidyProvider — PREPAID_ONLY → LockSponsored', async function () {
    if (!escrowAddress || !paymentToken || !opfProviderAddress) this.skip()
    this.timeout(DEFAULT_TEST_TIMEOUT * 4)
    await configureProvider('opf', opfProviderAddress!, MODE_PREPAID_ONLY)
    await runPrepaid(opfProviderAddress!)
  })

  it('OPFSubsidyProvider — REFUND_ONLY → Subsidized', async function () {
    if (!escrowAddress || !paymentToken || !opfProviderAddress) this.skip()
    this.timeout(DEFAULT_TEST_TIMEOUT * 4)
    await configureProvider('opf', opfProviderAddress!, MODE_REFUND_ONLY)
    await runRefund(opfProviderAddress!)
  })

  it('OneTimeSubsidyProvider — PREPAID_ONLY → LockSponsored', async function () {
    if (!escrowAddress || !paymentToken || !oneTimeProviderAddress) this.skip()
    this.timeout(DEFAULT_TEST_TIMEOUT * 4)
    await configureProvider('onetime', oneTimeProviderAddress!, MODE_PREPAID_ONLY)
    await runPrepaid(oneTimeProviderAddress!)
  })

  it('OneTimeSubsidyProvider — REFUND_ONLY → Subsidized', async function () {
    if (!escrowAddress || !paymentToken || !oneTimeProviderAddress) this.skip()
    this.timeout(DEFAULT_TEST_TIMEOUT * 4)
    await configureProvider('onetime', oneTimeProviderAddress!, MODE_REFUND_ONLY)
    await runRefund(oneTimeProviderAddress!)
  })
})
