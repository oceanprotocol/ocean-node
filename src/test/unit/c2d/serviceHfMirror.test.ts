import { expect } from 'chai'
import sinon from 'sinon'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  HF_PATCH_CONTAINER_DIR,
  HF_PATCH_FILE_NAME,
  SHIPPED_HF_PATCH_PATH,
  applyServiceHfMirror,
  buildServiceHfPlan,
  getServiceHfMirrorSettings,
  isHfPatchMountError,
  prepareHfPatchDir,
  resolveHfPatchHostDir
} from '../../../components/c2d/serviceHfMirror.js'
import fsp from 'fs/promises'
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
const HOST_DIR = '/srv/ocean/hfpatch'

function nodeConfig(overrides: Partial<OceanNodeConfig> = {}): OceanNodeConfig {
  return { ...overrides } as OceanNodeConfig
}

describe('Service HF mirror: env and mounts', () => {
  it('changes nothing when the feature is off', () => {
    const userEnv = { FOO: 'bar', PYTHONPATH: '/app' }
    const spec = applyServiceHfMirror(userEnv, ['PYTHONPATH=/opt/lib'], {
      mirrorUrl: null,
      patchHostDir: null
    })
    expect(spec.env).to.deep.equal(userEnv)
    expect(spec.mounts).to.deep.equal([])
  })

  it('injects HF_ENDPOINT and HF_HUB_DISABLE_XET with a mirror', () => {
    const spec = applyServiceHfMirror({ FOO: 'bar' }, undefined, {
      mirrorUrl: MIRROR,
      patchHostDir: null
    })
    expect(spec.env).to.deep.equal({
      FOO: 'bar',
      HF_ENDPOINT: MIRROR,
      HF_HUB_DISABLE_XET: '1'
    })
    expect(spec.mounts).to.deep.equal([])
    expect(spec.env).to.not.have.property('PYTHONPATH')
  })

  it("keeps the user's HF_ENDPOINT and then leaves HF_HUB_DISABLE_XET alone", () => {
    const spec = applyServiceHfMirror({ HF_ENDPOINT: 'https://huggingface.co' }, [], {
      mirrorUrl: MIRROR,
      patchHostDir: null
    })
    expect(spec.env).to.deep.equal({ HF_ENDPOINT: 'https://huggingface.co' })
  })

  it("keeps the user's HF_HUB_DISABLE_XET", () => {
    const spec = applyServiceHfMirror({ HF_HUB_DISABLE_XET: '0' }, [], {
      mirrorUrl: MIRROR,
      patchHostDir: null
    })
    expect(spec.env).to.deep.equal({ HF_ENDPOINT: MIRROR, HF_HUB_DISABLE_XET: '0' })
  })

  it('mounts the patch dir read-only at the fixed path', () => {
    const spec = applyServiceHfMirror({}, [], {
      mirrorUrl: MIRROR,
      patchHostDir: HOST_DIR
    })
    expect(spec.mounts).to.deep.equal([
      { Type: 'bind', Source: HOST_DIR, Target: HF_PATCH_CONTAINER_DIR, ReadOnly: true }
    ])
  })

  it('sets PYTHONPATH to the patch dir alone when the image has none', () => {
    const spec = applyServiceHfMirror({}, ['PATH=/usr/bin', 'LANG=C.UTF-8'], {
      mirrorUrl: MIRROR,
      patchHostDir: HOST_DIR
    })
    expect(spec.env.PYTHONPATH).to.equal(HF_PATCH_CONTAINER_DIR)
  })

  it("keeps the image's PYTHONPATH after the patch dir", () => {
    const spec = applyServiceHfMirror({}, ['PATH=/usr/bin', 'PYTHONPATH=/opt/a:/opt/b'], {
      mirrorUrl: MIRROR,
      patchHostDir: HOST_DIR
    })
    expect(spec.env.PYTHONPATH).to.equal(`${HF_PATCH_CONTAINER_DIR}:/opt/a:/opt/b`)
  })

  it("puts a user PYTHONPATH after the patch dir, replacing the image's as Docker does", () => {
    const spec = applyServiceHfMirror(
      { PYTHONPATH: '/work/src' },
      ['PYTHONPATH=/opt/a'],
      {
        mirrorUrl: MIRROR,
        patchHostDir: HOST_DIR
      }
    )
    expect(spec.env.PYTHONPATH).to.equal(`${HF_PATCH_CONTAINER_DIR}:/work/src`)
  })

  it('keeps the selected PYTHONPATH verbatim, empty components included', () => {
    // an empty component means "the working directory" — the image may rely on it
    expect(
      applyServiceHfMirror({}, ['PYTHONPATH=:/opt/a::'], {
        mirrorUrl: MIRROR,
        patchHostDir: HOST_DIR
      }).env.PYTHONPATH
    ).to.equal(`${HF_PATCH_CONTAINER_DIR}::/opt/a::`)
    expect(
      applyServiceHfMirror({ PYTHONPATH: '/w:' }, ['PYTHONPATH=/opt/a'], {
        mirrorUrl: MIRROR,
        patchHostDir: HOST_DIR
      }).env.PYTHONPATH
    ).to.equal(`${HF_PATCH_CONTAINER_DIR}:/w:`)
  })

  it('gives just the patch dir for an empty selected PYTHONPATH', () => {
    expect(
      applyServiceHfMirror({ PYTHONPATH: '' }, ['PYTHONPATH=/opt/a'], {
        mirrorUrl: MIRROR,
        patchHostDir: HOST_DIR
      }).env.PYTHONPATH
    ).to.equal(HF_PATCH_CONTAINER_DIR)
    expect(
      applyServiceHfMirror({}, ['PYTHONPATH='], {
        mirrorUrl: MIRROR,
        patchHostDir: HOST_DIR
      }).env.PYTHONPATH
    ).to.equal(HF_PATCH_CONTAINER_DIR)
  })

  it('skips the patch when the user sets OCEAN_HFPATCH=0', () => {
    const spec = applyServiceHfMirror({ OCEAN_HFPATCH: '0' }, ['PYTHONPATH=/opt/a'], {
      mirrorUrl: MIRROR,
      patchHostDir: HOST_DIR
    })
    expect(spec.mounts).to.deep.equal([])
    expect(spec.env).to.deep.equal({
      OCEAN_HFPATCH: '0',
      HF_ENDPOINT: MIRROR,
      HF_HUB_DISABLE_XET: '1'
    })
  })

  it('recognises only errors that name the patch mount', () => {
    expect(
      isHfPatchMountError(
        new Error(`bind source path does not exist: ${HOST_DIR}`),
        HOST_DIR
      )
    ).to.equal(true)
    expect(
      isHfPatchMountError(
        new Error(`error mounting "x" to rootfs at "${HF_PATCH_CONTAINER_DIR}"`),
        HOST_DIR
      )
    ).to.equal(true)
    expect(
      isHfPatchMountError(
        new Error('bind source path does not exist: /data/b1'),
        HOST_DIR
      )
    ).to.equal(false)
    expect(isHfPatchMountError(new Error('No such image'), HOST_DIR)).to.equal(false)
    expect(isHfPatchMountError(new Error(HOST_DIR), null)).to.equal(false)
  })

  it('does not mutate the user env', () => {
    const userEnv = { PYTHONPATH: '/x' }
    applyServiceHfMirror(userEnv, [], { mirrorUrl: MIRROR, patchHostDir: HOST_DIR })
    expect(userEnv).to.deep.equal({ PYTHONPATH: '/x' })
  })
})

describe('Service HF mirror: settings', () => {
  it('is off with no config', () => {
    expect(getServiceHfMirrorSettings(nodeConfig())).to.deep.equal({
      mirrorUrl: null,
      patch: false,
      patchHostDir: null,
      bucketsRoot: null
    })
  })

  it('turns the patch on with a mirror and uses the explicit dir', () => {
    expect(
      getServiceHfMirrorSettings(
        nodeConfig({ serviceHfMirrorUrl: MIRROR, serviceHfPatchDir: HOST_DIR })
      )
    ).to.deep.equal({
      mirrorUrl: MIRROR,
      patch: true,
      patchHostDir: HOST_DIR,
      bucketsRoot: null
    })
  })

  it('honours an explicit serviceHfClientPatch=false', () => {
    expect(
      getServiceHfMirrorSettings(
        nodeConfig({
          serviceHfMirrorUrl: MIRROR,
          serviceHfClientPatch: false,
          serviceHfPatchDir: HOST_DIR
        })
      )
    ).to.deep.equal({
      mirrorUrl: MIRROR,
      patch: false,
      patchHostDir: null,
      bucketsRoot: null
    })
  })

  it('allows the patch without a mirror when explicitly on', () => {
    expect(
      getServiceHfMirrorSettings(
        nodeConfig({ serviceHfClientPatch: true, serviceHfPatchDir: HOST_DIR })
      )
    ).to.deep.equal({
      mirrorUrl: null,
      patch: true,
      patchHostDir: HOST_DIR,
      bucketsRoot: null
    })
  })

  it('defaults the patch dir to <localfs persistent storage folder>/hfpatch, outside buckets/', () => {
    const config = nodeConfig({
      serviceHfMirrorUrl: MIRROR,
      persistentStorage: {
        enabled: true,
        type: 'localfs',
        accessLists: [],
        options: { folder: '/mnt/ocean-storage' }
      }
    })
    expect(resolveHfPatchHostDir(config)).to.equal('/mnt/ocean-storage/hfpatch')
    const settings = getServiceHfMirrorSettings(config)
    expect(settings.patchHostDir).to.equal('/mnt/ocean-storage/hfpatch')
    expect(settings.bucketsRoot).to.equal('/mnt/ocean-storage/buckets')
    const rel = path.relative(settings.bucketsRoot, settings.patchHostDir)
    expect(rel.startsWith('..')).to.equal(true)
  })

  it('prefers the explicit dir over the persistent storage folder', () => {
    const dir = resolveHfPatchHostDir(
      nodeConfig({
        serviceHfPatchDir: HOST_DIR,
        persistentStorage: {
          enabled: true,
          type: 'localfs',
          accessLists: [],
          options: { folder: '/mnt/ocean-storage' }
        }
      })
    )
    expect(dir).to.equal(HOST_DIR)
  })
})

describe('Service HF mirror: config parsing', () => {
  async function configWith(values: string[]) {
    const overrides = buildEnvOverrideConfig(
      [
        ENVIRONMENT_VARIABLES.SERVICE_HF_MIRROR_URL,
        ENVIRONMENT_VARIABLES.SERVICE_HF_CLIENT_PATCH,
        ENVIRONMENT_VARIABLES.SERVICE_HF_PATCH_DIR
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
    const config = await configWith([MIRROR, 'false', HOST_DIR])
    expect(config.serviceHfMirrorUrl).to.equal(MIRROR)
    expect(config.serviceHfClientPatch).to.equal(false)
    expect(config.serviceHfPatchDir).to.equal(HOST_DIR)
  })

  it('drops a non-http(s) mirror URL and a relative patch dir instead of failing', async () => {
    const config = await configWith(['ftp://mirror:21', '', 'relative/dir'])
    expect(config.serviceHfMirrorUrl).to.equal(undefined)
    expect(config.serviceHfClientPatch).to.equal(undefined)
    expect(config.serviceHfPatchDir).to.equal(undefined)
    expect(getServiceHfMirrorSettings(config).mirrorUrl).to.equal(null)
  })

  it('drops a mirror URL that does not parse', async () => {
    const config = await configWith(['not a url', 'true', HOST_DIR])
    expect(config.serviceHfMirrorUrl).to.equal(undefined)
    expect(config.serviceHfClientPatch).to.equal(true)
  })
})

/* eslint-disable security/detect-non-literal-fs-filename -- temp test paths */
describe('Service HF mirror: patch dir', () => {
  let tmp: string
  beforeEach(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ocean-hfpatch-test-')))
  })
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('ships the patch file where the node reads it at runtime', () => {
    expect(fs.existsSync(SHIPPED_HF_PATCH_PATH)).to.equal(true)
    expect(path.basename(SHIPPED_HF_PATCH_PATH)).to.equal(HF_PATCH_FILE_NAME)
  })

  it('writes the shipped patch with dir 0755 and file 0644', async () => {
    const dir = path.join(tmp, 'nested', 'hfpatch')
    expect(await prepareHfPatchDir(dir)).to.be.a('string')
    const file = path.join(dir, HF_PATCH_FILE_NAME)
    expect(fs.readFileSync(file).equals(fs.readFileSync(SHIPPED_HF_PATCH_PATH))).to.equal(
      true
    )
    expect(fs.statSync(dir).mode & 0o777).to.equal(0o755)
    expect(fs.statSync(file).mode & 0o777).to.equal(0o644)
    // no temp files left behind
    expect(fs.readdirSync(dir)).to.deep.equal([HF_PATCH_FILE_NAME])
  })

  it('leaves a matching file alone and replaces a stale one', async () => {
    const content = Buffer.from('print("patch")\n')
    const file = path.join(tmp, HF_PATCH_FILE_NAME)
    expect(await prepareHfPatchDir(tmp, { content })).to.be.a('string')
    const { ino } = fs.statSync(file)
    expect(await prepareHfPatchDir(tmp, { content })).to.be.a('string')
    expect(fs.statSync(file).ino).to.equal(ino)

    fs.writeFileSync(file, 'stale')
    expect(await prepareHfPatchDir(tmp, { content })).to.be.a('string')
    expect(fs.readFileSync(file, 'utf8')).to.equal('print("patch")\n')
  })

  it('returns false instead of throwing when the dir cannot be created', async () => {
    const blocker = path.join(tmp, 'file')
    fs.writeFileSync(blocker, 'x')
    expect(await prepareHfPatchDir(path.join(blocker, 'hfpatch'))).to.equal(null)
  })

  it('plans a start without the patch when the dir cannot be prepared', async () => {
    const blocker = path.join(tmp, 'file')
    fs.writeFileSync(blocker, 'x')
    const readImageEnv = sinon.stub().resolves(['PYTHONPATH=/opt/a'])
    const plan = await buildServiceHfPlan(
      {
        mirrorUrl: MIRROR,
        patch: true,
        patchHostDir: path.join(blocker, 'hfpatch'),
        bucketsRoot: null
      },
      { FOO: 'bar' },
      readImageEnv,
      'svc-1'
    )
    expect(plan.env).to.deep.equal({
      FOO: 'bar',
      HF_ENDPOINT: MIRROR,
      HF_HUB_DISABLE_XET: '1'
    })
    expect(plan.mounts).to.deep.equal([])
    expect(plan.withoutPatch).to.equal(null)
    expect(readImageEnv.called).to.equal(false)
  })

  it('plans a start without the patch when the image env cannot be read', async () => {
    const plan = await buildServiceHfPlan(
      { mirrorUrl: MIRROR, patch: true, patchHostDir: tmp, bucketsRoot: null },
      {},
      () => Promise.reject(new Error('no such image')),
      'svc-1'
    )
    expect(plan.mounts).to.deep.equal([])
    expect(plan.env).to.not.have.property('PYTHONPATH')
    expect(plan.withoutPatch).to.equal(null)
  })

  it('plans the patched start with an unpatched fallback', async () => {
    const plan = await buildServiceHfPlan(
      { mirrorUrl: MIRROR, patch: true, patchHostDir: tmp, bucketsRoot: null },
      {},
      () => Promise.resolve(['PYTHONPATH=/opt/a']),
      'svc-1'
    )
    expect(plan.env.PYTHONPATH).to.equal(`${HF_PATCH_CONTAINER_DIR}:/opt/a`)
    expect(plan.mounts).to.have.length(1)
    expect(plan.patchHostDir).to.equal(tmp)
    expect(plan.withoutPatch).to.deep.equal({
      env: { HF_ENDPOINT: MIRROR, HF_HUB_DISABLE_XET: '1' },
      mounts: []
    })
  })

  it('plans no change at all when the feature is off', async () => {
    const readImageEnv = sinon.stub().resolves([])
    const plan = await buildServiceHfPlan(
      { mirrorUrl: null, patch: false, patchHostDir: null, bucketsRoot: null },
      { FOO: 'bar' },
      readImageEnv,
      'svc-1'
    )
    expect(plan).to.deep.equal({
      env: { FOO: 'bar' },
      mounts: [],
      patchHostDir: null,
      withoutPatch: null
    })
    expect(readImageEnv.called).to.equal(false)
  })
})

/* eslint-enable security/detect-non-literal-fs-filename */

/* eslint-disable security/detect-non-literal-fs-filename -- temp test paths */
describe('Service HF mirror: patch dir trust', () => {
  const content = Buffer.from('print("patch")\n')
  let tmp: string
  beforeEach(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ocean-hfpatch-trust-')))
  })
  afterEach(() => {
    sinon.restore()
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('degrades when the shipped patch file is missing', async () => {
    const dir = path.join(tmp, 'hfpatch')
    const shippedPath = path.join(tmp, 'missing', HF_PATCH_FILE_NAME)
    expect(await prepareHfPatchDir(dir, { shippedPath })).to.equal(null)
    expect(fs.existsSync(path.join(dir, HF_PATCH_FILE_NAME))).to.equal(false)
  })

  it('resolves a symlinked patch dir and returns (and writes into) the canonical dir', async () => {
    const real = path.join(tmp, 'real')
    fs.mkdirSync(real, { mode: 0o755 })
    const link = path.join(tmp, 'link')
    fs.symlinkSync(real, link)
    expect(await prepareHfPatchDir(link, { content })).to.equal(real)
    expect(fs.readdirSync(real)).to.deep.equal([HF_PATCH_FILE_NAME])
  })

  it('tightens a node-owned 0777 dir to 0755', async () => {
    const dir = path.join(tmp, 'hfpatch')
    fs.mkdirSync(dir)
    fs.chmodSync(dir, 0o777)
    expect(await prepareHfPatchDir(dir, { content })).to.be.a('string')
    expect(fs.statSync(dir).mode & 0o7777).to.equal(0o755)
  })

  it('skips the patch when the dir mode cannot be fixed (chmod EPERM)', async () => {
    const dir = path.join(tmp, 'hfpatch')
    fs.mkdirSync(dir)
    fs.chmodSync(dir, 0o777)
    const eperm: any = new Error('EPERM: operation not permitted')
    eperm.code = 'EPERM'
    sinon.stub(fsp, 'chmod').rejects(eperm)
    expect(await prepareHfPatchDir(dir, { content })).to.equal(null)
    expect(fs.existsSync(path.join(dir, HF_PATCH_FILE_NAME))).to.equal(false)
  })

  it('rejects a dir owned by another uid', async () => {
    const dir = path.join(tmp, 'hfpatch')
    fs.mkdirSync(dir, { mode: 0o755 })
    const realLstat = fsp.lstat.bind(fsp)
    sinon.stub(fsp, 'lstat').callsFake(async (p: any) => {
      const st: any = await realLstat(p)
      if (path.resolve(String(p)) !== dir) return st
      // a Stats look-alike: own fields copied, isDirectory() & co. from the prototype
      return Object.assign(Object.create(Object.getPrototypeOf(st)), st, { uid: 4242 })
    })
    expect(await prepareHfPatchDir(dir, { content })).to.equal(null)
    expect(fs.existsSync(path.join(dir, HF_PATCH_FILE_NAME))).to.equal(false)
  })

  it('rejects a dir under a world-writable, non-sticky ancestor', async () => {
    const open = path.join(tmp, 'open')
    fs.mkdirSync(open)
    fs.chmodSync(open, 0o777)
    expect(await prepareHfPatchDir(path.join(open, 'hfpatch'), { content })).to.equal(
      null
    )
  })

  it('accepts a dir under a world-writable sticky ancestor (/tmp style)', async () => {
    const sticky = path.join(tmp, 'sticky')
    fs.mkdirSync(sticky)
    fs.chmodSync(sticky, 0o1777)
    expect(await prepareHfPatchDir(path.join(sticky, 'hfpatch'), { content })).to.equal(
      path.join(sticky, 'hfpatch')
    )
  })

  it('rejects a patch dir inside the buckets tree without creating it', async () => {
    const bucketsRoot = path.join(tmp, 'storage', 'buckets')
    fs.mkdirSync(bucketsRoot, { recursive: true })
    const dir = path.join(bucketsRoot, 'hfpatch')
    expect(await prepareHfPatchDir(dir, { content, bucketsRoot })).to.equal(null)
    expect(fs.existsSync(dir)).to.equal(false)
  })

  it('rejects a patch dir that resolves into the buckets tree through a symlink', async () => {
    const bucketsRoot = path.join(tmp, 'storage', 'buckets')
    fs.mkdirSync(bucketsRoot, { recursive: true })
    const alias = path.join(tmp, 'alias')
    fs.symlinkSync(bucketsRoot, alias)
    expect(
      await prepareHfPatchDir(path.join(alias, 'hfpatch'), { content, bucketsRoot })
    ).to.equal(null)
  })

  it('accepts the default sibling of the buckets tree', async () => {
    const storage = path.join(tmp, 'storage')
    fs.mkdirSync(path.join(storage, 'buckets'), { recursive: true })
    expect(
      await prepareHfPatchDir(path.join(storage, 'hfpatch'), {
        content,
        bucketsRoot: path.join(storage, 'buckets')
      })
    ).to.be.a('string')
  })

  it('replaces a planted symlink instead of writing through it', async () => {
    const dir = path.join(tmp, 'hfpatch')
    fs.mkdirSync(dir, { mode: 0o755 })
    const outside = path.join(tmp, 'outside.py')
    fs.writeFileSync(outside, 'untouched')
    fs.symlinkSync(outside, path.join(dir, HF_PATCH_FILE_NAME))
    expect(await prepareHfPatchDir(dir, { content })).to.be.a('string')
    const file = path.join(dir, HF_PATCH_FILE_NAME)
    expect(fs.lstatSync(file).isSymbolicLink()).to.equal(false)
    expect(fs.readFileSync(file, 'utf8')).to.equal('print("patch")\n')
    expect(fs.readFileSync(outside, 'utf8')).to.equal('untouched')
  })

  it('rewrites a matching file whose mode is group/other writable', async () => {
    const dir = path.join(tmp, 'hfpatch')
    fs.mkdirSync(dir, { mode: 0o755 })
    fs.chmodSync(dir, 0o755)
    const file = path.join(dir, HF_PATCH_FILE_NAME)
    fs.writeFileSync(file, content)
    fs.chmodSync(file, 0o666)
    expect(await prepareHfPatchDir(dir, { content })).to.be.a('string')
    expect(fs.statSync(file).mode & 0o7777).to.equal(0o644)
  })

  it('handles concurrent preparations of the same dir', async () => {
    const dir = path.join(tmp, 'hfpatch')
    const results = await Promise.all(
      Array.from({ length: 8 }, () => prepareHfPatchDir(dir, { content }))
    )
    expect(results).to.deep.equal(Array(8).fill(dir))
    expect(fs.readdirSync(dir)).to.deep.equal([HF_PATCH_FILE_NAME])
    expect(fs.readFileSync(path.join(dir, HF_PATCH_FILE_NAME), 'utf8')).to.equal(
      'print("patch")\n'
    )
  })
})

/* eslint-disable security/detect-non-literal-fs-filename -- temp test paths */
describe('Service HF mirror: patch dir trust (group write, canonical path)', () => {
  const content = Buffer.from('print("patch")\n')
  let tmp: string
  beforeEach(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ocean-hfpatch-trust2-')))
  })
  afterEach(() => {
    sinon.restore()
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  // Presents `target` to lstat with other ownership/mode bits (a Stats look-alike: own
  // fields overridden, isDirectory() & co. from the real prototype).
  function fakeLstat(
    target: string,
    fields: { uid?: number; gid?: number; perm?: number }
  ) {
    const realLstat = fsp.lstat.bind(fsp)
    sinon.stub(fsp, 'lstat').callsFake(async (p: any) => {
      const st: any = await realLstat(p)
      if (path.resolve(String(p)) !== target) return st
      const over: any = { ...fields }
      delete over.perm
      if (fields.perm !== undefined) over.mode = (st.mode & ~0o7777) | fields.perm
      return Object.assign(Object.create(Object.getPrototypeOf(st)), st, over)
    })
  }

  it('rejects a root-owned 0775 ancestor with a foreign group', async () => {
    const shared = path.join(tmp, 'shared')
    fs.mkdirSync(shared, { mode: 0o755 })
    fakeLstat(shared, { uid: 0, gid: 77, perm: 0o775 })
    const dir = path.join(shared, 'hfpatch')
    expect(await prepareHfPatchDir(dir, { content })).to.equal(null)
    expect(fs.existsSync(path.join(dir, HF_PATCH_FILE_NAME))).to.equal(false)
  })

  it('rejects a node-owned group-writable ancestor (group membership is not inferred)', async () => {
    const shared = path.join(tmp, 'shared')
    fs.mkdirSync(shared)
    fs.chmodSync(shared, 0o775)
    expect(await prepareHfPatchDir(path.join(shared, 'hfpatch'), { content })).to.equal(
      null
    )
  })

  it('accepts a root-owned 1777 ancestor when the child is node-owned and 0755', async () => {
    const sticky = path.join(tmp, 'sticky')
    fs.mkdirSync(sticky)
    fs.chmodSync(sticky, 0o1777)
    fakeLstat(sticky, { uid: 0, gid: 0 })
    const dir = path.join(sticky, 'hfpatch')
    expect(await prepareHfPatchDir(dir, { content })).to.equal(dir)
    expect(fs.statSync(dir).mode & 0o7777).to.equal(0o755)
  })

  it('rejects a sticky ancestor whose child is not node- or root-owned', async () => {
    const sticky = path.join(tmp, 'sticky')
    fs.mkdirSync(sticky)
    fs.chmodSync(sticky, 0o1777)
    const mid = path.join(sticky, 'mid')
    fs.mkdirSync(mid, { mode: 0o755 })
    fakeLstat(mid, { uid: 4242 })
    expect(await prepareHfPatchDir(path.join(mid, 'hfpatch'), { content })).to.equal(null)
  })

  it('checks and returns the canonical dir behind an untrusted alias', async () => {
    // /untrusted is world-writable (not trustable); its `alias` symlink points into /safe
    const untrusted = path.join(tmp, 'untrusted')
    fs.mkdirSync(untrusted)
    fs.chmodSync(untrusted, 0o777)
    const safe = path.join(tmp, 'safe')
    fs.mkdirSync(safe, { mode: 0o755 })
    fs.symlinkSync(safe, path.join(untrusted, 'alias'))
    const configured = path.join(untrusted, 'alias', 'hfpatch')
    const lstat = sinon.spy(fsp, 'lstat')
    expect(await prepareHfPatchDir(configured, { content })).to.equal(
      path.join(safe, 'hfpatch')
    )
    // no check looked at the alias path
    const checked = lstat.getCalls().map((c) => path.resolve(String(c.args[0])))
    expect(checked.some((p) => p.startsWith(untrusted))).to.equal(false)
    expect(fs.existsSync(path.join(safe, 'hfpatch', HF_PATCH_FILE_NAME))).to.equal(true)
  })

  it('mounts the canonical dir, so retargeting the alias afterwards changes nothing', async () => {
    const untrusted = path.join(tmp, 'untrusted')
    fs.mkdirSync(untrusted)
    fs.chmodSync(untrusted, 0o777)
    const safe = path.join(tmp, 'safe')
    const evil = path.join(tmp, 'evil')
    fs.mkdirSync(path.join(evil, 'hfpatch'), { recursive: true })
    fs.writeFileSync(path.join(evil, 'hfpatch', HF_PATCH_FILE_NAME), 'import os  # evil')
    fs.mkdirSync(safe, { mode: 0o755 })
    const alias = path.join(untrusted, 'alias')
    fs.symlinkSync(safe, alias)
    const plan = await buildServiceHfPlan(
      {
        mirrorUrl: MIRROR,
        patch: true,
        patchHostDir: path.join(alias, 'hfpatch'),
        bucketsRoot: null
      },
      {},
      () => Promise.resolve([]),
      'svc-1'
    )
    const canonical = path.join(safe, 'hfpatch')
    expect(plan.patchHostDir).to.equal(canonical)
    expect(plan.mounts).to.deep.equal([
      { Type: 'bind', Source: canonical, Target: HF_PATCH_CONTAINER_DIR, ReadOnly: true }
    ])
    // the alias owner swaps the link after preparation: the mount Source still names /safe
    fs.unlinkSync(alias)
    fs.symlinkSync(evil, alias)
    expect(fs.realpathSync(plan.mounts[0].Source)).to.equal(canonical)
    expect(
      fs.readFileSync(path.join(plan.mounts[0].Source, HF_PATCH_FILE_NAME))
    ).to.deep.equal(fs.readFileSync(SHIPPED_HF_PATCH_PATH))
  })

  it('rejects an alias whose canonical dir has an untrusted ancestor', async () => {
    const open = path.join(tmp, 'open')
    fs.mkdirSync(path.join(open, 'target'), { recursive: true })
    fs.chmodSync(open, 0o777)
    const alias = path.join(tmp, 'alias')
    fs.symlinkSync(path.join(open, 'target'), alias)
    expect(await prepareHfPatchDir(path.join(alias, 'hfpatch'), { content })).to.equal(
      null
    )
  })
})
/* eslint-enable security/detect-non-literal-fs-filename */

/* eslint-disable security/detect-non-literal-fs-filename -- temp test paths */
// Drives the REAL service lifecycle paths (processServiceStart, restartService →
// doRestartService) with stubbed Docker / escrow / DB / key manager, and asserts what
// actually reaches docker.createContainer.
describe('Service HF mirror: service start and restart containers', () => {
  const OWNER = '0x0000000000000000000000000000000000000001'
  const SERVICE_ID = 'svc-hf-1'
  const IMAGE_ENV = ['PATH=/usr/bin', 'PYTHONPATH=/opt/img']
  let tmp: string

  beforeEach(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ocean-hfpatch-svc-')))
  })
  afterEach(() => {
    sinon.restore()
    fs.rmSync(tmp, { recursive: true, force: true })
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

  function stubContainer(id: string, startError?: Error) {
    return {
      id,
      start: startError ? sinon.stub().rejects(startError) : sinon.stub().resolves(),
      stop: sinon.stub().resolves(),
      remove: sinon.stub().resolves(),
      inspect: sinon.stub().resolves({ State: { Running: false } })
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

  const patchMount = (dir: string) => ({
    Type: 'bind',
    Source: dir,
    Target: HF_PATCH_CONTAINER_DIR,
    ReadOnly: true
  })

  for (const lifecycle of ['start', 'restart'] as const) {
    describe(lifecycle, () => {
      it('injects mirror env, PYTHONPATH and the read-only patch mount', async () => {
        const dir = path.join(tmp, 'hfpatch')
        const engine = makeEngine(
          { serviceHfMirrorUrl: MIRROR, serviceHfPatchDir: dir },
          { FOO: 'bar' },
          [stubContainer('c-new')]
        )
        const job = await run(lifecycle, engine)
        expect(job.status).to.equal(ServiceStatusNumber.Running)
        const call = engine.docker.createContainer.firstCall
        expect(envOf(call)).to.deep.equal({
          FOO: 'bar',
          HF_ENDPOINT: MIRROR,
          HF_HUB_DISABLE_XET: '1',
          PYTHONPATH: `${HF_PATCH_CONTAINER_DIR}:/opt/img`
        })
        expect(call.args[0].HostConfig.Mounts).to.deep.equal([patchMount(dir)])
        expect(call.args[0].HostConfig.NetworkMode).to.equal('net-1')
        expect(fs.existsSync(path.join(dir, HF_PATCH_FILE_NAME))).to.equal(true)
      })

      it('mounts the canonical dir when the configured path goes through a symlink', async () => {
        const safe = path.join(tmp, 'safe')
        fs.mkdirSync(safe, { mode: 0o755 })
        const alias = path.join(tmp, 'alias')
        fs.symlinkSync(safe, alias)
        const engine = makeEngine(
          { serviceHfMirrorUrl: MIRROR, serviceHfPatchDir: path.join(alias, 'hfpatch') },
          {},
          [stubContainer('c-new')]
        )
        const job = await run(lifecycle, engine)
        expect(job.status).to.equal(ServiceStatusNumber.Running)
        expect(
          engine.docker.createContainer.firstCall.args[0].HostConfig.Mounts
        ).to.deep.equal([patchMount(path.join(safe, 'hfpatch'))])
      })

      it('changes nothing when the feature is off', async () => {
        const engine = makeEngine({}, { FOO: 'bar', PYTHONPATH: '/work' }, [
          stubContainer('c-new')
        ])
        const job = await run(lifecycle, engine)
        expect(job.status).to.equal(ServiceStatusNumber.Running)
        const call = engine.docker.createContainer.firstCall
        expect(envOf(call)).to.deep.equal({ FOO: 'bar', PYTHONPATH: '/work' })
        expect(call.args[0].HostConfig.Mounts).to.deep.equal([])
        expect(engine.docker.getImage.called).to.equal(false)
      })

      it("keeps the user's HF_ENDPOINT and puts the user PYTHONPATH after the patch", async () => {
        const dir = path.join(tmp, 'hfpatch')
        const engine = makeEngine(
          { serviceHfMirrorUrl: MIRROR, serviceHfPatchDir: dir },
          { HF_ENDPOINT: 'https://huggingface.co', PYTHONPATH: '/work:' },
          [stubContainer('c-new')]
        )
        await run(lifecycle, engine)
        const call = engine.docker.createContainer.firstCall
        expect(envOf(call)).to.deep.equal({
          HF_ENDPOINT: 'https://huggingface.co',
          PYTHONPATH: `${HF_PATCH_CONTAINER_DIR}:/work:`
        })
        expect(call.args[0].HostConfig.Mounts).to.deep.equal([patchMount(dir)])
      })

      it('starts with the mirror env only when the patch dir cannot be prepared', async () => {
        const blocker = path.join(tmp, 'file')
        fs.writeFileSync(blocker, 'x')
        const engine = makeEngine(
          {
            serviceHfMirrorUrl: MIRROR,
            serviceHfPatchDir: path.join(blocker, 'hfpatch')
          },
          {},
          [stubContainer('c-new')]
        )
        const job = await run(lifecycle, engine)
        expect(job.status).to.equal(ServiceStatusNumber.Running)
        expect(engine.docker.createContainer.callCount).to.equal(1)
        const call = engine.docker.createContainer.firstCall
        expect(envOf(call)).to.deep.equal({
          HF_ENDPOINT: MIRROR,
          HF_HUB_DISABLE_XET: '1'
        })
        expect(call.args[0].HostConfig.Mounts).to.deep.equal([])
      })

      it('retries without the patch when Docker rejects the mount at create', async () => {
        const dir = path.join(tmp, 'hfpatch')
        const engine = makeEngine(
          { serviceHfMirrorUrl: MIRROR, serviceHfPatchDir: dir },
          {},
          []
        )
        const retry = stubContainer('c-retry')
        engine.docker.createContainer
          .onCall(0)
          .rejects(
            new Error(`invalid mount config: bind source path does not exist: ${dir}`)
          )
        engine.docker.createContainer.onCall(1).resolves(retry)
        const job = await run(lifecycle, engine)
        expect(job.status).to.equal(ServiceStatusNumber.Running)
        expect(job.containerId).to.equal('c-retry')
        const second = engine.docker.createContainer.secondCall
        expect(envOf(second)).to.deep.equal({
          HF_ENDPOINT: MIRROR,
          HF_HUB_DISABLE_XET: '1'
        })
        expect(second.args[0].HostConfig.Mounts).to.deep.equal([])
        expect(retry.start.calledOnce).to.equal(true)
      })

      it('removes the container and retries without the patch when start fails on the mount', async () => {
        const dir = path.join(tmp, 'hfpatch')
        const failed = stubContainer(
          'c-failed',
          new Error(
            `OCI runtime create failed: error mounting "${dir}" to rootfs at ` +
              `"${HF_PATCH_CONTAINER_DIR}": not a directory`
          )
        )
        const retry = stubContainer('c-retry')
        const engine = makeEngine(
          { serviceHfMirrorUrl: MIRROR, serviceHfPatchDir: dir },
          { FOO: 'bar' },
          [failed, retry]
        )
        const job = await run(lifecycle, engine)
        expect(job.status).to.equal(ServiceStatusNumber.Running)
        expect(job.containerId).to.equal('c-retry')
        expect(failed.remove.calledOnceWith({ force: true })).to.equal(true)
        expect(engine.docker.createContainer.callCount).to.equal(2)
        const first = engine.docker.createContainer.firstCall
        const second = engine.docker.createContainer.secondCall
        expect(first.args[0].HostConfig.Mounts).to.deep.equal([patchMount(dir)])
        expect(second.args[0].HostConfig.Mounts).to.deep.equal([])
        expect(envOf(second)).to.deep.equal({
          FOO: 'bar',
          HF_ENDPOINT: MIRROR,
          HF_HUB_DISABLE_XET: '1'
        })
        // everything else is built identically
        const { Env: e1, HostConfig: h1, ...rest1 } = first.args[0]
        const { Env: e2, HostConfig: h2, ...rest2 } = second.args[0]
        expect(rest2).to.deep.equal(rest1)
        expect({ ...h2, Mounts: [] }).to.deep.equal({ ...h1, Mounts: [] })
        expect(retry.start.calledOnce).to.equal(true)
      })

      it('leaves an unrelated start failure unchanged (no retry)', async () => {
        const dir = path.join(tmp, 'hfpatch')
        const failed = stubContainer(
          'c-failed',
          new Error('could not select device driver "nvidia"')
        )
        const engine = makeEngine(
          { serviceHfMirrorUrl: MIRROR, serviceHfPatchDir: dir },
          {},
          [failed]
        )
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
