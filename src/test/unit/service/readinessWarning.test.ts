import { expect } from 'chai'
import sinon from 'sinon'
import { C2DEngineDocker } from '../../../components/c2d/compute_engine_docker.js'
import { ServiceStatusNumber } from '../../../@types/C2D/ServiceOnDemand.js'
import { CORE_LOGGER } from '../../../utils/logging/common.js'

// A ComfyUI service whose port the node cannot reach (port 1 refuses at once), so every probe
// reads "waiting" — the case the warning exists for.
describe('warning for a service that stays not ready', () => {
  let warn: sinon.SinonStub
  beforeEach(() => {
    warn = sinon.stub(CORE_LOGGER, 'warn')
  })
  afterEach(() => {
    warn.restore()
  })

  function engine() {
    const e: any = Object.create(C2DEngineDocker.prototype)
    e.serviceOpsInFlight = new Set()
    e.serviceProbeUrls = new Map()
    e.manifestCheckedAt = new Map()
    e.readinessWarned = new Map()
    e.docker = {
      getContainer: () => ({
        getArchive: () => Promise.reject(new Error('no such file'))
      })
    }
    e.db = {
      isServiceLocked: sinon.stub().resolves(false),
      updateServiceJobReadiness: sinon.stub().resolves(true)
    }
    return e
  }

  const job = (containerId = 'container-1') => ({
    serviceId: 'svc-1',
    owner: '0x0000000000000000000000000000000000000001',
    clusterHash: '0xcluster',
    containerId,
    image: 'yanwk/comfyui-boot',
    exposedPorts: [8188],
    endpoints: [{ containerPort: 8188, hostPort: 1, url: 'http://127.0.0.1:1' }],
    status: ServiceStatusNumber.Running
  })
  const startedAgo = (minutes: number) => ({
    State: { StartedAt: new Date(Date.now() - minutes * 60_000).toISOString() },
    NetworkSettings: { Networks: {} }
  })
  const readinessWarnings = () =>
    warn.getCalls().filter((call) => String(call.args[0]).startsWith('[readiness]'))

  it('warns once per container after 15 minutes', async () => {
    const e = engine()
    await e.probeServiceReadiness(job(), startedAgo(16))
    await e.probeServiceReadiness(job(), startedAgo(16))
    expect(readinessWarnings()).to.have.length(1)
    expect(readinessWarnings()[0].args[0]).to.include('svc-1 (comfyui) not ready 16 min')
  })

  it('stays quiet before then', async () => {
    const e = engine()
    await e.probeServiceReadiness(job(), startedAgo(5))
    expect(readinessWarnings()).to.have.length(0)
  })

  it('warns again for the new container after a restart', async () => {
    const e = engine()
    await e.probeServiceReadiness(job('container-1'), startedAgo(16))
    await e.probeServiceReadiness(job('container-2'), startedAgo(16))
    expect(readinessWarnings()).to.have.length(2)
  })
})
