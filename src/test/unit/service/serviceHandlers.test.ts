import { assert, expect } from 'chai'
import { Readable } from 'stream'
import sinon from 'sinon'
import { streamToObject } from '../../../utils/util.js'
import { PROTOCOL_COMMANDS } from '../../../utils/constants.js'
import { ServiceStatusNumber, ServiceJob } from '../../../@types/C2D/ServiceOnDemand.js'
import { ServiceGetTemplatesHandler } from '../../../components/core/service/getTemplates.js'
import { ServiceGetStatusHandler } from '../../../components/core/service/getStatus.js'
import { ServiceStartHandler } from '../../../components/core/service/startService.js'
import { ServiceStopHandler } from '../../../components/core/service/stopService.js'
import { ServiceExtendHandler } from '../../../components/core/service/extendService.js'
import { ServiceRestartHandler } from '../../../components/core/service/restartService.js'
import { ServiceGetStreamableLogsHandler } from '../../../components/core/service/getStreamableLogs.js'

const OWNER = '0x0000000000000000000000000000000000000abc'

function makeJob(overrides: Partial<ServiceJob> = {}): ServiceJob {
  return {
    serviceId: 'svc-1',
    clusterHash: 'hash-1',
    environment: 'env-1',
    owner: OWNER,
    image: 'img',
    tag: 'latest',
    containerImage: 'img:latest',
    containerId: 'c1',
    networkId: 'n1',
    status: ServiceStatusNumber.Running,
    statusText: 'Running',
    dateCreated: new Date(0).toISOString(),
    expiresAt: Date.now() + 3600_000,
    duration: 3600,
    exposedPorts: [8888],
    endpoints: [{ containerPort: 8888, hostPort: 31000, url: 'http://localhost:31000' }],
    userData: 'ENCRYPTED',
    resources: [{ id: 'cpu', amount: 2 }],
    payment: {
      chainId: 8996,
      token: '0xtoken',
      lockTx: '0xl',
      claimTx: '0xc',
      cancelTx: '',
      cost: 5
    },
    ...overrides
  }
}

const TEMPLATE = {
  id: 'jupyter-cpu',
  image: 'quay.io/jupyter/datascience-notebook',
  tag: 'latest',
  exposedPorts: [8888]
}

interface FakeOpts {
  serviceEnabled?: boolean
  serviceJobInDb?: ServiceJob | null
  cost?: number | null
  envId?: string
  streamableLogs?: Readable | null
}

function buildFakes(opts: FakeOpts = {}) {
  const env: any = {
    id: opts.envId ?? 'env-1',
    features: {
      computeJobs: true,
      services: opts.serviceEnabled !== false
    },
    resources: [{ id: 'cpu', kind: 'fungible', total: 8, min: 1, max: 8 }]
  }

  const escrow = {
    createLock: sinon.stub().resolves('0xlock'),
    claimLock: sinon.stub().resolves('0xclaim'),
    cancelExpiredLock: sinon.stub().resolves('0xcancel'),
    waitForTransaction: sinon.stub().resolves(undefined),
    getMinLockTime: sinon.stub().returns(3600),
    // the SERVICE_START handler's fail-fast funds pre-check — plentiful by default
    getUserAvailableFunds: sinon.stub().resolves(1_000_000n),
    getPaymentAmountInWei: sinon.stub().resolves(10n)
  }

  const engine: any = {
    db: {
      getServiceJob: sinon
        .stub()
        .resolves(
          opts.serviceJobInDb === undefined
            ? []
            : opts.serviceJobInDb
              ? [opts.serviceJobInDb]
              : []
        ),
      updateServiceJob: sinon.stub().resolves(1)
    },
    escrow,
    getComputeEnvironments: sinon.stub().resolves([env]),
    // hash must match makeJob's clusterHash: handlers resolve the owning engine by it
    getC2DConfig: sinon.stub().returns({
      hash: 'hash-1',
      connection: { serviceOnDemand: { maxDurationSeconds: 86400 } }
    }),
    calculateResourcesCost: sinon
      .stub()
      .returns(opts.cost === undefined ? 10 : opts.cost),
    checkAndFillMissingResources: sinon
      .stub()
      .callsFake((r: any) => Promise.resolve(r ?? [])),
    checkIfResourcesAreAvailable: sinon.stub().resolves(undefined),
    getEnvPricesForToken: sinon.stub().returns([{ id: 'cpu', price: 1 }]),
    // Async start: the handler only persists a Starting record and returns; the escrow +
    // image + container work is done later by processServiceStart (driven by the cron).
    createServiceJob: sinon.stub().callsFake(() =>
      Promise.resolve(
        makeJob({
          status: ServiceStatusNumber.Starting,
          statusText: 'Starting',
          containerId: '',
          networkId: '',
          endpoints: []
        })
      )
    ),
    stopService: sinon
      .stub()
      .callsFake(() => Promise.resolve(makeJob({ status: ServiceStatusNumber.Stopped }))),
    restartService: sinon
      .stub()
      .callsFake(() =>
        Promise.resolve(
          makeJob({ containerId: 'c2', status: ServiceStatusNumber.Running })
        )
      ),
    getServiceStatus: sinon
      .stub()
      .resolves(opts.serviceJobInDb ? [opts.serviceJobInDb] : []),
    getServiceStreamableLogs: sinon
      .stub()
      .resolves(
        opts.streamableLogs === undefined
          ? Readable.from(['hello logs'])
          : opts.streamableLogs
      ),
    // handlers (SERVICE_EXTEND) serialize read-mutate-write flows through this; the
    // fake just runs the callback (the real engine wraps it in the lifecycle lock)
    runExclusive: sinon.stub().callsFake((_id: string, fn: () => Promise<any>) => fn())
  }

  const engines: any = {
    getAllEngines: () => [engine],
    getC2DByEnvId: sinon.stub().resolves(engine),
    getC2DByHash: sinon.stub().resolves(engine),
    fetchServiceTemplates: sinon.stub().resolves([{ ...TEMPLATE }])
  }

  const node: any = {
    getRequestMap: () => new Map(),
    getConfig: (): any => ({
      rateLimit: undefined as number | undefined,
      serviceTemplatesPath: undefined as string | undefined
    }),
    getC2DEngines: () => engines,
    getKeyManager: () => ({
      decrypt: (d: Uint8Array) => Promise.resolve(Buffer.from(d))
    }),
    getAuth: () => ({
      validateAuthenticationOrToken: () => Promise.resolve({ valid: true })
    })
  }

  return { node, engine, engines, escrow, env }
}

function body(response: any): Promise<any> {
  return streamToObject(response.stream as Readable)
}

describe('Service handlers', () => {
  afterEach(() => sinon.restore())

  describe('ServiceGetTemplatesHandler', () => {
    it('returns templates from fetchServiceTemplates (200)', async () => {
      const { node, engines } = buildFakes()
      const res = await new ServiceGetTemplatesHandler(node).handle({
        command: PROTOCOL_COMMANDS.SERVICE_GET_TEMPLATES
      } as any)
      expect(res.status.httpStatus).to.equal(200)
      const templates = await body(res)
      expect(templates).to.have.length(1)
      expect(engines.fetchServiceTemplates.calledOnce).to.equal(true)
    })
  })

  describe('ServiceGetStatusHandler', () => {
    it('400 when consumerAddress is missing', async () => {
      const { node } = buildFakes()
      const res = await new ServiceGetStatusHandler(node).handle({
        command: PROTOCOL_COMMANDS.SERVICE_GET_STATUS,
        serviceId: 'svc-1'
      } as any)
      expect(res.status.httpStatus).to.equal(400)
    })

    it('401 when the signature/token is invalid', async () => {
      const { node } = buildFakes({ serviceJobInDb: makeJob() })
      node.getAuth = () => ({
        validateAuthenticationOrToken: () =>
          Promise.resolve({ valid: false, error: 'bad signature' })
      })
      const res = await new ServiceGetStatusHandler(node).handle({
        command: PROTOCOL_COMMANDS.SERVICE_GET_STATUS,
        consumerAddress: OWNER,
        nonce: '1',
        signature: '0xbad',
        serviceId: 'svc-1'
      } as any)
      expect(res.status.httpStatus).to.equal(401)
    })

    it('returns jobs by serviceId with userData stripped (authenticated)', async () => {
      const { node } = buildFakes({ serviceJobInDb: makeJob() })
      const res = await new ServiceGetStatusHandler(node).handle({
        command: PROTOCOL_COMMANDS.SERVICE_GET_STATUS,
        consumerAddress: OWNER,
        nonce: '1',
        signature: '0xsig',
        serviceId: 'svc-1'
      } as any)
      expect(res.status.httpStatus).to.equal(200)
      const jobs = await body(res)
      expect(jobs).to.have.length(1)
      expect(jobs[0]).to.not.have.property('userData')
      expect(jobs[0].serviceId).to.equal('svc-1')
    })
  })

  describe('ServiceStopHandler', () => {
    const baseTask = {
      command: PROTOCOL_COMMANDS.SERVICE_STOP,
      consumerAddress: OWNER,
      nonce: '1',
      signature: '0xsig',
      serviceId: 'svc-1'
    }

    it('400 when service not found', async () => {
      const { node } = buildFakes({ serviceJobInDb: null })
      const res = await new ServiceStopHandler(node).handle({ ...baseTask } as any)
      expect(res.status.httpStatus).to.equal(400)
    })

    it('401 when caller is not the owner', async () => {
      const { node } = buildFakes({ serviceJobInDb: makeJob({ owner: '0xsomeoneelse' }) })
      const res = await new ServiceStopHandler(node).handle({ ...baseTask } as any)
      expect(res.status.httpStatus).to.equal(401)
    })

    it('200 and calls engine.stopService on success', async () => {
      const { node, engine } = buildFakes({ serviceJobInDb: makeJob() })
      const res = await new ServiceStopHandler(node).handle({ ...baseTask } as any)
      expect(res.status.httpStatus).to.equal(200)
      expect(engine.stopService.calledOnce).to.equal(true)
      const jobs = await body(res)
      expect(jobs[0].status).to.equal(ServiceStatusNumber.Stopped)
      expect(jobs[0]).to.not.have.property('userData')
    })
  })

  describe('ServiceRestartHandler', () => {
    const baseTask = {
      command: PROTOCOL_COMMANDS.SERVICE_RESTART,
      consumerAddress: OWNER,
      nonce: '1',
      signature: '0xsig',
      serviceId: 'svc-1'
    }

    it('400 when not found', async () => {
      const { node } = buildFakes({ serviceJobInDb: null })
      const res = await new ServiceRestartHandler(node).handle({ ...baseTask } as any)
      expect(res.status.httpStatus).to.equal(400)
    })

    it('401 when not owner', async () => {
      const { node } = buildFakes({ serviceJobInDb: makeJob({ owner: '0xother' }) })
      const res = await new ServiceRestartHandler(node).handle({ ...baseTask } as any)
      expect(res.status.httpStatus).to.equal(401)
    })

    it('400 when restarting an expired service', async () => {
      const { node } = buildFakes({
        serviceJobInDb: makeJob({ status: ServiceStatusNumber.Expired })
      })
      const res = await new ServiceRestartHandler(node).handle({ ...baseTask } as any)
      expect(res.status.httpStatus).to.equal(400)
    })

    it('200 and calls engine.restartService on success', async () => {
      const { node, engine } = buildFakes({ serviceJobInDb: makeJob() })
      const res = await new ServiceRestartHandler(node).handle({ ...baseTask } as any)
      expect(res.status.httpStatus).to.equal(200)
      expect(engine.restartService.calledOnce).to.equal(true)
      const jobs = await body(res)
      expect(jobs[0].containerId).to.equal('c2')
      expect(jobs[0]).to.not.have.property('userData')
    })

    it('forwards dockerCmd and dockerEntrypoint overrides to engine.restartService', async () => {
      const { node, engine } = buildFakes({ serviceJobInDb: makeJob() })
      await new ServiceRestartHandler(node).handle({
        ...baseTask,
        dockerCmd: ['python', 'new_script.py'],
        dockerEntrypoint: ['/bin/new-entrypoint']
      } as any)
      expect(engine.restartService.calledOnce).to.equal(true)
      const callArgs = engine.restartService.firstCall.args
      expect(callArgs[0]).to.equal('svc-1')
      expect(callArgs[1]).to.equal(OWNER)
      expect(callArgs[3]).to.deep.equal(['python', 'new_script.py'])
      expect(callArgs[4]).to.deep.equal(['/bin/new-entrypoint'])
    })

    it('forwards undefined dockerCmd/dockerEntrypoint when not supplied, so the engine reuses stored values', async () => {
      const { node, engine } = buildFakes({ serviceJobInDb: makeJob() })
      await new ServiceRestartHandler(node).handle({ ...baseTask } as any)
      const callArgs = engine.restartService.firstCall.args
      expect(callArgs[3]).to.equal(undefined)
      expect(callArgs[4]).to.equal(undefined)
    })
  })

  describe('ServiceExtendHandler', () => {
    const baseTask = {
      command: PROTOCOL_COMMANDS.SERVICE_EXTEND,
      consumerAddress: OWNER,
      nonce: '1',
      signature: '0xsig',
      serviceId: 'svc-1',
      additionalDuration: 3600,
      payment: { chainId: 8996, token: '0xtoken' }
    }

    it('400 when not found', async () => {
      const { node } = buildFakes({ serviceJobInDb: null })
      const res = await new ServiceExtendHandler(node).handle({ ...baseTask } as any)
      expect(res.status.httpStatus).to.equal(400)
    })

    it('400 when additionalDuration is not strictly positive', async () => {
      const { node } = buildFakes({ serviceJobInDb: makeJob() })
      for (const additionalDuration of [0, -1, -3600]) {
        const res = await new ServiceExtendHandler(node).handle({
          ...baseTask,
          additionalDuration
        } as any)
        expect(
          res.status.httpStatus,
          `additionalDuration=${additionalDuration}`
        ).to.equal(400)
      }
    })

    it('401 when not owner', async () => {
      const { node } = buildFakes({ serviceJobInDb: makeJob({ owner: '0xother' }) })
      const res = await new ServiceExtendHandler(node).handle({ ...baseTask } as any)
      expect(res.status.httpStatus).to.equal(401)
    })

    it('400 when service is Stopped (bad state)', async () => {
      const { node } = buildFakes({
        serviceJobInDb: makeJob({ status: ServiceStatusNumber.Stopped })
      })
      const res = await new ServiceExtendHandler(node).handle({ ...baseTask } as any)
      expect(res.status.httpStatus).to.equal(400)
    })

    it('400 when extension exceeds maxDurationSeconds', async () => {
      const { node } = buildFakes({
        serviceJobInDb: makeJob({ expiresAt: Date.now() + 86000 * 1000 })
      })
      const res = await new ServiceExtendHandler(node).handle({
        ...baseTask,
        additionalDuration: 10000
      } as any)
      expect(res.status.httpStatus).to.equal(400)
    })

    it('402 when escrow lock fails', async () => {
      const { node, escrow } = buildFakes({ serviceJobInDb: makeJob() })
      escrow.createLock.resolves(null)
      const res = await new ServiceExtendHandler(node).handle({ ...baseTask } as any)
      expect(res.status.httpStatus).to.equal(402)
    })

    it('402 and cancels lock when claim fails', async () => {
      const { node, escrow } = buildFakes({ serviceJobInDb: makeJob() })
      escrow.claimLock.resolves(null)
      const res = await new ServiceExtendHandler(node).handle({ ...baseTask } as any)
      expect(res.status.httpStatus).to.equal(402)
      expect(escrow.cancelExpiredLock.calledOnce).to.equal(true)
    })

    it('200, advances expiresAt and records an extendPayment', async () => {
      const job = makeJob()
      const before = job.expiresAt
      const { node, engine, escrow } = buildFakes({ serviceJobInDb: job })
      const res = await new ServiceExtendHandler(node).handle({ ...baseTask } as any)
      expect(res.status.httpStatus).to.equal(200)
      expect(escrow.createLock.calledOnce).to.equal(true)
      expect(escrow.claimLock.calledOnce).to.equal(true)
      // two writes: the durable intent (before claim) + the finalized extension
      expect(engine.db.updateServiceJob.calledTwice).to.equal(true)
      const out = await body(res)
      expect(out[0].expiresAt).to.equal(before + 3600 * 1000)
      expect(out[0].extendPayments).to.have.length(1)
      expect(out[0].extendPayments[0].claimTx).to.equal('0xclaim')
      expect(out[0]).to.not.have.property('userData')
    })

    it('auto-refunds an unresolved extension intent from a previous crash, then proceeds', async () => {
      const job = makeJob({
        extendPayments: [
          // lockTx set, neither claimTx nor cancelTx — a crash between claim and write
          {
            chainId: 8996,
            token: '0xtoken',
            lockTx: '0xoldlock',
            claimTx: '',
            cancelTx: '',
            cost: 5
          }
        ]
      })
      const { node, escrow } = buildFakes({ serviceJobInDb: job })
      const res = await new ServiceExtendHandler(node).handle({ ...baseTask } as any)
      expect(res.status.httpStatus).to.equal(200)
      // the stale lock was refunded before charging again
      expect(escrow.cancelExpiredLock.calledOnce).to.equal(true)
      const out = await body(res)
      expect(out[0].extendPayments).to.have.length(2)
      expect(out[0].extendPayments[0].cancelTx).to.equal('0xcancel')
      expect(out[0].extendPayments[1].claimTx).to.equal('0xclaim')
    })

    it('409 when an unresolved extension intent cannot be refunded (no double charge)', async () => {
      const job = makeJob({
        extendPayments: [
          {
            chainId: 8996,
            token: '0xtoken',
            lockTx: '0xoldlock',
            claimTx: '',
            cancelTx: '',
            cost: 5
          }
        ]
      })
      const { node, escrow } = buildFakes({ serviceJobInDb: job })
      escrow.cancelExpiredLock.rejects(new Error('lock already claimed'))
      const res = await new ServiceExtendHandler(node).handle({ ...baseTask } as any)
      expect(res.status.httpStatus).to.equal(409)
      // no new charge may be attempted while the old intent is unresolved
      expect(escrow.createLock.called).to.equal(false)
      expect(escrow.claimLock.called).to.equal(false)
    })
  })

  describe('ServiceStartHandler', () => {
    const baseTask = {
      command: PROTOCOL_COMMANDS.SERVICE_START,
      consumerAddress: OWNER,
      nonce: '1',
      signature: '0xsig',
      environment: 'env-1',
      image: 'nginx',
      tag: 'alpine',
      exposedPorts: [80],
      dockerCmd: ['nginx', '-g', 'daemon off;'],
      dockerEntrypoint: ['/docker-entrypoint.sh'],
      duration: 3600,
      payment: { chainId: 8996, token: '0xtoken' }
    }

    it('400 when consumerAddress is not a valid address', async () => {
      const { node } = buildFakes()
      const res = await new ServiceStartHandler(node).handle({
        ...baseTask,
        consumerAddress: 'not-an-address'
      } as any)
      expect(res.status.httpStatus).to.equal(400)
    })

    it('400 when environment is unknown (getC2DByEnvId throws)', async () => {
      const { node, engines } = buildFakes()
      engines.getC2DByEnvId.rejects(new Error('not found'))
      const res = await new ServiceStartHandler(node).handle({ ...baseTask } as any)
      expect(res.status.httpStatus).to.equal(400)
    })

    it('400 with a clear message when the escrow cannot cover the cost (fail fast)', async () => {
      const { node, engine } = buildFakes()
      engine.escrow.getUserAvailableFunds.resolves(0n)
      const res = await new ServiceStartHandler(node).handle({ ...baseTask } as any)
      expect(res.status.httpStatus).to.equal(400)
      expect(String(res.status.error)).to.contain('Insufficient escrow funds')
      // no job record may be created for a start that was refused upfront
      expect(engine.createServiceJob.called).to.equal(false)
    })

    it('the funds pre-check is best-effort: an RPC failure does not block the start', async () => {
      const { node, engine } = buildFakes()
      engine.escrow.getUserAvailableFunds.rejects(new Error('rpc down'))
      const res = await new ServiceStartHandler(node).handle({ ...baseTask } as any)
      expect(res.status.httpStatus).to.equal(200)
      expect(engine.createServiceJob.calledOnce).to.equal(true)
    })

    it('403 when services are disabled on the environment', async () => {
      const { node } = buildFakes({ serviceEnabled: false })
      const res = await new ServiceStartHandler(node).handle({ ...baseTask } as any)
      expect(res.status.httpStatus).to.equal(403)
    })

    it('400 when image is missing', async () => {
      const { node } = buildFakes()
      const { image, ...noImage } = baseTask
      const res = await new ServiceStartHandler(node).handle({ ...noImage } as any)
      expect(res.status.httpStatus).to.equal(400)
    })

    it('400 when more than one image mode is set (tag + dockerfile)', async () => {
      const { node } = buildFakes()
      const res = await new ServiceStartHandler(node).handle({
        ...baseTask,
        dockerfile: 'FROM nginx:alpine'
      } as any)
      expect(res.status.httpStatus).to.equal(400)
    })

    it('400 when duration exceeds maxDurationSeconds', async () => {
      const { node } = buildFakes()
      const res = await new ServiceStartHandler(node).handle({
        ...baseTask,
        duration: 999999
      } as any)
      expect(res.status.httpStatus).to.equal(400)
    })

    it('400 when no pricing for the token (cost null)', async () => {
      const { node } = buildFakes({ cost: null })
      const res = await new ServiceStartHandler(node).handle({ ...baseTask } as any)
      expect(res.status.httpStatus).to.equal(400)
    })

    it('200 returns immediately with a Starting job and does NOT run escrow synchronously', async () => {
      const { node, engine, escrow } = buildFakes()
      const res = await new ServiceStartHandler(node).handle({ ...baseTask } as any)
      expect(res.status.httpStatus).to.equal(200)
      const out = await body(res)
      // The response is the freshly-persisted Starting record — escrow + container come later.
      expect(out[0].status).to.equal(ServiceStatusNumber.Starting)
      expect(out[0].endpoints).to.deep.equal([])
      expect(out[0]).to.not.have.property('userData')
      // Escrow now runs in the background pipeline, not in the request path.
      expect(escrow.createLock.called).to.equal(false)
      expect(escrow.claimLock.called).to.equal(false)
      // The handler must not invoke the background pipeline itself.
      expect(engine.processServiceStart).to.equal(undefined)
    })

    it('200 happy path: calls createServiceJob with env/image/dockerCmd/dockerEntrypoint, strips userData', async () => {
      const { node, engine } = buildFakes()
      const res = await new ServiceStartHandler(node).handle({ ...baseTask } as any)
      expect(res.status.httpStatus).to.equal(200)
      assert(engine.createServiceJob.calledOnce, 'createServiceJob should be called')
      const { args } = engine.createServiceJob.firstCall
      // signature: (environment, image, tag, checksum, dockerfile, additionalDockerFiles,
      //             dockerCmd, dockerEntrypoint, exposedPorts, resources, duration, owner,
      //             payment, serviceId, userData)
      expect(args[0]).to.equal('env-1')
      expect(args[1]).to.equal('nginx')
      expect(args[6]).to.deep.equal(['nginx', '-g', 'daemon off;'])
      expect(args[7]).to.deep.equal(['/docker-entrypoint.sh'])
      // payment carries the server-side cost but no tx hashes yet (filled in by the pipeline).
      const payment = args[12]
      expect(payment.cost).to.equal(10)
      expect(payment.lockTx).to.equal('')
      expect(payment.claimTx).to.equal('')
      const out = await body(res)
      expect(out[0]).to.not.have.property('userData')
    })
  })

  describe('ServiceGetStreamableLogsHandler', () => {
    const baseTask = {
      command: PROTOCOL_COMMANDS.SERVICE_GET_STREAMABLE_LOGS,
      consumerAddress: OWNER,
      nonce: '1',
      signature: '0xsig',
      serviceId: 'svc-1'
    }

    it('400 when serviceId is missing', async () => {
      const { node } = buildFakes({ serviceJobInDb: makeJob() })
      const { serviceId, ...noServiceId } = baseTask
      const res = await new ServiceGetStreamableLogsHandler(node).handle({
        ...noServiceId
      } as any)
      expect(res.status.httpStatus).to.equal(400)
    })

    it('401 when the signature/token is invalid', async () => {
      const { node } = buildFakes({ serviceJobInDb: makeJob() })
      node.getAuth = () => ({
        validateAuthenticationOrToken: () =>
          Promise.resolve({ valid: false, error: 'bad signature' })
      })
      const res = await new ServiceGetStreamableLogsHandler(node).handle({
        ...baseTask
      } as any)
      expect(res.status.httpStatus).to.equal(401)
    })

    it('400 when service not found', async () => {
      const { node } = buildFakes({ serviceJobInDb: null })
      const res = await new ServiceGetStreamableLogsHandler(node).handle({
        ...baseTask
      } as any)
      expect(res.status.httpStatus).to.equal(400)
    })

    it('401 when caller is not the owner', async () => {
      const { node } = buildFakes({ serviceJobInDb: makeJob({ owner: '0xsomeoneelse' }) })
      const res = await new ServiceGetStreamableLogsHandler(node).handle({
        ...baseTask
      } as any)
      expect(res.status.httpStatus).to.equal(401)
    })

    it('404 when the engine has no stream to return (not running/error)', async () => {
      const { node } = buildFakes({ serviceJobInDb: makeJob(), streamableLogs: null })
      const res = await new ServiceGetStreamableLogsHandler(node).handle({
        ...baseTask
      } as any)
      expect(res.status.httpStatus).to.equal(404)
    })

    it('200 and returns the engine stream on success', async () => {
      const { node, engine } = buildFakes({ serviceJobInDb: makeJob() })
      const res = await new ServiceGetStreamableLogsHandler(node).handle({
        ...baseTask
      } as any)
      expect(res.status.httpStatus).to.equal(200)
      expect(engine.getServiceStreamableLogs.calledOnceWith('svc-1', OWNER)).to.equal(
        true
      )
      const chunks: Buffer[] = []
      for await (const chunk of res.stream as Readable) {
        chunks.push(Buffer.from(chunk))
      }
      expect(Buffer.concat(chunks).toString()).to.equal('hello logs')
    })

    it('200 when service is in Error status (crashed container logs still fetchable)', async () => {
      const { node, engine } = buildFakes({
        serviceJobInDb: makeJob({ status: ServiceStatusNumber.Error })
      })
      const res = await new ServiceGetStreamableLogsHandler(node).handle({
        ...baseTask
      } as any)
      expect(res.status.httpStatus).to.equal(200)
      expect(engine.getServiceStreamableLogs.calledOnce).to.equal(true)
    })

    it('400 when since has an invalid format', async () => {
      const { node } = buildFakes({ serviceJobInDb: makeJob() })
      const res = await new ServiceGetStreamableLogsHandler(node).handle({
        ...baseTask,
        since: 'not-a-valid-since'
      } as any)
      expect(res.status.httpStatus).to.equal(400)
    })

    it('200 and passes an absolute since timestamp straight through', async () => {
      const { node, engine } = buildFakes({ serviceJobInDb: makeJob() })
      const res = await new ServiceGetStreamableLogsHandler(node).handle({
        ...baseTask,
        since: '1735689600'
      } as any)
      expect(res.status.httpStatus).to.equal(200)
      expect(engine.getServiceStreamableLogs.firstCall.args).to.deep.equal([
        'svc-1',
        OWNER,
        1735689600
      ])
    })

    it('200 and converts a relative since duration to a timestamp', async () => {
      const { node, engine } = buildFakes({ serviceJobInDb: makeJob() })
      const before = Math.floor(Date.now() / 1000) - 3600
      const res = await new ServiceGetStreamableLogsHandler(node).handle({
        ...baseTask,
        since: '1h'
      } as any)
      const after = Math.floor(Date.now() / 1000) - 3600
      expect(res.status.httpStatus).to.equal(200)
      const since = engine.getServiceStreamableLogs.firstCall.args[2]
      expect(since).to.be.within(before, after)
    })
  })
})
