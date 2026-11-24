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

  it('on: a zero-amount lock does NOT short-circuit — it goes on-chain', async function () {
    if (!hasEscrow()) this.skip()
    this.timeout(DEFAULT_TEST_TIMEOUT * 3)
    const job = uniqueJob('on-lock')
    const before = await nodeNonce()
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
    } catch (e) {
      // A zero-amount lock with the flag ON must reach the chain; the contract rejects wei==0
      // during gas estimation, and the Escrow wrapper rethrows that as a plain Error carrying the
      // ethers message (the CALL_EXCEPTION code is lost in the rethrow). Accept ONLY that on-chain
      // execution revert as proof it went on-chain. App-level pre-check failures (insufficient
      // funds, missing auth) and a token-decimals lookup error never touch the chain, so rethrow
      // them — otherwise they would masquerade as "went on-chain" and hide a regression.
      const msg = String((e as Error)?.message ?? e)
      if (
        !/estimateGas|execution reverted|CALL_EXCEPTION|missing revert data/i.test(msg)
      ) {
        throw e
      }
      threw = true
    }
    // In neither outcome did it short-circuit to the sentinel.
    expect(result).to.not.equal(ZERO_PAYMENT_TX)
    if (!threw && result) {
      expect(result).to.match(/^0x[0-9a-fA-F]{64}$/)
      await escrowOn.waitForTransaction(chainId, result)
      expect(await nodeNonce(), 'a real tx advances the node nonce').to.equal(before + 1)
    } else {
      assert(threw, 'flag-on zero lock must either send a tx or revert on-chain')
    }
  })
})
