import { expect } from 'chai'
import sinon from 'sinon'
import { C2DEngineDocker } from '../../../components/c2d/compute_engine_docker.js'
import { C2DStatusNumber } from '../../../@types/C2D/C2D.js'

const HASH = 'cluster-1'
const LIVE = `${HASH}-0xlive`

// Keep the prototype, skip the Docker constructor (same as serviceRestartRace.test.ts).
function makeEngine(): any {
  const engine: any = Object.create(C2DEngineDocker.prototype)
  engine.clusterConfig = { hash: HASH, connection: { resources: [] } }
  engine.envs = [{ id: LIVE, resources: [], enableNetwork: true }]
  engine.db = {
    updateJob: sinon.stub().resolves(1),
    getRunningJobs: sinon.stub().resolves([]),
    getPendingServiceStarts: sinon.stub().resolves([]),
    getExpiredServiceJobs: sinon.stub().resolves([])
  }
  engine.recordJobFinished = sinon.stub()
  engine.cleanupJob = sinon.stub().resolves(undefined)
  engine.activeBuildAborts = new Map()
  engine.stopped = false
  engine.isInternalLoopRunning = false
  engine.cronTimer = null
  engine.setNewTimer = sinon.stub()
  engine.checkRunningServices = sinon.stub().resolves([])
  engine.logMetricsSummary = sinon.stub()
  engine.refreshHostGpuSnapshot = sinon.stub().resolves(undefined)
  return engine
}

const makeJob = (environment: string): any => ({
  jobId: 'job-1',
  environment,
  status: C2DStatusNumber.ConfiguringVolumes,
  statusText: 'Configuring volumes',
  isRunning: true,
  dateCreated: String(Date.now() / 1000),
  resources: []
})

describe('C2D job whose environment was renamed away', () => {
  it('fails the job instead of throwing on the undefined env', async () => {
    const engine = makeEngine()
    const job = makeJob(`${HASH}-0xgone`)

    await engine.processJob(job)

    expect(job.isRunning).to.equal(false)
    expect(job.statusText).to.contain('no longer exists')
    expect(engine.cleanupJob.calledOnce).to.equal(true)
  })

  it('finishes the tick even when a job throws', async () => {
    const engine = makeEngine()
    engine.db.getRunningJobs.resolves([makeJob(LIVE)])
    sinon.stub(engine, 'processJob').rejects(new Error('boom'))

    await engine.InternalLoop()

    expect(engine.db.getExpiredServiceJobs.calledOnce).to.equal(true)
  })
})
