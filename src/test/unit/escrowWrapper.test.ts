import { expect } from 'chai'
import sinon from 'sinon'
import { ethers } from 'ethers'
import { Escrow } from '../../components/core/utils/escrow.js'
import { create256Hash } from '../../utils/crypt.js'
import { JobType } from '../../utils/constants.js'

// Direct unit test of the Escrow claim wrappers. The escrow contract, the blockchain and the
// amount/lock lookups are all stubbed, so this only exercises how the wrapper forwards the new
// jobType + subsidyProviders arguments to the contract's claim functions.
describe('Escrow claim wrappers forward jobType + subsidyProviders', () => {
  const CHAIN = 8996
  const TOKEN = '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238'
  const PAYER = '0x0000000000000000000000000000000000000aBc'
  const PROVIDER = '0x1111111111111111111111111111111111111111'
  const WEI = '1000'

  function buildFakeContract() {
    const claimLockAndWithdraw: any = sinon.stub().resolves({ hash: '0xclaim' })
    claimLockAndWithdraw.estimateGas = sinon.stub().resolves(21000n)
    const claimLocksAndWithdraw: any = sinon.stub().resolves({ hash: '0xclaims' })
    claimLocksAndWithdraw.estimateGas = sinon.stub().resolves(21000n)
    const createLock: any = sinon.stub().resolves({ hash: '0xlock' })
    createLock.estimateGas = sinon.stub().resolves(21000n)
    return { claimLockAndWithdraw, claimLocksAndWithdraw, createLock }
  }

  // A single authorization permissive enough that createLock's pre-send checks all pass.
  function okAuth() {
    return {
      maxLockedAmount: 10n ** 18n,
      currentLockedAmount: 0n,
      maxLockSeconds: 10n ** 9n,
      maxLockCounts: 10n,
      currentLocks: 0n
    }
  }

  // Stub the createLock pre-send reads (funds + auth) so the tx branch is reached.
  function stubCreateLockPrechecks(escrow: Escrow) {
    sinon.stub(escrow, 'getUserAvailableFunds').resolves((10n ** 18n) as any)
    sinon.stub(escrow, 'getAuthorizations').resolves([okAuth() as any])
  }

  // Wire up an Escrow instance whose blockchain/contract/amount/lock internals are all stubbed.
  function buildEscrow(subsidyProviders: any) {
    const escrow = new Escrow({} as any, 3600, {} as any, subsidyProviders)
    const contract = buildFakeContract()
    const fakeBlockchain = {
      getSigner: sinon.stub().resolves({ getAddress: sinon.stub().resolves('0xnode') }),
      getGasOptions: sinon.stub().resolves({ gasLimit: 21000n })
    }
    sinon.stub(escrow as any, 'getBlockchain').returns(fakeBlockchain)
    sinon.stub(escrow, 'getContract').returns(contract as any)
    sinon.stub(escrow, 'getPaymentAmountInWei').resolves(WEI)
    return { escrow, contract }
  }

  afterEach(() => sinon.restore())

  it('claimLock passes jobType + the chain provider list after the proof, before gas options', async () => {
    const { escrow, contract } = buildEscrow({ [String(CHAIN)]: [PROVIDER] })
    const jobId = create256Hash('job-1')
    // getLocks must return a lock whose jobId matches so the claim branch runs
    sinon.stub(escrow, 'getLocks').resolves([{ jobId: BigInt(jobId) } as any])

    const hash = await escrow.claimLock(
      CHAIN,
      'job-1',
      TOKEN,
      PAYER,
      1,
      'proof-1',
      JobType.COMPUTE
    )
    expect(hash).to.equal('0xclaim')

    // estimateGas: (jobId, token, payer, wei, proofBytes, jobType, subsidyProviders)
    const estArgs = contract.claimLockAndWithdraw.estimateGas.firstCall.args
    expect(estArgs).to.have.length(7)
    expect(estArgs[5]).to.equal(JobType.COMPUTE)
    expect(estArgs[6]).to.deep.equal([PROVIDER])

    // the call itself appends gasOptions last
    const callArgs = contract.claimLockAndWithdraw.firstCall.args
    expect(callArgs).to.have.length(8)
    expect(callArgs[0]).to.equal(jobId)
    expect(callArgs[1]).to.equal(TOKEN)
    expect(callArgs[2]).to.equal(PAYER)
    expect(callArgs[3]).to.equal(WEI)
    expect(ethers.toUtf8String(callArgs[4])).to.equal('proof-1')
    expect(callArgs[5]).to.equal(JobType.COMPUTE)
    expect(callArgs[6]).to.deep.equal([PROVIDER])
  })

  it('claimLock passes an empty provider list but still the jobType when no config is set', async () => {
    const { escrow, contract } = buildEscrow(null)
    const jobId = create256Hash('job-2')
    sinon.stub(escrow, 'getLocks').resolves([{ jobId: BigInt(jobId) } as any])

    await escrow.claimLock(CHAIN, 'job-2', TOKEN, PAYER, 1, 'proof-2', JobType.SERVICE)

    const callArgs = contract.claimLockAndWithdraw.firstCall.args
    expect(callArgs[5]).to.equal(JobType.SERVICE)
    expect(callArgs[6]).to.deep.equal([])
  })

  it('claimLocks builds parallel jobType[] and subsidyProviders[][] of matching length', async () => {
    const { escrow, contract } = buildEscrow({ [String(CHAIN)]: [PROVIDER] })

    const jobs = ['job-a', 'job-b']
    const tokens = [TOKEN, TOKEN]
    const payers = [PAYER, PAYER]
    const amounts = [1, 2]
    const proofs = ['pa', 'pb']

    const hash = await escrow.claimLocks(
      CHAIN,
      jobs,
      tokens,
      payers,
      amounts,
      proofs,
      JobType.COMPUTE
    )
    expect(hash).to.equal('0xclaims')

    // estimateGas: (jobIds, tokens, payers, weis, proofs, jobTypes, subsidyProviders)
    const estArgs = contract.claimLocksAndWithdraw.estimateGas.firstCall.args
    expect(estArgs).to.have.length(7)
    expect(estArgs[5]).to.deep.equal([JobType.COMPUTE, JobType.COMPUTE])
    expect(estArgs[6]).to.deep.equal([[PROVIDER], [PROVIDER]])

    const callArgs = contract.claimLocksAndWithdraw.firstCall.args
    expect(callArgs).to.have.length(8)
    // parallel arrays are the same length as the jobs list
    expect(callArgs[5]).to.have.length(jobs.length)
    expect(callArgs[6]).to.have.length(jobs.length)
    expect(callArgs[5]).to.deep.equal([JobType.COMPUTE, JobType.COMPUTE])
    expect(callArgs[6]).to.deep.equal([[PROVIDER], [PROVIDER]])
  })

  it('claimLocks repeats an empty provider list per job when no config is set', async () => {
    const { escrow, contract } = buildEscrow(null)

    await escrow.claimLocks(
      CHAIN,
      ['job-a', 'job-b'],
      [TOKEN, TOKEN],
      [PAYER, PAYER],
      [1, 2],
      ['pa', 'pb'],
      JobType.COMPUTE
    )

    const callArgs = contract.claimLocksAndWithdraw.firstCall.args
    expect(callArgs[5]).to.deep.equal([JobType.COMPUTE, JobType.COMPUTE])
    expect(callArgs[6]).to.deep.equal([[], []])
  })

  const USER_PROVIDER = '0x2222222222222222222222222222222222222222'

  it('claimLock: a user override replaces the node config list', async () => {
    const { escrow, contract } = buildEscrow({ [String(CHAIN)]: [PROVIDER] })
    const jobId = create256Hash('job-ov')
    sinon.stub(escrow, 'getLocks').resolves([{ jobId: BigInt(jobId) } as any])

    await escrow.claimLock(CHAIN, 'job-ov', TOKEN, PAYER, 1, 'p', JobType.COMPUTE, [
      USER_PROVIDER
    ])

    const callArgs = contract.claimLockAndWithdraw.firstCall.args
    expect(callArgs[6]).to.deep.equal([USER_PROVIDER])
  })

  it('claimLock: a user override of [] means no providers, not fallback to config', async () => {
    const { escrow, contract } = buildEscrow({ [String(CHAIN)]: [PROVIDER] })
    const jobId = create256Hash('job-empty')
    sinon.stub(escrow, 'getLocks').resolves([{ jobId: BigInt(jobId) } as any])

    await escrow.claimLock(CHAIN, 'job-empty', TOKEN, PAYER, 1, 'p', JobType.COMPUTE, [])

    const callArgs = contract.claimLockAndWithdraw.firstCall.args
    expect(callArgs[6]).to.deep.equal([])
  })

  it('claimLock: a null override falls back to the node config list', async () => {
    const { escrow, contract } = buildEscrow({ [String(CHAIN)]: [PROVIDER] })
    const jobId = create256Hash('job-null')
    sinon.stub(escrow, 'getLocks').resolves([{ jobId: BigInt(jobId) } as any])

    await escrow.claimLock(CHAIN, 'job-null', TOKEN, PAYER, 1, 'p', JobType.COMPUTE, null)

    const callArgs = contract.claimLockAndWithdraw.firstCall.args
    expect(callArgs[6]).to.deep.equal([PROVIDER])
  })

  it('claimLocks: per-job overrides win, and a null slot falls back to config', async () => {
    const { escrow, contract } = buildEscrow({ [String(CHAIN)]: [PROVIDER] })

    await escrow.claimLocks(
      CHAIN,
      ['job-a', 'job-b', 'job-c'],
      [TOKEN, TOKEN, TOKEN],
      [PAYER, PAYER, PAYER],
      [1, 2, 3],
      ['pa', 'pb', 'pc'],
      JobType.COMPUTE,
      [[USER_PROVIDER], [], null]
    )

    const callArgs = contract.claimLocksAndWithdraw.firstCall.args
    // job-a: user override; job-b: explicit none; job-c: null → node config
    expect(callArgs[6]).to.deep.equal([[USER_PROVIDER], [], [PROVIDER]])
  })

  // Escrow v2: createLock forwards the SAME jobType + subsidyProviders the claim path uses, so a
  // sponsored lock can be settled from the same providers. Resolution mirrors claimLock exactly.
  it('createLock passes jobType + the chain provider list before gas options', async () => {
    const { escrow, contract } = buildEscrow({ [String(CHAIN)]: [PROVIDER] })
    stubCreateLockPrechecks(escrow)
    const jobId = create256Hash('lock-1')

    const hash = await escrow.createLock(
      CHAIN,
      'lock-1',
      TOKEN,
      PAYER,
      1,
      3600,
      JobType.COMPUTE
    )
    expect(hash).to.equal('0xlock')

    // estimateGas: (jobId, token, payer, wei, expiry, jobType, subsidyProviders)
    const estArgs = contract.createLock.estimateGas.firstCall.args
    expect(estArgs).to.have.length(7)
    expect(estArgs[5]).to.equal(JobType.COMPUTE)
    expect(estArgs[6]).to.deep.equal([PROVIDER])

    // the call itself appends gasOptions last
    const callArgs = contract.createLock.firstCall.args
    expect(callArgs).to.have.length(8)
    expect(callArgs[0]).to.equal(jobId)
    expect(callArgs[1]).to.equal(TOKEN)
    expect(callArgs[2]).to.equal(PAYER)
    expect(callArgs[3]).to.equal(WEI)
    expect(callArgs[4]).to.equal(3600)
    expect(callArgs[5]).to.equal(JobType.COMPUTE)
    expect(callArgs[6]).to.deep.equal([PROVIDER])
  })

  it('createLock passes an empty provider list but still the jobType when no config is set', async () => {
    const { escrow, contract } = buildEscrow(null)
    stubCreateLockPrechecks(escrow)

    await escrow.createLock(CHAIN, 'lock-2', TOKEN, PAYER, 1, 3600, JobType.SERVICE)

    const callArgs = contract.createLock.firstCall.args
    expect(callArgs[5]).to.equal(JobType.SERVICE)
    expect(callArgs[6]).to.deep.equal([])
  })

  it('createLock: a user override replaces the node config list', async () => {
    const { escrow, contract } = buildEscrow({ [String(CHAIN)]: [PROVIDER] })
    stubCreateLockPrechecks(escrow)

    await escrow.createLock(CHAIN, 'lock-ov', TOKEN, PAYER, 1, 3600, JobType.COMPUTE, [
      USER_PROVIDER
    ])

    const callArgs = contract.createLock.firstCall.args
    expect(callArgs[6]).to.deep.equal([USER_PROVIDER])
  })

  it('createLock: a user override of [] means no providers, not fallback to config', async () => {
    const { escrow, contract } = buildEscrow({ [String(CHAIN)]: [PROVIDER] })
    stubCreateLockPrechecks(escrow)

    await escrow.createLock(
      CHAIN,
      'lock-empty',
      TOKEN,
      PAYER,
      1,
      3600,
      JobType.COMPUTE,
      []
    )

    const callArgs = contract.createLock.firstCall.args
    expect(callArgs[6]).to.deep.equal([])
  })

  it('createLock: a null override falls back to the node config list', async () => {
    const { escrow, contract } = buildEscrow({ [String(CHAIN)]: [PROVIDER] })
    stubCreateLockPrechecks(escrow)

    await escrow.createLock(
      CHAIN,
      'lock-null',
      TOKEN,
      PAYER,
      1,
      3600,
      JobType.COMPUTE,
      null
    )

    const callArgs = contract.createLock.firstCall.args
    expect(callArgs[6]).to.deep.equal([PROVIDER])
  })

  // Escrow v2 stopgap: a sponsored lock skips the payer-funded pre-checks (available funds +
  // maxLockedAmount cap) and lets the contract settle — so zero available funds and a
  // `maxLockedAmount == 0` "sponsored-only" auth must NOT fail fast node-side.
  it('createLock: a sponsored lock bypasses the funds + maxLockedAmount guards', async () => {
    const { escrow, contract } = buildEscrow({ [String(CHAIN)]: [PROVIDER] })
    // payer has nothing available and a sponsored-only auth (maxLockedAmount == 0)
    sinon.stub(escrow, 'getUserAvailableFunds').resolves(0n as any)
    sinon.stub(escrow, 'getAuthorizations').resolves([
      {
        maxLockedAmount: 0n,
        currentLockedAmount: 0n,
        maxLockSeconds: 10n ** 9n,
        maxLockCounts: 10n,
        currentLocks: 0n
      } as any
    ])

    // no override → resolves to the node config list → sponsored
    const hash = await escrow.createLock(
      CHAIN,
      'lock-spon',
      TOKEN,
      PAYER,
      1,
      3600,
      JobType.COMPUTE
    )
    expect(hash).to.equal('0xlock')
    expect(contract.createLock.firstCall.args[6]).to.deep.equal([PROVIDER])
  })

  it('createLock: a plain payer-funded lock still enforces the funds guard', async () => {
    const { escrow, contract } = buildEscrow(null) // no providers → not sponsored
    sinon.stub(escrow, 'getUserAvailableFunds').resolves(0n as any) // < wei (1000)

    let err: any
    try {
      await escrow.createLock(CHAIN, 'lock-poor', TOKEN, PAYER, 1, 3600, JobType.COMPUTE)
    } catch (e) {
      err = e
    }
    expect(err, 'should reject when the payer lacks funds').to.be.an('error')
    expect(err.message).to.contain('does not have enough funds')
    expect(contract.createLock.called).to.equal(false)
  })

  // Escrow v2 auth expiry: the node checks the auth's expiryTimestamp before locking and fails
  // fast, instead of sending a tx the contract reverts with "Auth expired".
  function authWithExpiry(expiryTimestamp: bigint) {
    return { ...okAuth(), expiryTimestamp }
  }
  const nowSec = () => Math.floor(Date.now() / 1000)

  it('createLock: rejects when the authorization has already expired', async () => {
    const { escrow, contract } = buildEscrow(null)
    sinon.stub(escrow, 'getUserAvailableFunds').resolves((10n ** 18n) as any)
    sinon
      .stub(escrow, 'getAuthorizations')
      .resolves([authWithExpiry(BigInt(nowSec() - 100)) as any])

    let err: any
    try {
      await escrow.createLock(CHAIN, 'lock-exp', TOKEN, PAYER, 1, 3600, JobType.COMPUTE)
    } catch (e) {
      err = e
    }
    expect(err).to.be.an('error')
    expect(err.message).to.contain('authorization expired')
    expect(contract.createLock.called).to.equal(false)
  })

  it('createLock: rejects when the lock would outlive the authorization expiry', async () => {
    const { escrow, contract } = buildEscrow(null)
    sinon.stub(escrow, 'getUserAvailableFunds').resolves((10n ** 18n) as any)
    // auth lapses in 100s but the lock lasts 3600s → lock would outlive the auth
    sinon
      .stub(escrow, 'getAuthorizations')
      .resolves([authWithExpiry(BigInt(nowSec() + 100)) as any])

    let err: any
    try {
      await escrow.createLock(
        CHAIN,
        'lock-outlive',
        TOKEN,
        PAYER,
        1,
        3600,
        JobType.COMPUTE
      )
    } catch (e) {
      err = e
    }
    expect(err).to.be.an('error')
    expect(err.message).to.contain('outlive')
    expect(contract.createLock.called).to.equal(false)
  })

  it('createLock: a far-future auth expiry (and expiry 0) still lock', async () => {
    // far-future expiryTimestamp: lock proceeds
    const far = buildEscrow(null)
    sinon.stub(far.escrow, 'getUserAvailableFunds').resolves((10n ** 18n) as any)
    sinon
      .stub(far.escrow, 'getAuthorizations')
      .resolves([authWithExpiry(BigInt(nowSec() + 10 ** 9)) as any])
    expect(
      await far.escrow.createLock(
        CHAIN,
        'lock-far',
        TOKEN,
        PAYER,
        1,
        3600,
        JobType.COMPUTE
      )
    ).to.equal('0xlock')

    // expiryTimestamp == 0 (indefinite) is a no-op → lock proceeds
    const zero = buildEscrow(null)
    sinon.stub(zero.escrow, 'getUserAvailableFunds').resolves((10n ** 18n) as any)
    sinon.stub(zero.escrow, 'getAuthorizations').resolves([authWithExpiry(0n) as any])
    expect(
      await zero.escrow.createLock(
        CHAIN,
        'lock-zero',
        TOKEN,
        PAYER,
        1,
        3600,
        JobType.COMPUTE
      )
    ).to.equal('0xlock')
  })

  // Boundary: the guard mirrors the contract's `block.timestamp + duration <= expiry`, so a lock
  // ending EXACTLY at expiry is allowed, and one second past it is rejected. Time is frozen so the
  // boundary is deterministic (createLock reads Date.now()).
  it('createLock: a lock ending exactly at the auth expiry is allowed', async () => {
    const nowMs = 1_700_000_000_000
    sinon.useFakeTimers(nowMs)
    const duration = 3600
    const expiryTs = BigInt(Math.floor(nowMs / 1000) + duration) // lock end == expiry
    const { escrow } = buildEscrow(null)
    sinon.stub(escrow, 'getUserAvailableFunds').resolves((10n ** 18n) as any)
    sinon.stub(escrow, 'getAuthorizations').resolves([authWithExpiry(expiryTs) as any])

    expect(
      await escrow.createLock(
        CHAIN,
        'lock-at-expiry',
        TOKEN,
        PAYER,
        1,
        duration,
        JobType.COMPUTE
      )
    ).to.equal('0xlock')
  })

  it('createLock: a lock ending one second past the auth expiry is rejected', async () => {
    const nowMs = 1_700_000_000_000
    sinon.useFakeTimers(nowMs)
    const duration = 3600
    const expiryTs = BigInt(Math.floor(nowMs / 1000) + duration - 1) // lock end > expiry by 1s
    const { escrow, contract } = buildEscrow(null)
    sinon.stub(escrow, 'getUserAvailableFunds').resolves((10n ** 18n) as any)
    sinon.stub(escrow, 'getAuthorizations').resolves([authWithExpiry(expiryTs) as any])

    let err: any
    try {
      await escrow.createLock(
        CHAIN,
        'lock-past-expiry',
        TOKEN,
        PAYER,
        1,
        duration,
        JobType.COMPUTE
      )
    } catch (e) {
      err = e
    }
    expect(err).to.be.an('error')
    expect(err.message).to.contain('outlive')
    expect(contract.createLock.called).to.equal(false)
  })

  // Expiry is enforced regardless of sponsorship (the contract gates createLock on expiry for
  // sponsored and payer-funded locks alike).
  it('createLock: an expired auth rejects even for a sponsored lock', async () => {
    const { escrow, contract } = buildEscrow({ [String(CHAIN)]: [PROVIDER] })
    sinon.stub(escrow, 'getUserAvailableFunds').resolves(0n as any)
    sinon
      .stub(escrow, 'getAuthorizations')
      .resolves([authWithExpiry(BigInt(nowSec() - 100)) as any])

    let err: any
    try {
      await escrow.createLock(
        CHAIN,
        'lock-spon-exp',
        TOKEN,
        PAYER,
        1,
        3600,
        JobType.COMPUTE
      )
    } catch (e) {
      err = e
    }
    expect(err).to.be.an('error')
    expect(err.message).to.contain('authorization expired')
    expect(contract.createLock.called).to.equal(false)
  })

  // Stopgap S=0: a node with a global provider list skips the funds guard even when the payer has
  // nothing and the providers end up covering 0. The node must NOT fast-fail — it reaches the
  // contract, which reverts, and the wrapper surfaces that revert. (When the TODO to quote S is
  // implemented, this flips to expecting a node-side fast-fail.)
  it('createLock: sponsored but underfunded payer surfaces the contract revert (stopgap S=0)', async () => {
    const { escrow, contract } = buildEscrow({ [String(CHAIN)]: [PROVIDER] })
    sinon.stub(escrow, 'getUserAvailableFunds').resolves(0n as any)
    sinon.stub(escrow, 'getAuthorizations').resolves([okAuth() as any])
    contract.createLock.estimateGas.rejects(new Error('Payer does not have enough funds'))

    let err: any
    try {
      await escrow.createLock(CHAIN, 'lock-s0', TOKEN, PAYER, 1, 3600, JobType.COMPUTE)
    } catch (e) {
      err = e
    }
    expect(err).to.be.an('error')
    expect(err.message).to.contain('Payer does not have enough funds')
    // proves the node did NOT fast-fail on the skipped funds guard: it reached the contract
    expect(contract.createLock.estimateGas.called).to.equal(true)
  })

  // Pre-v2 safety: an auth tuple without an `expiryTimestamp` field (old ABI) is a no-op for the
  // expiry gate and must still lock.
  it('createLock: an auth with no expiryTimestamp (pre-v2) still locks', async () => {
    const { escrow } = buildEscrow(null)
    sinon.stub(escrow, 'getUserAvailableFunds').resolves((10n ** 18n) as any)
    sinon.stub(escrow, 'getAuthorizations').resolves([okAuth() as any]) // no expiryTimestamp
    expect(
      await escrow.createLock(CHAIN, 'lock-prev2', TOKEN, PAYER, 1, 3600, JobType.COMPUTE)
    ).to.equal('0xlock')
  })
})
