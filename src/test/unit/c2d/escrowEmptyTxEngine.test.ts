import { expect } from 'chai'
import sinon from 'sinon'
import { C2DEngineDocker } from '../../../components/c2d/compute_engine_docker.js'
import { C2DStatusNumber } from '../../../@types/C2D/C2D.js'

// Exercises the ESCROW_EMPTY_TX (0xempty sentinel) handling inside the C2D docker engine:
// - safeCancelLock never tries to cancel a lock that was never created (sentinel lockTx)
// - the claimPayments "jobs without lock" finalizer records 0xempty for a skipped (sentinel)
//   lock, but keeps the "nolock" marker for a genuinely orphaned job whose real lock is gone.
// Uses the same Object.create(prototype) harness as the other service/c2d unit tests so the
// private methods can be driven with stubbed db / escrow.

function makeEngine(): any {
  const engine: any = Object.create(C2DEngineDocker.prototype)
  engine.db = {
    getJobsByStatus: sinon.stub().resolves([]),
    updateJob: sinon.stub().resolves(1)
  }
  engine.escrow = {
    getLocks: sinon.stub().resolves([]),
    cancelExpiredLock: sinon.stub().resolves('0xcancel')
  }
  engine.envs = [{ id: 'env-1', fees: { '8996': [] } }]
  engine.getKeyManager = () => ({ getEthAddress: () => '0xnode' })
  // isolate the finalizer: no cost recompute, no stray chain cleanup
  engine.getValidBuildDurationSeconds = () => 0
  engine.cleanUpUnknownLocks = sinon.stub().resolves()
  return engine
}

function makeComputeJob(overrides: Record<string, any> = {}): any {
  return {
    jobId: 'job-1',
    jobIdHash: '0xhash',
    owner: '0xowner',
    environment: 'env-1',
    isFree: false,
    maxJobDuration: 100,
    algoStartTimestamp: '0',
    algoStopTimestamp: '0',
    resources: [],
    payment: {
      chainId: 8996,
      token: '0xtoken',
      lockTx: '0xempty',
      claimTx: '',
      cancelTx: '',
      cost: 0
    },
    ...overrides
  }
}

describe('C2D engine — ESCROW_EMPTY_TX sentinel handling', () => {
  afterEach(() => sinon.restore())

  describe('safeCancelLock', () => {
    it('skips the on-chain cancel for a 0xempty lock and returns an empty string', async () => {
      const engine = makeEngine()
      const r = await engine.safeCancelLock(8996, 'svc', '0xtoken', '0xowner', '0xempty')
      expect(r).to.equal('')
      expect(engine.escrow.cancelExpiredLock.called).to.equal(false)
    })

    it('cancels a real lock and returns the cancel tx', async () => {
      const engine = makeEngine()
      const r = await engine.safeCancelLock(
        8996,
        'svc',
        '0xtoken',
        '0xowner',
        '0xrealhash'
      )
      expect(r).to.equal('0xcancel')
      expect(engine.escrow.cancelExpiredLock.calledOnce).to.equal(true)
    })

    it('still cancels when no lockTx is supplied (back-compat)', async () => {
      const engine = makeEngine()
      const r = await engine.safeCancelLock(8996, 'svc', '0xtoken', '0xowner')
      expect(r).to.equal('0xcancel')
      expect(engine.escrow.cancelExpiredLock.calledOnce).to.equal(true)
    })
  })

  describe('claimPayments jobsWithoutLock finalizer', () => {
    it('records 0xempty for a sentinel-lock job, nolock for a genuinely orphaned job', async () => {
      const engine = makeEngine()
      const sentinelJob = makeComputeJob({
        jobId: 'sentinel',
        payment: { chainId: 8996, token: '0xtoken', lockTx: '0xempty', cost: 0 }
      })
      const orphanJob = makeComputeJob({
        jobId: 'orphan',
        payment: { chainId: 8996, token: '0xtoken', lockTx: '0xrealhash', cost: 1 }
      })
      engine.db.getJobsByStatus.resolves([sentinelJob, orphanJob])
      // no on-chain locks found for either → both land in jobsWithoutLock
      engine.escrow.getLocks.resolves([])

      await engine.claimPayments()

      expect(sentinelJob.payment.claimTx).to.equal('0xempty')
      expect(sentinelJob.payment.cancelTx).to.equal('0xempty')
      expect(sentinelJob.status).to.equal(C2DStatusNumber.JobFinished)

      expect(orphanJob.payment.claimTx).to.equal('nolock')
      expect(orphanJob.payment.cancelTx).to.equal('nolock')
      expect(orphanJob.status).to.equal(C2DStatusNumber.JobFinished)

      // never claimed/cancelled on-chain for a sentinel lock
      expect(engine.escrow.cancelExpiredLock.called).to.equal(false)
    })

    it('does not throw for a free job with no payment', async () => {
      const engine = makeEngine()
      const freeJob = makeComputeJob({ jobId: 'free', isFree: true, payment: undefined })
      engine.db.getJobsByStatus.resolves([freeJob])

      await engine.claimPayments()

      expect(freeJob.status).to.equal(C2DStatusNumber.JobFinished)
      expect(engine.db.updateJob.calledWith(freeJob)).to.equal(true)
    })
  })
})
