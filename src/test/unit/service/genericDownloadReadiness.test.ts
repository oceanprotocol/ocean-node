import { expect } from 'chai'
import sinon from 'sinon'
import http from 'http'
import { AddressInfo } from 'net'
import * as tarStream from 'tar-stream'
import { C2DEngineDocker } from '../../../components/c2d/compute_engine_docker.js'
import { ServiceStatusNumber } from '../../../@types/C2D/ServiceOnDemand.js'
import { DOWNLOAD_STALL_SECONDS } from '../../../components/c2d/serviceReadiness.js'

// An unrecognized image whose port answers at once while its launch script still downloads.
describe('readiness of a generic service with a listed download', () => {
  const CACHE = '/data/outputs/hf/hub/models--org--model'
  let server: http.Server
  let url: string

  before(async () => {
    server = http.createServer((_req, res) => {
      res.writeHead(200)
      res.end('ok')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  after(() => {
    server.close()
  })

  function engineWith(folderBytes: number) {
    const e: any = Object.create(C2DEngineDocker.prototype)
    e.serviceOpsInFlight = new Set()
    e.serviceProbeUrls = new Map()
    e.manifestCheckedAt = new Map()
    e.manifestDirSizes = new Map()
    e.readinessWarned = new Map()
    e.downloadProgress = new Map()
    e.docker = {
      getContainer: () => ({
        getArchive: () => {
          const pack = tarStream.pack()
          pack.entry({ name: 'downloads.tsv' }, `dir\t1000\t${CACHE}\n`)
          pack.finalize()
          return Promise.resolve(pack)
        }
      })
    }
    e.getContainerDiskUsage = sinon.stub().resolves(folderBytes)
    e.db = {
      isServiceLocked: sinon.stub().resolves(false),
      updateServiceJobReadiness: sinon.stub().resolves(true)
    }
    return e
  }

  const job = () => ({
    serviceId: 'svc-1',
    owner: '0x0000000000000000000000000000000000000001',
    clusterHash: '0xcluster',
    containerId: 'container-1',
    image: 'acme/custom-app',
    exposedPorts: [7860],
    endpoints: [{ containerPort: 7860, hostPort: 1, url }],
    status: ServiceStatusNumber.Running
  })
  const details = () => ({
    State: { StartedAt: new Date(Date.now() - 60_000).toISOString() },
    NetworkSettings: { Networks: {} }
  })
  const lastWrite = (e: any) => {
    const [, , readiness, download] = e.db.updateServiceJobReadiness.lastCall.args
    return { readiness, download }
  }

  it('stays waiting while the download is unfinished', async () => {
    const e = engineWith(400)
    await e.probeServiceReadiness(job(), details())
    const { readiness, download } = lastWrite(e)
    expect(readiness).to.include({
      state: 'waiting',
      engine: 'generic',
      httpStatus: 200,
      lastError: 'model download in progress'
    })
    expect(readiness.readySince).to.equal(undefined)
    expect(download).to.include({ percent: 40 })
  })

  it('is ready once the download is complete', async () => {
    const e = engineWith(1000)
    await e.probeServiceReadiness(job(), details())
    expect(lastWrite(e).readiness).to.include({ state: 'ready', engine: 'generic' })
  })

  it('is ready once the download stops moving', async () => {
    const clock = sinon.useFakeTimers({ now: Date.now(), toFake: ['Date'] })
    try {
      const e = engineWith(400)
      await e.probeServiceReadiness(job(), details())
      expect(lastWrite(e).readiness.state).to.equal('waiting')
      clock.tick(DOWNLOAD_STALL_SECONDS * 1000 - 1000)
      await e.probeServiceReadiness(job(), details())
      expect(lastWrite(e).readiness.state).to.equal('waiting')
      clock.tick(2000)
      await e.probeServiceReadiness(job(), details())
      expect(lastWrite(e).readiness.state).to.equal('ready')
    } finally {
      clock.restore()
    }
  })

  it('restarts the stall window when the download moves', async () => {
    const clock = sinon.useFakeTimers({ now: Date.now(), toFake: ['Date'] })
    try {
      const e = engineWith(400)
      await e.probeServiceReadiness(job(), details())
      clock.tick(DOWNLOAD_STALL_SECONDS * 1000 - 1000)
      e.getContainerDiskUsage.resolves(500)
      e.manifestDirSizes.clear()
      await e.probeServiceReadiness(job(), details())
      clock.tick(2000)
      await e.probeServiceReadiness(job(), details())
      expect(lastWrite(e).readiness.state).to.equal('waiting')
    } finally {
      clock.restore()
    }
  })
})
