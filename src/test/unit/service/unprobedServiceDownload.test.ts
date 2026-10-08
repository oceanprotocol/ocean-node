import { expect } from 'chai'
import sinon from 'sinon'
import { PassThrough, Readable } from 'stream'
import * as tarStream from 'tar-stream'
import { C2DEngineDocker } from '../../../components/c2d/compute_engine_docker.js'
import { ServiceStatusNumber } from '../../../@types/C2D/ServiceOnDemand.js'

// A vLLM-based app bundle: the engine image, but only the app's own port published, so the node
// has no engine to probe and reports the launch script's download manifest alone.
describe('download progress for a service the node cannot probe', () => {
  const CACHE = '/data/outputs/hf/hub/models--Qwen--Qwen3.8-27B-FP8'

  function engineWith(manifest: string | null, folderBytes: number | null) {
    const engine: any = Object.create(C2DEngineDocker.prototype)
    engine.serviceOpsInFlight = new Set()
    engine.manifestCheckedAt = new Map()
    engine.manifestDirSizes = new Map()
    engine.getArchive = sinon.stub().callsFake(() => {
      if (manifest === null) {
        return Promise.reject(new Error('no such file'))
      }
      const pack = tarStream.pack()
      pack.entry({ name: 'downloads.tsv' }, manifest)
      pack.finalize()
      return Promise.resolve(pack)
    })
    engine.docker = { getContainer: () => ({ getArchive: engine.getArchive }) }
    engine.getContainerDiskUsage = sinon.stub().resolves(folderBytes)
    engine.db = {
      isServiceLocked: sinon.stub().resolves(false),
      updateServiceJobReadiness: sinon.stub().resolves(true)
    }
    return engine
  }

  const job = (extra: object = {}) => ({
    serviceId: 'svc-1',
    owner: '0x0000000000000000000000000000000000000001',
    clusterHash: '0xcluster',
    containerId: 'container-1',
    image: 'vllm/vllm-openai',
    exposedPorts: [9119],
    status: ServiceStatusNumber.Running,
    ...extra
  })
  const startedAgo = (ms: number) => ({
    State: { StartedAt: new Date(Date.now() - ms).toISOString() }
  })

  it('records the manifest progress with no readiness', async () => {
    const engine = engineWith(`dir\t1000\t${CACHE}\n`, 400)
    await engine.probeServiceReadiness(job(), startedAgo(60_000))
    sinon.assert.calledOnce(engine.db.updateServiceJobReadiness)
    const [serviceId, expected, readiness, download] =
      engine.db.updateServiceJobReadiness.firstCall.args
    expect(serviceId).to.equal('svc-1')
    expect(expected.status).to.equal(ServiceStatusNumber.Running)
    expect(readiness).to.equal(undefined)
    expect(download).to.include({
      downloadedBytes: 400,
      totalBytes: 1000,
      percent: 40,
      filesTotal: 1
    })
    sinon.assert.calledWith(engine.getContainerDiskUsage, 'container-1', CACHE)
  })

  it('checks at most once per probe period', async () => {
    const engine = engineWith(`dir\t1000\t${CACHE}\n`, 400)
    await engine.probeServiceReadiness(job(), startedAgo(60_000))
    await engine.probeServiceReadiness(job(), startedAgo(60_000))
    sinon.assert.calledOnce(engine.getArchive)
  })

  it('stops once the listed download is complete', async () => {
    const engine = engineWith(`dir\t1000\t${CACHE}\n`, 1000)
    const complete = {
      downloadedBytes: 1000,
      totalBytes: 1000,
      percent: 100,
      filesComplete: 1,
      filesInFlight: 0,
      filesTotal: 1,
      updatedAt: Date.now()
    }
    await engine.probeServiceReadiness(
      job({ modelDownload: complete }),
      startedAgo(60_000)
    )
    sinon.assert.notCalled(engine.getArchive)
    sinon.assert.notCalled(engine.db.updateServiceJobReadiness)
  })

  it('stops looking once the discovery window has passed with no manifest', async () => {
    const engine = engineWith(null, null)
    await engine.probeServiceReadiness(job(), startedAgo(31 * 60 * 1000))
    sinon.assert.notCalled(engine.getArchive)
  })

  it('measures a manifest folder at most once per period, and again in a new container', async () => {
    const engine = engineWith(null, 400)
    await engine.manifestDirectoryBytes(job(), CACHE)
    await engine.manifestDirectoryBytes(job(), CACHE)
    sinon.assert.calledOnce(engine.getContainerDiskUsage)
    await engine.manifestDirectoryBytes(job({ containerId: 'container-2' }), CACHE)
    sinon.assert.calledTwice(engine.getContainerDiskUsage)
  })

  it('writes nothing for a service that has no manifest', async () => {
    const engine = engineWith(null, null)
    await engine.probeServiceReadiness(job(), startedAgo(60_000))
    sinon.assert.calledOnce(engine.getArchive)
    sinon.assert.notCalled(engine.db.updateServiceJobReadiness)
  })
})

describe('getContainerDiskUsage', () => {
  function engineWithOutput(output: string) {
    const engine: any = Object.create(C2DEngineDocker.prototype)
    const exec = { start: sinon.stub().resolves(Readable.from([Buffer.from(output)])) }
    engine.docker = {
      getContainer: () => ({
        inspect: sinon.stub().resolves({ State: { Running: true } }),
        exec: sinon.stub().resolves(exec)
      })
    }
    return engine
  }

  it('reads the size du prints for a long path', async () => {
    const path = '/data/outputs/hf/hub/models--Qwen--Qwen3.8-test'
    const engine = engineWithOutput(`5004096\t${path}\r\n`)
    expect(await engine.getContainerDiskUsage('container-1', path)).to.equal(5004096)
  })

  it('never reads an error message as a size', async () => {
    const engine = engineWithOutput(
      "du: cannot access '/data/models--org--model-2 1': No such file or directory\r\n"
    )
    expect(await engine.getContainerDiskUsage('container-1', '/data/x')).to.equal(null)
  })
})

describe('getContainerDiskUsage timeout', () => {
  let clock: sinon.SinonFakeTimers
  beforeEach(() => {
    clock = sinon.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  })
  afterEach(() => {
    clock.restore()
  })

  it('gives up on a du that never finishes, instead of hanging', async () => {
    const stream = new PassThrough()
    const engine: any = Object.create(C2DEngineDocker.prototype)
    engine.docker = {
      getContainer: () => ({
        inspect: sinon.stub().resolves({ State: { Running: true } }),
        exec: sinon.stub().resolves({ start: sinon.stub().resolves(stream) })
      })
    }
    const result = engine.getContainerDiskUsage('container-1', '/data/hung')
    await clock.tickAsync(15_000)
    expect(await result).to.equal(null)
    expect(stream.destroyed).to.equal(true)
  })
})
