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
    return { claimLockAndWithdraw, claimLocksAndWithdraw }
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
})
