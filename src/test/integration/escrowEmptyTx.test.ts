import { assert, expect } from 'chai'
import { JsonRpcProvider, Signer, ethers, parseUnits } from 'ethers'
import OceanToken from '@oceanprotocol/contracts/artifacts/contracts/utils/OceanToken.sol/OceanToken.json' with { type: 'json' }
import EscrowJson from '@oceanprotocol/contracts/artifacts/contracts/escrow/Escrow.sol/Escrow.json' with { type: 'json' }
import { Database } from '../../components/database/index.js'
import { OceanNode } from '../../OceanNode.js'
import { Escrow } from '../../components/core/utils/escrow.js'
import { RPCS } from '../../@types/blockchain.js'
import { create256Hash } from '../../utils/crypt.js'
import {
  DEVELOPMENT_CHAIN_ID,
  getOceanArtifactsAdresses,
  getOceanArtifactsAdressesByChainId
} from '../../utils/address.js'
import { ENVIRONMENT_VARIABLES, JobType, ZERO_PAYMENT_TX } from '../../utils/constants.js'
import {
  DEFAULT_TEST_TIMEOUT,
  OverrideEnvConfig,
  buildEnvOverrideConfig,
  getMockSupportedNetworks,
  setupEnvironment,
  tearDownEnvironment
} from '../utils/utils.js'
import { getConfiguration } from '../../utils/config.js'
import { homedir } from 'os'

// End-to-end proof (against Barge) of the ESCROW_EMPTY_TX behaviour, driven through the `Escrow`
// WRAPPER the node actually uses — not the raw contract. The unit tests stub getPaymentAmountInWei
// and the chain, so they verify the branch logic but not the real on-chain claim: that no tx is
// sent and no gas is spent when the amount is 0 and the flag is off. The deterministic proofs here
// are the node signer's nonce (unchanged → no tx was sent) and getLocks (no on-chain lock was
// created). Requires a running local chain + deployed Escrow/Ocean (see docs/testing.md); the
// whole suite self-skips when those artifacts are absent.
describe('ESCROW_EMPTY_TX end-to-end (zero-amount lock/claim on-chain)', () => {
  let database: Database
  let oceanNode: OceanNode
  let provider: JsonRpcProvider
  let consumerAccount: Signer // the payer
  let payerAddress: string
  let nodeAddress: string // the node signer == the escrow payee
  let paymentToken: string
  let escrowAddress: string
  let tokenContract: any
  let escrowContract: any

  let escrowOff: Escrow // ESCROW_EMPTY_TX off (default) — skips zero-value txs
  let escrowOn: Escrow // ESCROW_EMPTY_TX on — sends the real zero-value tx

  const chainId = DEVELOPMENT_CHAIN_ID
  const expiry = 7200
  const mockSupportedNetworks: RPCS = getMockSupportedNetworks()
  let previousConfiguration: OverrideEnvConfig[]

  // unique job per case so a leftover on-chain lock from a prior run can never collide
  const uniqueJob = (tag: string) => `empty-tx-${tag}-${Date.now()}`
  // mined-tx count: a skipped (sentinel) lock/claim must leave this unchanged
  const nodeNonce = () => provider.getTransactionCount(nodeAddress, 'latest')
  const lockExistsFor = async (job: string): Promise<boolean> => {
    const locks = await escrowOff.getLocks(
      chainId,
      paymentToken,
      payerAddress,
      nodeAddress
    )
    // getLocks returns null when the on-chain lookup itself fails. Treat that as a hard error, not
    // as "no locks": otherwise a failed lookup would silently satisfy a "no lock exists" assertion.
    // A successful lookup with no matching lock is a real empty array and still returns false.
    assert(
      locks !== null && locks !== undefined,
      'getLocks lookup failed (returned null)'
    )
    const jobIdHash = create256Hash(job)
    return locks.some((l: any) => BigInt(l.jobId.toString()) === BigInt(jobIdHash))
  }
  const hasEscrow = () => !!(escrowAddress && paymentToken)

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
          `${homedir()}/.ocean/ocean-contracts/artifacts/address.json`
        ]
      )
    )

    const config = await getConfiguration(true)
    database = await Database.init(config.dbConfig)
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
    if (!artifactsAddresses) artifactsAddresses = getOceanArtifactsAdresses().development
    escrowAddress = artifactsAddresses?.Escrow
    paymentToken = artifactsAddresses?.Ocean

    provider = new JsonRpcProvider('http://127.0.0.1:8545')
    // signer 0 is the OceanToken deployer/minter; only it can mint. signer 1 is the payer.
    const publisherAccount = (await provider.getSigner(0)) as Signer
    consumerAccount = (await provider.getSigner(1)) as Signer
    payerAddress = await consumerAccount.getAddress()

    const blockchain = oceanNode.blockchainRegistry.getBlockchain(chainId)
    nodeAddress = await (await blockchain.getSigner()).getAddress()

    // Two wrappers sharing the same signer/registry, differing only in the toggle.
    escrowOff = new Escrow(
      config.supportedNetworks,
      3600,
      oceanNode.blockchainRegistry,
      null,
      false
    )
    escrowOn = new Escrow(
      config.supportedNetworks,
      3600,
      oceanNode.blockchainRegistry,
      null,
      true
    )

    if (escrowAddress && paymentToken) {
      // token contract bound to the minter (signer 0) so mint() succeeds; escrow calls
      // (approve/deposit/authorize) are made by the payer (signer 1).
      tokenContract = new ethers.Contract(paymentToken, OceanToken.abi, publisherAccount)
      escrowContract = new ethers.Contract(escrowAddress, EscrowJson.abi, consumerAccount)
      // Fund the payer and authorize the node (payee) generously, so a real (non-zero, or
      // flag-on) lock can clear the escrow funds + authorization pre-checks that the skip path
      // bypasses. maxLockSeconds > the lock duration so the duration guard always passes.
      const amount = parseUnits('100', 18)
      let bal = await tokenContract.balanceOf(payerAddress)
      if (BigInt(bal.toString()) < amount) {
        await (await tokenContract.mint(payerAddress, amount)).wait()
      }
      await (
        await tokenContract.connect(consumerAccount).approve(escrowAddress, amount)
      ).wait()
      await (await escrowContract.deposit(paymentToken, amount)).wait()
      await (
        await escrowContract.authorize(
          paymentToken,
          nodeAddress,
          amount,
          expiry * 2,
          10,
          0
        )
      ).wait()
    }
  })

  after(async () => {
    await oceanNode.tearDownAll()
    await tearDownEnvironment(previousConfiguration)
  })

  it('off (default): createLock with amount 0 returns the sentinel and sends no tx', async function () {
    if (!hasEscrow()) this.skip()
    this.timeout(DEFAULT_TEST_TIMEOUT * 3)
    const job = uniqueJob('off-lock')
    const before = await nodeNonce()
    const lockTx = await escrowOff.createLock(
      chainId,
      job,
      paymentToken,
      payerAddress,
      0,
      expiry,
      JobType.COMPUTE
    )
    expect(lockTx).to.equal(ZERO_PAYMENT_TX)
    expect(await nodeNonce(), 'no on-chain tx → node nonce unchanged').to.equal(before)
    expect(await lockExistsFor(job), 'no on-chain lock for a skipped lock').to.equal(
      false
    )
  })

  it('off (default): claimLock mirrors a sentinel lock — returns the sentinel, sends no tx', async function () {
    if (!hasEscrow()) this.skip()
    this.timeout(DEFAULT_TEST_TIMEOUT * 3)
    const before = await nodeNonce()
    const claimTx = await escrowOff.claimLock(
      chainId,
      uniqueJob('off-claim'),
      paymentToken,
      payerAddress,
      0,
      'proof',
      JobType.COMPUTE,
      null,
      ZERO_PAYMENT_TX // the lock was skipped → so is the claim
    )
    expect(claimTx).to.equal(ZERO_PAYMENT_TX)
    expect(await nodeNonce(), 'no on-chain tx → node nonce unchanged').to.equal(before)
  })

  it('off (default): a non-zero amount still sends a real lock + claim tx (skip is specific to 0)', async function () {
    if (!hasEscrow()) this.skip()
    this.timeout(DEFAULT_TEST_TIMEOUT * 3)
    const job = uniqueJob('off-nonzero')
    const before = await nodeNonce()
    const lockTx = await escrowOff.createLock(
      chainId,
      job,
      paymentToken,
      payerAddress,
      1,
      expiry,
      JobType.COMPUTE
    )
    expect(lockTx).to.not.equal(ZERO_PAYMENT_TX)
    expect(lockTx).to.match(/^0x[0-9a-fA-F]{64}$/)
    await escrowOff.waitForTransaction(chainId, lockTx)
    expect(await nodeNonce(), 'a real lock advances the node nonce').to.equal(before + 1)
    expect(await lockExistsFor(job), 'a real on-chain lock exists').to.equal(true)

    // a real lockTx is NOT the sentinel, so the claim takes the real on-chain path
    const claimTx = await escrowOff.claimLock(
      chainId,
      job,
      paymentToken,
      payerAddress,
      1,
      'proof',
      JobType.COMPUTE,
      null,
      lockTx
    )
    expect(claimTx).to.not.equal(ZERO_PAYMENT_TX)
    expect(claimTx).to.match(/^0x[0-9a-fA-F]{64}$/)
  })

  it('on: a zero-amount lock does NOT short-circuit — it reaches the real on-chain path', async function () {
    if (!hasEscrow()) this.skip()
    this.timeout(DEFAULT_TEST_TIMEOUT * 3)

    // Step 1 — prove escrowOn's full plumbing works end-to-end with a NON-zero amount: the token
    // decimals lookup, the payer funds / authorization pre-checks, gas estimation, submission and
    // mining. This is what lets Step 2 attribute a zero-amount failure to the chain rejecting
    // wei==0 and NOT to any unrelated error (a decimals lookup failure, insufficient funds, missing
    // auth): the very same wrapper + payer just cleared all of those. It also warms escrowOn's
    // decimals cache, so Step 2's getPaymentAmountInWei makes no further chain call for decimals.
    const warmJob = uniqueJob('on-nonzero')
    const warmLock = await escrowOn.createLock(
      chainId,
      warmJob,
      paymentToken,
      payerAddress,
      1,
      expiry,
      JobType.COMPUTE
    )
    expect(warmLock, 'flag-on non-zero lock sends a real tx').to.match(
      /^0x[0-9a-fA-F]{64}$/
    )
    await escrowOn.waitForTransaction(chainId, warmLock)
    const warmReceipt = await provider.getTransactionReceipt(warmLock)
    assert(warmReceipt && warmReceipt.status === 1, 'non-zero lock tx must be mined OK')
    assert(await lockExistsFor(warmJob), 'the non-zero lock must exist on-chain')

    // Step 2 — the zero-amount case. With the flag ON the skip branch is bypassed, so wei==0 is
    // carried into the real escrow path instead of short-circuiting to the sentinel. The sentinel
    // is createLock's ONLY early return, so any non-sentinel outcome already proves no short-circuit.
    // We then pin down which real-path outcome occurred with on-chain, JOB-SCOPED evidence — a mined
    // receipt, or the absence of a lock for this unique jobId — NOT by matching an error message
    // (the contract's zero-value revert carries no reason string) and NOT by the shared signer's
    // nonce (racy: other tests reuse the node signer and don't all await their txs).
    const job = uniqueJob('on-zero')
    let result: string | null = null
    let threw = false
    try {
      result = await escrowOn.createLock(
        chainId,
        job,
        paymentToken,
        payerAddress,
        0,
        expiry,
        JobType.COMPUTE
      )
    } catch {
      threw = true
    }
    // Whatever happened, it must NOT be the short-circuit sentinel.
    expect(
      result,
      'flag-on zero lock must not short-circuit to the sentinel'
    ).to.not.equal(ZERO_PAYMENT_TX)
    if (threw) {
      // The contract rejected wei==0 during gas estimation (a bare revert): the real path was
      // taken. createLock returns a hash only AFTER a successful submit, so no hash was produced
      // and — Step 1 having proven the plumbing — this throw cannot be an unrelated decimals/funds/
      // auth failure. Confirm no lock was created on-chain for this jobId.
      expect(result, 'a reverted lock yields no tx hash').to.equal(null)
      expect(
        await lockExistsFor(job),
        'a rejected zero lock creates no on-chain lock'
      ).to.equal(false)
    } else {
      // Some Escrow deployments accept a zero-value lock: a real, mined tx that creates the lock.
      expect(result).to.match(/^0x[0-9a-fA-F]{64}$/)
      await escrowOn.waitForTransaction(chainId, result as string)
      const receipt = await provider.getTransactionReceipt(result as string)
      assert(receipt && receipt.status === 1, 'a submitted zero lock must be mined OK')
      expect(
        await lockExistsFor(job),
        'a submitted zero lock creates an on-chain lock'
      ).to.equal(true)
    }
  })
})
