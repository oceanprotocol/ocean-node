import { expect } from 'chai'
import sinon from 'sinon'
import fs from 'fs'
import os from 'os'
import path from 'path'
import * as tarStream from 'tar-stream'
import {
  HF_PATCH_CONTAINER_DIR,
  HF_PATCH_FILE_NAME,
  HF_PATCH_TAR_ENTRY,
  SHIPPED_HF_PATCH_PATH,
  applyServiceHfMirror,
  buildServiceHfPlan,
  getServiceHfMirrorSettings,
  hfPatchArchive,
  injectHfPatch
} from '../../../components/c2d/serviceHfMirror.js'
import { C2DEngineDocker } from '../../../components/c2d/compute_engine_docker.js'
import { releaseHostPort } from '../../../components/core/service/utils.js'
import { ServiceStatusNumber } from '../../../@types/C2D/ServiceOnDemand.js'
import type { ServiceJob } from '../../../@types/C2D/ServiceOnDemand.js'
import { getConfiguration } from '../../../utils/config.js'
import { ENVIRONMENT_VARIABLES } from '../../../utils/constants.js'
import {
  TEST_ENV_CONFIG_PATH,
  buildEnvOverrideConfig,
  setupEnvironment,
  tearDownEnvironment
} from '../../utils/utils.js'
import type { OceanNodeConfig } from '../../../@types/OceanNode.js'

const MIRROR = 'http://172.17.0.1:8092'

function nodeConfig(overrides: Partial<OceanNodeConfig> = {}): OceanNodeConfig {
  return { ...overrides } as OceanNodeConfig
}

interface TarEntry {
  name: string
  type: string
  mode: number
  uid: number
  gid: number
  body: Buffer
}

function readTar(tar: Buffer): Promise<TarEntry[]> {
  const entries: TarEntry[] = []
  const extract = tarStream.extract()
  return new Promise((resolve, reject) => {
    extract.on('entry', (header, stream, next) => {
      const chunks: Buffer[] = []
      stream.on('data', (c: Buffer) => chunks.push(c))
      stream.on('end', () => {
        entries.push({
          name: header.name,
          type: header.type,
          mode: header.mode,
          uid: header.uid,
          gid: header.gid,
          body: Buffer.concat(chunks)
        })
        next()
      })
      stream.resume()
    })
    extract.on('finish', () => resolve(entries))
    extract.on('error', reject)
    extract.end(tar)
  })
}

describe('Service HF mirror: env', () => {
  it('changes nothing when the feature is off', () => {
    const userEnv = { FOO: 'bar', PYTHONPATH: '/app' }
    const spec = applyServiceHfMirror(userEnv, ['PYTHONPATH=/opt/lib'], {
      mirrorUrl: null,
      patch: false
    })
    expect(spec).to.deep.equal({ env: userEnv })
  })

  it('injects HF_ENDPOINT and HF_HUB_DISABLE_XET with a mirror', () => {
    const spec = applyServiceHfMirror({ FOO: 'bar' }, undefined, {
      mirrorUrl: MIRROR,
      patch: false
    })
    expect(spec.env).to.deep.equal({
      FOO: 'bar',
      HF_ENDPOINT: MIRROR,
      HF_HUB_DISABLE_XET: '1'
    })
    expect(spec.env).to.not.have.property('PYTHONPATH')
  })

  it("keeps the user's HF_ENDPOINT and then leaves HF_HUB_DISABLE_XET alone", () => {
    const spec = applyServiceHfMirror({ HF_ENDPOINT: 'https://huggingface.co' }, [], {
      mirrorUrl: MIRROR,
      patch: false
    })
    expect(spec.env).to.deep.equal({ HF_ENDPOINT: 'https://huggingface.co' })
  })

  it("keeps the user's HF_HUB_DISABLE_XET", () => {
    const spec = applyServiceHfMirror({ HF_HUB_DISABLE_XET: '0' }, [], {
      mirrorUrl: MIRROR,
      patch: false
    })
    expect(spec.env).to.deep.equal({ HF_ENDPOINT: MIRROR, HF_HUB_DISABLE_XET: '0' })
  })

  it('sets PYTHONPATH to the patch dir alone when the image has none', () => {
    const spec = applyServiceHfMirror({}, ['PATH=/usr/bin', 'LANG=C.UTF-8'], {
      mirrorUrl: MIRROR,
      patch: true
    })
    expect(spec.env.PYTHONPATH).to.equal(HF_PATCH_CONTAINER_DIR)
  })

  it("keeps the image's PYTHONPATH after the patch dir", () => {
    const spec = applyServiceHfMirror({}, ['PATH=/usr/bin', 'PYTHONPATH=/opt/a:/opt/b'], {
      mirrorUrl: MIRROR,
      patch: true
    })
    expect(spec.env.PYTHONPATH).to.equal(`${HF_PATCH_CONTAINER_DIR}:/opt/a:/opt/b`)
  })

  it("puts a user PYTHONPATH after the patch dir, replacing the image's as Docker does", () => {
    const spec = applyServiceHfMirror(
      { PYTHONPATH: '/work/src' },
      ['PYTHONPATH=/opt/a'],
      {
        mirrorUrl: MIRROR,
        patch: true
      }
    )
    expect(spec.env.PYTHONPATH).to.equal(`${HF_PATCH_CONTAINER_DIR}:/work/src`)
  })

  it('keeps the selected PYTHONPATH verbatim, empty components included', () => {
    // an empty component means "the working directory" — the image may rely on it
    expect(
      applyServiceHfMirror({}, ['PYTHONPATH=:/opt/a::'], {
        mirrorUrl: MIRROR,
        patch: true
      }).env.PYTHONPATH
    ).to.equal(`${HF_PATCH_CONTAINER_DIR}::/opt/a::`)
    expect(
      applyServiceHfMirror({ PYTHONPATH: '/w:' }, ['PYTHONPATH=/opt/a'], {
        mirrorUrl: MIRROR,
        patch: true
      }).env.PYTHONPATH
    ).to.equal(`${HF_PATCH_CONTAINER_DIR}:/w:`)
  })

  it('gives just the patch dir for an empty selected PYTHONPATH', () => {
    expect(
      applyServiceHfMirror({ PYTHONPATH: '' }, ['PYTHONPATH=/opt/a'], {
        mirrorUrl: MIRROR,
        patch: true
      }).env.PYTHONPATH
    ).to.equal(HF_PATCH_CONTAINER_DIR)
    expect(
      applyServiceHfMirror({}, ['PYTHONPATH='], {
        mirrorUrl: MIRROR,
        patch: true
      }).env.PYTHONPATH
    ).to.equal(HF_PATCH_CONTAINER_DIR)
  })

  it('skips the patch when the user sets OCEAN_HFPATCH=0', () => {
    const spec = applyServiceHfMirror({ OCEAN_HFPATCH: '0' }, ['PYTHONPATH=/opt/a'], {
      mirrorUrl: MIRROR,
      patch: true
    })
    expect(spec.env).to.deep.equal({
      OCEAN_HFPATCH: '0',
      HF_ENDPOINT: MIRROR,
      HF_HUB_DISABLE_XET: '1'
    })
  })

  it('does not mutate the user env', () => {
    const userEnv = { PYTHONPATH: '/x' }
    applyServiceHfMirror(userEnv, [], { mirrorUrl: MIRROR, patch: true })
    expect(userEnv).to.deep.equal({ PYTHONPATH: '/x' })
  })
})

describe('Service HF mirror: settings', () => {
  it('is off with no config', () => {
    expect(getServiceHfMirrorSettings(nodeConfig())).to.deep.equal({
      mirrorUrl: null,
      patch: false
    })
  })

  it('turns the patch on with a mirror', () => {
    expect(
      getServiceHfMirrorSettings(nodeConfig({ serviceHfMirrorUrl: MIRROR }))
    ).to.deep.equal({ mirrorUrl: MIRROR, patch: true })
  })

  it('honours an explicit serviceHfClientPatch=false', () => {
    expect(
      getServiceHfMirrorSettings(
        nodeConfig({ serviceHfMirrorUrl: MIRROR, serviceHfClientPatch: false })
      )
    ).to.deep.equal({ mirrorUrl: MIRROR, patch: false })
  })

  it('allows the patch without a mirror when explicitly on', () => {
    expect(
      getServiceHfMirrorSettings(nodeConfig({ serviceHfClientPatch: true }))
    ).to.deep.equal({ mirrorUrl: null, patch: true })
  })

  it('needs no host path: localfs persistent storage changes nothing', () => {
    expect(
      getServiceHfMirrorSettings(
        nodeConfig({
          serviceHfMirrorUrl: MIRROR,
          persistentStorage: {
            enabled: true,
            type: 'localfs',
            accessLists: [],
            options: { folder: '/mnt/ocean-storage' }
          }
        })
      )
    ).to.deep.equal({ mirrorUrl: MIRROR, patch: true })
  })
})

describe('Service HF mirror: config parsing', () => {
  async function configWith(values: string[]) {
    const overrides = buildEnvOverrideConfig(
      [
        ENVIRONMENT_VARIABLES.SERVICE_HF_MIRROR_URL,
        ENVIRONMENT_VARIABLES.SERVICE_HF_CLIENT_PATCH
      ],
      values
    )
    try {
      await setupEnvironment(TEST_ENV_CONFIG_PATH, overrides)
      return await getConfiguration(true)
    } finally {
      await tearDownEnvironment(overrides)
    }
  }

  it('reads valid values', async () => {
    const config = await configWith([MIRROR, 'false'])
    expect(config.serviceHfMirrorUrl).to.equal(MIRROR)
    expect(config.serviceHfClientPatch).to.equal(false)
  })

  it('drops a non-http(s) mirror URL instead of failing', async () => {
    const config = await configWith(['ftp://mirror:21', ''])
    expect(config.serviceHfMirrorUrl).to.equal(undefined)
    expect(config.serviceHfClientPatch).to.equal(undefined)
    expect(getServiceHfMirrorSettings(config).mirrorUrl).to.equal(null)
  })

  it('drops a mirror URL that does not parse', async () => {
    const config = await configWith(['not a url', 'true'])
    expect(config.serviceHfMirrorUrl).to.equal(undefined)
    expect(config.serviceHfClientPatch).to.equal(true)
  })
})

/* eslint-disable security/detect-non-literal-fs-filename -- temp test paths */
describe('Service HF mirror: patch archive and plan', () => {
  let tmp: string
  beforeEach(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ocean-hfpatch-test-')))
  })
  afterEach(() => {
    sinon.restore()
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('ships the patch file where the node reads it at runtime', () => {
    expect(fs.existsSync(SHIPPED_HF_PATCH_PATH)).to.equal(true)
    expect(path.basename(SHIPPED_HF_PATCH_PATH)).to.equal(HF_PATCH_FILE_NAME)
    expect(HF_PATCH_TAR_ENTRY).to.equal('ocean/hfpatch/sitecustomize.py')
  })

  it('packs only the shipped file, root-owned 0644, at ocean/hfpatch/', async () => {
    const entries = await readTar(await hfPatchArchive())
    expect(entries).to.have.length(1)
    const [e] = entries
    expect(e.name).to.equal(HF_PATCH_TAR_ENTRY)
    expect(e.type).to.equal('file')
    expect(e.mode & 0o7777).to.equal(0o644)
    expect(e.uid).to.equal(0)
    expect(e.gid).to.equal(0)
    expect(e.body.equals(fs.readFileSync(SHIPPED_HF_PATCH_PATH))).to.equal(true)
  })

  it('builds the shipped archive once', async () => {
    expect(await hfPatchArchive()).to.equal(await hfPatchArchive())
  })

  it('packs another path fresh and rejects when it is missing', async () => {
    const file = path.join(tmp, HF_PATCH_FILE_NAME)
    fs.writeFileSync(file, 'print("one")\n')
    const [one] = await readTar(await hfPatchArchive(file))
    expect(one.body.toString()).to.equal('print("one")\n')
    fs.writeFileSync(file, 'print("two")\n')
    const [two] = await readTar(await hfPatchArchive(file))
    expect(two.body.toString()).to.equal('print("two")\n')
    let err: Error | undefined
    await hfPatchArchive(path.join(tmp, 'missing.py')).catch((e) => {
      err = e
    })
    expect(err).to.be.instanceOf(Error)
  })

  it('copies the archive at / without replacing dirs by files', async () => {
    const container = { putArchive: sinon.stub().resolves() }
    const tar = Buffer.from('tar')
    await injectHfPatch(container, tar)
    expect(
      container.putArchive.calledOnceWith(tar, { path: '/', noOverwriteDirNonDir: true })
    ).to.equal(true)
  })

  it('plans a start without the patch when the archive cannot be built', async () => {
    const readImageEnv = sinon.stub().resolves(['PYTHONPATH=/opt/a'])
    const plan = await buildServiceHfPlan(
      { mirrorUrl: MIRROR, patch: true },
      { FOO: 'bar' },
      readImageEnv,
      'svc-1',
      () => Promise.reject(new Error('ENOENT'))
    )
    expect(plan).to.deep.equal({
      env: { FOO: 'bar', HF_ENDPOINT: MIRROR, HF_HUB_DISABLE_XET: '1' },
      patch: null,
      withoutPatch: null
    })
    expect(readImageEnv.called).to.equal(false)
  })

  it('plans a start without the patch when the image env cannot be read', async () => {
    const plan = await buildServiceHfPlan(
      { mirrorUrl: MIRROR, patch: true },
      {},
      () => Promise.reject(new Error('no such image')),
      'svc-1'
    )
    expect(plan.patch).to.equal(null)
    expect(plan.env).to.not.have.property('PYTHONPATH')
    expect(plan.withoutPatch).to.equal(null)
  })

  it('plans the patched start with an unpatched fallback', async () => {
    const tar = Buffer.from('tar')
    const plan = await buildServiceHfPlan(
      { mirrorUrl: MIRROR, patch: true },
      {},
      () => Promise.resolve(['PYTHONPATH=/opt/a']),
      'svc-1',
      () => Promise.resolve(tar)
    )
    expect(plan.env.PYTHONPATH).to.equal(`${HF_PATCH_CONTAINER_DIR}:/opt/a`)
    expect(plan.patch).to.equal(tar)
    expect(plan.withoutPatch).to.deep.equal({
      env: { HF_ENDPOINT: MIRROR, HF_HUB_DISABLE_XET: '1' }
    })
  })

  it('plans no patch for OCEAN_HFPATCH=0 without building the archive', async () => {
    const archive = sinon.stub().resolves(Buffer.from('tar'))
    const plan = await buildServiceHfPlan(
      { mirrorUrl: MIRROR, patch: true },
      { OCEAN_HFPATCH: '0' },
      () => Promise.resolve([]),
      'svc-1',
      archive
    )
    expect(plan.patch).to.equal(null)
    expect(plan.env).to.not.have.property('PYTHONPATH')
    expect(archive.called).to.equal(false)
  })

  it('plans no change at all when the feature is off', async () => {
    const readImageEnv = sinon.stub().resolves([])
    const plan = await buildServiceHfPlan(
      { mirrorUrl: null, patch: false },
      { FOO: 'bar' },
      readImageEnv,
      'svc-1'
    )
    expect(plan).to.deep.equal({ env: { FOO: 'bar' }, patch: null, withoutPatch: null })
    expect(readImageEnv.called).to.equal(false)
  })
})
/* eslint-enable security/detect-non-literal-fs-filename */

// Drives the REAL service lifecycle paths (processServiceStart, restartService →
// doRestartService) with stubbed Docker / escrow / DB / key manager, and asserts what
// actually reaches docker.createContainer and the containers' archive API.
describe('Service HF mirror: service start and restart containers', () => {
  const OWNER = '0x0000000000000000000000000000000000000001'
  const SERVICE_ID = 'svc-hf-1'
  const IMAGE_ENV = ['PATH=/usr/bin', 'PYTHONPATH=/opt/img']

  afterEach(() => {
    sinon.restore()
  })

  function makeJob(overrides: Partial<ServiceJob> = {}): ServiceJob {
    return {
      serviceId: SERVICE_ID,
      clusterHash: 'hash-1',
      environment: 'env-1',
      owner: OWNER,
      image: 'img',
      tag: 'latest',
      containerImage: 'img:latest',
      containerId: 'c-old',
      networkId: '',
      status: ServiceStatusNumber.Running,
      statusText: 'Running',
      dateCreated: new Date(0).toISOString(),
      expiresAt: Date.now() + 3600_000,
      duration: 3600,
      exposedPorts: [8888],
      endpoints: [
        { containerPort: 8888, hostPort: 39001, url: 'http://localhost:39001' }
      ],
      userData: 'aa', // decrypted by the stub key manager
      resources: [],
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

  // `putArchive` rejects when `patchError` is given (the HF patch is the first archive
  // put into a new container); `infoArchive` 404s, so the outputs folder is created too.
  function stubContainer(
    id: string,
    opts: { startError?: Error; patchError?: Error } = {}
  ) {
    const putArchive = sinon.stub().resolves()
    if (opts.patchError) putArchive.onFirstCall().rejects(opts.patchError)
    return {
      id,
      start: opts.startError
        ? sinon.stub().rejects(opts.startError)
        : sinon.stub().resolves(),
      stop: sinon.stub().resolves(),
      remove: sinon.stub().resolves(),
      inspect: sinon.stub().resolves({ State: { Running: false } }),
      infoArchive: sinon
        .stub()
        .rejects(Object.assign(new Error('nf'), { statusCode: 404 })),
      putArchive
    }
  }

  function makeEngine(
    config: Partial<OceanNodeConfig>,
    userEnv: Record<string, string>,
    containers: any[]
  ): any {
    const engine: any = Object.create(C2DEngineDocker.prototype)
    engine.config = config
    const createContainer = sinon.stub()
    containers.forEach((c, i) => createContainer.onCall(i).resolves(c))
    engine.docker = {
      createContainer,
      createNetwork: sinon
        .stub()
        .resolves({ id: 'net-1', remove: sinon.stub().resolves() }),
      getNetwork: sinon.stub().returns({
        inspect: sinon
          .stub()
          .rejects(Object.assign(new Error('gone'), { statusCode: 404 })),
        remove: sinon.stub().resolves()
      }),
      getContainer: sinon.stub().returns(stubContainer('c-old')),
      getImage: sinon.stub().returns({
        inspect: sinon.stub().resolves({ Config: { Env: IMAGE_ENV } })
      }),
      listContainers: sinon.stub().resolves([]),
      listNetworks: sinon.stub().resolves([])
    }
    engine.db = {
      getServiceJob: sinon.stub(),
      updateServiceJob: sinon.stub().resolves(1),
      acquireServiceLock: sinon.stub().resolves(true),
      releaseServiceLock: sinon.stub().resolves(undefined),
      refreshServiceLocks: sinon.stub().resolves(undefined),
      isServiceLocked: sinon.stub().resolves(false)
    }
    engine.escrow = {
      createLock: sinon.stub().resolves('0xlock'),
      waitForTransaction: sinon.stub().resolves(),
      getMinLockTime: () => 60,
      claimLock: sinon.stub().resolves('0xclaim'),
      cancelExpiredLock: sinon.stub().resolves('0xcancel')
    }
    engine.keyManager = {
      decrypt: sinon.stub().resolves(Buffer.from(JSON.stringify(userEnv)))
    }
    engine.pullImageRef = sinon.stub().resolves()
    engine.serviceLockHolderId = 'test-holder'
    engine.cpuAllocations = new Map()
    engine.serviceOpsInFlight = new Set()
    engine.serviceOpPromises = new Set()
    engine.clusterConfig = {
      hash: 'hash-1',
      connection: { resources: [], serviceOnDemand: { hostPortRange: [39000, 39200] } }
    }
    engine.stopped = false
    return engine
  }

  // Runs one lifecycle path to completion; returns the final persisted job.
  async function run(path: 'start' | 'restart', engine: any): Promise<ServiceJob> {
    if (path === 'start') {
      const job = makeJob({
        status: ServiceStatusNumber.Starting,
        statusText: 'Starting',
        containerId: '',
        endpoints: [],
        payment: { ...makeJob().payment, lockTx: '', claimTx: '' }
      })
      engine.db.getServiceJob.resolves([job])
      await engine.processServiceStart(job)
      for (const ep of job.endpoints) releaseHostPort(ep.hostPort)
      return job
    }
    const job = makeJob()
    engine.db.getServiceJob.resolves([job])
    await engine.restartService(SERVICE_ID, OWNER)
    await Promise.allSettled([...engine.serviceOpPromises])
    for (const ep of job.endpoints) releaseHostPort(ep.hostPort)
    return engine.db.updateServiceJob.lastCall.args[0]
  }

  function envOf(call: sinon.SinonSpyCall): Record<string, string> {
    return Object.fromEntries(
      call.args[0].Env.map((e: string) => [
        e.slice(0, e.indexOf('=')),
        e.slice(e.indexOf('=') + 1)
      ])
    )
  }

  const isPatchPut = (call: sinon.SinonSpyCall) =>
    call.args[1]?.path === '/' && call.args[1]?.noOverwriteDirNonDir === true

  for (const lifecycle of ['start', 'restart'] as const) {
    describe(lifecycle, () => {
      it('injects mirror env and PYTHONPATH and copies the patch in before start', async () => {
        const c = stubContainer('c-new')
        const engine = makeEngine({ serviceHfMirrorUrl: MIRROR }, { FOO: 'bar' }, [c])
        const job = await run(lifecycle, engine)
        expect(job.status).to.equal(ServiceStatusNumber.Running)
        expect(job.containerId).to.equal('c-new')
        const call = engine.docker.createContainer.firstCall
        expect(envOf(call)).to.deep.equal({
          FOO: 'bar',
          HF_ENDPOINT: MIRROR,
          HF_HUB_DISABLE_XET: '1',
          PYTHONPATH: `${HF_PATCH_CONTAINER_DIR}:/opt/img`
        })
        // no host path anywhere: nothing is mounted for the patch
        expect(call.args[0].HostConfig.Mounts).to.deep.equal([])
        expect(call.args[0].HostConfig.NetworkMode).to.equal('net-1')
        const first = c.putArchive.firstCall
        expect(isPatchPut(first)).to.equal(true)
        expect(first.args[0].equals(await hfPatchArchive())).to.equal(true)
        // the patch goes in before the outputs folder, and both before start
        expect(c.putArchive.callCount).to.equal(2)
        expect(isPatchPut(c.putArchive.secondCall)).to.equal(false)
        expect(c.putArchive.secondCall.calledBefore(c.start.firstCall)).to.equal(true)
        expect(c.start.calledOnce).to.equal(true)
      })

      it('changes nothing when the feature is off', async () => {
        const c = stubContainer('c-new')
        const engine = makeEngine({}, { FOO: 'bar', PYTHONPATH: '/work' }, [c])
        const job = await run(lifecycle, engine)
        expect(job.status).to.equal(ServiceStatusNumber.Running)
        const call = engine.docker.createContainer.firstCall
        expect(envOf(call)).to.deep.equal({ FOO: 'bar', PYTHONPATH: '/work' })
        expect(call.args[0].HostConfig.Mounts).to.deep.equal([])
        expect(engine.docker.getImage.called).to.equal(false)
        expect(c.putArchive.getCalls().some(isPatchPut)).to.equal(false)
      })

      it('skips the copy for OCEAN_HFPATCH=0', async () => {
        const c = stubContainer('c-new')
        const engine = makeEngine(
          { serviceHfMirrorUrl: MIRROR },
          { OCEAN_HFPATCH: '0' },
          [c]
        )
        const job = await run(lifecycle, engine)
        expect(job.status).to.equal(ServiceStatusNumber.Running)
        expect(envOf(engine.docker.createContainer.firstCall)).to.deep.equal({
          OCEAN_HFPATCH: '0',
          HF_ENDPOINT: MIRROR,
          HF_HUB_DISABLE_XET: '1'
        })
        expect(c.putArchive.getCalls().some(isPatchPut)).to.equal(false)
      })

      it("keeps the user's HF_ENDPOINT and puts the user PYTHONPATH after the patch", async () => {
        const engine = makeEngine(
          { serviceHfMirrorUrl: MIRROR },
          { HF_ENDPOINT: 'https://huggingface.co', PYTHONPATH: '/work:' },
          [stubContainer('c-new')]
        )
        await run(lifecycle, engine)
        expect(envOf(engine.docker.createContainer.firstCall)).to.deep.equal({
          HF_ENDPOINT: 'https://huggingface.co',
          PYTHONPATH: `${HF_PATCH_CONTAINER_DIR}:/work:`
        })
      })

      it('recreates the container without the patch when the copy is refused', async () => {
        const failed = stubContainer('c-failed', {
          patchError: Object.assign(
            new Error(
              '(HTTP code 500) server error - container rootfs is marked read-only'
            ),
            { statusCode: 500 }
          )
        })
        const retry = stubContainer('c-retry')
        const engine = makeEngine({ serviceHfMirrorUrl: MIRROR }, { FOO: 'bar' }, [
          failed,
          retry
        ])
        const job = await run(lifecycle, engine)
        expect(job.status).to.equal(ServiceStatusNumber.Running)
        expect(job.containerId).to.equal('c-retry')
        expect(failed.remove.calledOnceWith({ force: true, v: true })).to.equal(true)
        expect(failed.start.called).to.equal(false)
        expect(engine.docker.createContainer.callCount).to.equal(2)
        const first = engine.docker.createContainer.firstCall
        const second = engine.docker.createContainer.secondCall
        expect(envOf(second)).to.deep.equal({
          FOO: 'bar',
          HF_ENDPOINT: MIRROR,
          HF_HUB_DISABLE_XET: '1'
        })
        // everything else is built identically
        const { Env: e1, ...rest1 } = first.args[0]
        const { Env: e2, ...rest2 } = second.args[0]
        expect(rest2).to.deep.equal(rest1)
        // the replacement gets the outputs folder but no patch, then starts
        expect(retry.putArchive.getCalls().some(isPatchPut)).to.equal(false)
        expect(retry.putArchive.calledOnce).to.equal(true)
        expect(retry.start.calledOnce).to.equal(true)
      })

      it('starts the patched container when it cannot be removed after a refused copy', async () => {
        const failed = stubContainer('c-kept', {
          patchError: new Error('not a directory')
        })
        failed.remove.rejects(new Error('removal in progress'))
        const engine = makeEngine({ serviceHfMirrorUrl: MIRROR }, {}, [failed])
        const job = await run(lifecycle, engine)
        expect(job.status).to.equal(ServiceStatusNumber.Running)
        expect(job.containerId).to.equal('c-kept')
        expect(engine.docker.createContainer.callCount).to.equal(1)
        expect(failed.start.calledOnce).to.equal(true)
      })

      it('does not retry a start failure', async () => {
        const failed = stubContainer('c-failed', {
          startError: new Error('could not select device driver "nvidia"')
        })
        const engine = makeEngine({ serviceHfMirrorUrl: MIRROR }, {}, [failed])
        const job = await run(lifecycle, engine)
        expect(job.status).to.not.equal(ServiceStatusNumber.Running)
        expect(engine.docker.createContainer.callCount).to.equal(1)
        expect(failed.start.calledOnce).to.equal(true)
        // the lifecycle's own failure cleanup still tears the container down
        expect(failed.remove.called).to.equal(true)
      })
    })
  }
})
