import { expect } from 'chai'
import sinon from 'sinon'
import crypto from 'crypto'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  OceanNodeConfigSchema,
  ServiceModelCacheConfigSchema
} from '../../../utils/config/schemas.js'
import { writeFileAtomic } from '../../../utils/fsAtomic.js'
import {
  applyModelCacheEnv,
  getModelCacheMounts,
  isModelCacheMount,
  MODEL_CACHE_ENV,
  MODEL_CACHE_MOUNT_TARGET,
  type ModelCacheMountSource
} from '../../../components/modelCache/mounts.js'
import type {
  ModelCacheMountVerdict,
  ServiceModelCacheConfig
} from '../../../components/modelCache/types.js'
import { C2DEngineDocker } from '../../../components/c2d/compute_engine_docker.js'
import { OceanNode } from '../../../OceanNode.js'
import {
  loadServiceTemplates,
  type TemplateLoadDiagnostics
} from '../../../components/core/service/templateLoader.js'
import {
  ServiceStatusNumber,
  type ServiceJob
} from '../../../@types/C2D/ServiceOnDemand.js'
import type { DockerMountObject } from '../../../@types/PersistentStorage.js'

// The glue between the node-level model cache and the rest of the node: the config schema,
// the atomic config write, the service mount + env, the docker engine's create-time
// fallback (at both create sites), the template loader's diagnostics and the node-level
// manager on OceanNode.

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

const modeOf = (p: string): string => (fs.statSync(p).mode & 0o777).toString(8)
const readText = (p: string): string => fs.readFileSync(p, 'utf8')
const tempLeftovers = (dir: string): string[] =>
  fs.readdirSync(dir).filter((n) => n.includes('.tmp-'))
const isRoot = (): boolean => process.getuid?.() === 0

function errnoError(code: string, message = code): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: ${message}`), { code })
}

async function rejectionOf(p: Promise<unknown>): Promise<NodeJS.ErrnoException | null> {
  try {
    await p
  } catch (e) {
    return e
  }
  return null
}

// An engine whose daemon is on this host (a socket): the only kind that gets the cache.
function localDaemon(engine: any): any {
  engine.getC2DConfig = () => ({ connection: { socketPath: '/var/run/docker.sock' } })
  return engine
}

describe('model cache integration glue', () => {
  afterEach(() => sinon.restore())

  // ---------------------------------------------------------------------------------------
  describe('serviceModelCache config schema', () => {
    const ENABLED = { enabled: true, path: '/data/model-cache', maxSizeGb: 500 }

    function issuesOf(
      value: unknown
    ): Array<{ path: string; code: string; message: string }> {
      const r = ServiceModelCacheConfigSchema.safeParse(value)
      return r.success
        ? []
        : r.error.issues.map((i) => ({
            path: i.path.join('.'),
            code: i.code,
            message: i.message
          }))
    }
    const uniquePaths = (value: unknown): string[] => [
      ...new Set(issuesOf(value).map((i) => i.path))
    ]

    it('requires enabled, so a partial block fails instead of silently disabling', () => {
      expect(uniquePaths({})).to.deep.equal(['enabled'])
      expect(uniquePaths({ path: '/data/model-cache', maxSizeGb: 10 })).to.deep.equal([
        'enabled'
      ])
      expect(uniquePaths({ ...ENABLED, enabled: 'true' })).to.deep.equal(['enabled'])
    })

    it('requires path and maxSizeGb once enabled', () => {
      expect(uniquePaths({ enabled: true })).to.have.members(['path', 'maxSizeGb'])
      expect(uniquePaths({ enabled: true, path: '/data/model-cache' })).to.deep.equal([
        'maxSizeGb'
      ])
      expect(uniquePaths({ enabled: true, maxSizeGb: 10 })).to.deep.equal(['path'])
      expect(uniquePaths({ ...ENABLED, maxSizeGb: 0 })).to.deep.equal(['maxSizeGb'])
      expect(uniquePaths(ENABLED)).to.deep.equal([])
    })

    it('accepts a disabled block without path or size and applies every default', () => {
      const r = ServiceModelCacheConfigSchema.safeParse({ enabled: false })
      expect(r.success).to.equal(true)
      expect(r.data).to.deep.equal({
        enabled: false,
        minFreeGb: 100,
        fromTemplates: true,
        includeUnlisted: true,
        curated: [],
        syncIntervalMinutes: 60,
        gcGraceHours: 24
      })
    })

    it('applies the same defaults to an enabled block', () => {
      const r = ServiceModelCacheConfigSchema.safeParse(ENABLED)
      expect(r.success, JSON.stringify(r.error?.issues)).to.equal(true)
      expect(r.data).to.deep.equal({
        ...ENABLED,
        minFreeGb: 100,
        fromTemplates: true,
        includeUnlisted: true,
        curated: [],
        syncIntervalMinutes: 60,
        gcGraceHours: 24
      })
    })

    it('keeps explicit values over the defaults', () => {
      const explicit = {
        ...ENABLED,
        minFreeGb: 0,
        fromTemplates: false,
        includeUnlisted: false,
        curated: [{ repo: 'Qwen/Qwen3.8-27B-FP8' }],
        syncIntervalMinutes: 5,
        gcGraceHours: 1
      }
      const r = ServiceModelCacheConfigSchema.safeParse(explicit)
      expect(r.success).to.equal(true)
      expect(r.data).to.deep.include({
        minFreeGb: 0,
        fromTemplates: false,
        includeUnlisted: false,
        syncIntervalMinutes: 5,
        gcGraceHours: 1
      })
      expect(r.data.curated.map((c) => c.repo)).to.deep.equal(['Qwen/Qwen3.8-27B-FP8'])
    })

    it('enforces the documented numeric ranges', () => {
      const cases: Array<[string, number]> = [
        ['syncIntervalMinutes', 4],
        ['syncIntervalMinutes', 1441],
        ['syncIntervalMinutes', 7.5],
        ['gcGraceHours', 0.5],
        ['minFreeGb', -1],
        ['maxSizeGb', -5]
      ]
      for (const [key, value] of cases) {
        expect(
          uniquePaths({ ...ENABLED, [key]: value }),
          `${key}=${value}`
        ).to.deep.equal([key])
      }
      expect(
        uniquePaths({
          ...ENABLED,
          syncIntervalMinutes: 5,
          gcGraceHours: 1,
          minFreeGb: 0
        })
      ).to.deep.equal([])
      expect(uniquePaths({ ...ENABLED, syncIntervalMinutes: 1440 })).to.deep.equal([])
    })

    it('requires an absolute path', () => {
      for (const p of [
        'data/model-cache',
        './model-cache',
        '~/model-cache',
        'cache',
        ''
      ]) {
        expect(uniquePaths({ ...ENABLED, path: p }), JSON.stringify(p)).to.deep.equal([
          'path'
        ])
      }
    })

    it('refuses / and paths with . or .. segments', () => {
      for (const p of [
        '/',
        '/data/../etc',
        '/data/./model-cache',
        '/data/model-cache/..',
        '/..'
      ]) {
        expect(uniquePaths({ ...ENABLED, path: p }), p).to.deep.equal(['path'])
      }
    })

    // Design: "path absolute, normalized, not /". '//' and '///' ARE the filesystem root,
    // '/data//model-cache' normalizes to '/data/model-cache', and a trailing slash would make
    // the mount helper's configuredPath comparison depend on spelling.
    it('refuses paths that are not normalized (//, /a//b, trailing slash)', () => {
      for (const p of ['//', '///', '/data//model-cache', '/data/model-cache/']) {
        expect(uniquePaths({ ...ENABLED, path: p }), p).to.deep.equal(['path'])
      }
      for (const p of ['/data/model-cache', '/a', '/data/ocean-model-cache-v1']) {
        expect(uniquePaths({ ...ENABLED, path: p }), p).to.deep.equal([])
      }
    })

    it('checks the path syntax even while disabled', () => {
      expect(uniquePaths({ enabled: false, path: 'relative/dir' })).to.deep.equal([
        'path'
      ])
    })

    it('is strict: a misspelled top-level key fails loudly', () => {
      for (const extra of [
        { maxSizeGB: 10 },
        { allow_patterns: ['*.json'] },
        { curatd: [{ repo: 'org/name' }] },
        { syncIntervalMins: 30 }
      ]) {
        const codes = issuesOf({ ...ENABLED, ...extra }).map((i) => i.code)
        expect(codes, JSON.stringify(extra)).to.include('unrecognized_keys')
      }
    })

    it('is strict inside curated entries (allow_patterns, revison)', () => {
      for (const typo of [{ allow_patterns: ['*.json'] }, { revison: 'v1' }]) {
        const issues = issuesOf({
          ...ENABLED,
          curated: [{ repo: 'google/gemma-4-31B-it', ...typo }]
        })
        expect(
          issues.map((i) => [i.code, i.path]),
          JSON.stringify(typo)
        ).to.deep.include(['unrecognized_keys', 'curated.0'])
      }
    })

    describe('curated entries', () => {
      const curatedIssues = (entry: Record<string, unknown>) =>
        issuesOf({ ...ENABLED, curated: [entry] })
      const curatedPaths = (entry: Record<string, unknown>) => [
        ...new Set(curatedIssues(entry).map((i) => i.path))
      ]

      it('accepts well-formed entries', () => {
        const entries = [
          { repo: 'Qwen/Qwen3.8-27B-FP8' },
          {
            repo: 'google/gemma-4-31B-it',
            allowPatterns: ['*.json', '*.safetensors', 'tokenizer*']
          },
          {
            repo: 'Comfy-Org/Qwen-Image_ComfyUI',
            revision: 'main',
            files: ['split_files/vae/qwen_image_vae.safetensors'],
            priority: -1
          },
          { repo: 'zai-org/GLM-5.3-Flash', revision: 'v1.0', commit: 'a'.repeat(40) },
          { repo: 'a/b', revision: 'release_2026-10' }
        ]
        const r = ServiceModelCacheConfigSchema.safeParse({
          ...ENABLED,
          curated: entries
        })
        expect(r.success, JSON.stringify(r.error?.issues)).to.equal(true)
        expect(r.data.curated.map((c) => c.repo)).to.deep.equal(
          entries.map((e) => e.repo)
        )
        // revision defaults to 'main' (here or in the deriver), never to anything else
        expect(['main', undefined]).to.include(r.data.curated[0].revision)
      })

      it('validates the repo id with the Hub rules', () => {
        for (const repo of [
          'noslash',
          'a/b/c',
          'org/na--me',
          'org/name.git',
          'org/..',
          '../name',
          '-org/name',
          'org/name.',
          'org/',
          '/name',
          'org name/model',
          'org/' + 'm'.repeat(97),
          5
        ]) {
          expect(curatedPaths({ repo }), String(repo)).to.deep.equal(['curated.0.repo'])
        }
      })

      it('takes a ref name as revision, never a commit or a ref path', () => {
        for (const revision of [
          'refs/pr/1',
          'abc1234',
          '0123456789abcdef0123456789abcdef01234567',
          'a..b',
          '.hidden',
          '-x',
          '',
          'v1.0/beta',
          'r'.repeat(101)
        ]) {
          expect(curatedPaths({ repo: 'org/name', revision }), revision).to.deep.equal([
            'curated.0.revision'
          ])
        }
        for (const revision of ['main', 'v1.0', 'release-2026', 'fp8', '2024']) {
          expect(curatedPaths({ repo: 'org/name', revision }), revision).to.deep.equal([])
        }
      })

      it('requires commit to be a full lowercase sha', () => {
        for (const commit of [
          'A'.repeat(40),
          'a'.repeat(39),
          'a'.repeat(41),
          'g'.repeat(40),
          'main'
        ]) {
          expect(curatedPaths({ repo: 'org/name', commit }), commit).to.deep.equal([
            'curated.0.commit'
          ])
        }
      })

      it('takes allowPatterns or files, never both and neither empty', () => {
        const both = curatedIssues({
          repo: 'org/name',
          allowPatterns: ['*.json'],
          files: ['config.json']
        })
        expect(both.map((i) => i.path)).to.deep.equal(['curated.0.files'])
        expect(both[0].message).to.match(/either allowPatterns or files/)
        expect(curatedPaths({ repo: 'org/name', allowPatterns: [] })).to.deep.equal([
          'curated.0.allowPatterns'
        ])
        expect(curatedPaths({ repo: 'org/name', files: [] })).to.deep.equal([
          'curated.0.files'
        ])
        expect(curatedPaths({ repo: 'org/name', allowPatterns: [''] })).to.deep.equal([
          'curated.0.allowPatterns.0'
        ])
      })

      it('rejects every unsafe file path, naming its index', () => {
        const bad = [
          '../escape.safetensors',
          '/etc/passwd',
          'a//b.json',
          'a\\b.json',
          'a/./b.json',
          'a/../b.json',
          'x\u0000y',
          'tab\there',
          '',
          '.',
          'dir/',
          'n'.repeat(256)
        ]
        const issues = curatedIssues({
          repo: 'org/name',
          files: ['ok/model.safetensors', ...bad]
        })
        expect(issues.map((i) => i.path)).to.deep.equal(
          bad.map((_, i) => `curated.0.files.${i + 1}`)
        )
      })

      it('requires an integer priority', () => {
        expect(curatedPaths({ repo: 'org/name', priority: 1.5 })).to.deep.equal([
          'curated.0.priority'
        ])
        expect(curatedPaths({ repo: 'org/name', priority: -3 })).to.deep.equal([])
      })
    })

    describe('inside OceanNodeConfigSchema', () => {
      const BASE = {
        accountPurgatoryUrl: null as string | null,
        assetPurgatoryUrl: null as string | null,
        jwtSecret: 'test-secret',
        hasP2P: false
      }

      it('is optional', () => {
        const r = OceanNodeConfigSchema.safeParse(BASE)
        expect(r.success, JSON.stringify(r.error?.issues)).to.equal(true)
        expect(r.data.serviceModelCache).to.equal(undefined)
      })

      it('is nullable, so a push can clear it', () => {
        const r = OceanNodeConfigSchema.safeParse({ ...BASE, serviceModelCache: null })
        expect(r.success, JSON.stringify(r.error?.issues)).to.equal(true)
        expect(r.data.serviceModelCache).to.equal(null)
      })

      it('fails a node config whose block lacks enabled', () => {
        const r = OceanNodeConfigSchema.safeParse({
          ...BASE,
          serviceModelCache: { path: '/data/model-cache', maxSizeGb: 10 }
        })
        expect(r.success).to.equal(false)
        expect(r.error.issues.map((i) => i.path.join('.'))).to.include(
          'serviceModelCache.enabled'
        )
      })

      it('fails a node config whose block is enabled without a path', () => {
        const r = OceanNodeConfigSchema.safeParse({
          ...BASE,
          serviceModelCache: { enabled: true, maxSizeGb: 10 }
        })
        expect(r.success).to.equal(false)
        expect(r.error.issues.map((i) => i.path.join('.'))).to.include(
          'serviceModelCache.path'
        )
      })

      it('applies the cache defaults at node level', () => {
        const r = OceanNodeConfigSchema.safeParse({ ...BASE, serviceModelCache: ENABLED })
        expect(r.success, JSON.stringify(r.error?.issues)).to.equal(true)
        expect(r.data.serviceModelCache).to.deep.include({
          ...ENABLED,
          minFreeGb: 100,
          syncIntervalMinutes: 60,
          gcGraceHours: 24
        })
      })
    })
  })

  // ---------------------------------------------------------------------------------------
  describe('writeFileAtomic', () => {
    let dir: string
    let file: string
    const extraDirs: string[] = []
    beforeEach(() => {
      dir = tmpDir('mc-atomic-')
      file = path.join(dir, 'config.json')
    })
    afterEach(() => {
      fs.rmSync(dir, { recursive: true, force: true })
      for (const d of extraDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
    })

    // The temp name is .<base>.tmp-<pid>-<random uuid> next to the (resolved) target. Pin the
    // uuid so a test can plant something at the exact name the next write will use.
    const FIXED_UUID = '00000000-0000-4000-8000-000000000000'
    function pinTempName(target: string): string {
      sinon.stub(crypto, 'randomUUID').returns(FIXED_UUID)
      const real = fs.realpathSync(target)
      return path.join(
        path.dirname(real),
        `.${path.basename(real)}.tmp-${process.pid}-${FIXED_UUID}`
      )
    }

    it('replaces the content of an existing file', async () => {
      fs.writeFileSync(file, 'old')
      await writeFileAtomic(file, 'new')
      expect(readText(file)).to.equal('new')
      await writeFileAtomic(file, Buffer.from('bytes'))
      expect(readText(file)).to.equal('bytes')
      expect(tempLeftovers(dir)).to.deep.equal([])
    })

    it('replaces the file by rename (a new inode), so a reader never sees a torn file', async () => {
      fs.writeFileSync(file, 'old')
      const before = fs.statSync(file).ino
      await writeFileAtomic(file, 'new')
      expect(fs.statSync(file).ino).to.not.equal(before)
    })

    it('creates a missing file with mode 0644', async () => {
      await writeFileAtomic(file, '{}')
      expect(readText(file)).to.equal('{}')
      expect(modeOf(file)).to.equal('644')
      expect(fs.readdirSync(dir)).to.deep.equal(['config.json'])
    })

    it('keeps a config locked down to 0600 at 0600', async () => {
      fs.writeFileSync(file, 'old')
      fs.chmodSync(file, 0o600)
      await writeFileAtomic(file, 'new')
      expect(readText(file)).to.equal('new')
      expect(modeOf(file)).to.equal('600')
    })

    it('lets an explicit mode win over the existing one', async () => {
      fs.writeFileSync(file, 'old')
      fs.chmodSync(file, 0o600)
      await writeFileAtomic(file, 'new', { mode: 0o644 })
      expect(modeOf(file)).to.equal('644')
    })

    // open(2)'s mode is filtered through the umask; the original mode must survive anyway
    // (fchmod after the open is not).
    it('keeps a group-writable mode (0664) that the process umask (022) would mask', async () => {
      fs.writeFileSync(file, 'old')
      fs.chmodSync(file, 0o664)
      await writeFileAtomic(file, 'new')
      expect(modeOf(file)).to.equal('664')
    })

    // index.json and refs/ are written with mode 0644 for the service containers (the
    // consumer contract); a restrictive umask must not turn them into 0600.
    it('creates files with exactly the requested 0644 under a restrictive umask', async () => {
      const implicit = path.join(dir, 'implicit.json')
      const explicit = path.join(dir, 'index.json')
      const previous = process.umask(0o077)
      try {
        await writeFileAtomic(implicit, '{}')
        await writeFileAtomic(explicit, '{}', { mode: 0o644 })
      } finally {
        process.umask(previous)
      }
      expect(modeOf(implicit), 'default mode').to.equal('644')
      expect(modeOf(explicit), 'explicit mode').to.equal('644')
    })

    it('refuses a file planted at its temp name (O_EXCL) and leaves everything alone', async () => {
      fs.writeFileSync(file, 'first')
      const planted = pinTempName(file)
      fs.writeFileSync(planted, 'planted')
      const error = await rejectionOf(writeFileAtomic(file, 'second'))
      expect(error?.code).to.equal('EEXIST')
      expect(readText(file)).to.equal('first')
      expect(readText(planted)).to.equal('planted')
    })

    it('never follows a symlink planted at its temp name (existing or dangling target)', async () => {
      const outside = tmpDir('mc-atomic-outside-')
      extraDirs.push(outside)
      const victim = path.join(outside, 'victim')
      fs.writeFileSync(victim, 'victim')
      fs.chmodSync(victim, 0o600)
      fs.writeFileSync(file, 'first')
      const planted = pinTempName(file)

      fs.symlinkSync(victim, planted)
      let error = await rejectionOf(writeFileAtomic(file, 'second'))
      expect(error?.code, 'existing target').to.equal('EEXIST')
      expect(readText(victim)).to.equal('victim')
      expect(modeOf(victim)).to.equal('600')
      expect(readText(file)).to.equal('first')

      // a dangling link must not create its target either
      const dangling = path.join(outside, 'created-through-link')
      fs.unlinkSync(planted)
      fs.symlinkSync(dangling, planted)
      error = await rejectionOf(writeFileAtomic(file, 'third'))
      expect(error?.code, 'dangling target').to.equal('EEXIST')
      expect(fs.existsSync(dangling)).to.equal(false)
      expect(readText(file)).to.equal('first')
    })

    for (const code of ['EBUSY', 'EXDEV', 'EPERM']) {
      it(`writes in place when the rename is refused with ${code} and fallbackInPlace is set`, async () => {
        fs.writeFileSync(file, 'old')
        fs.chmodSync(file, 0o600)
        const inode = fs.statSync(file).ino
        const rename = sinon.stub(fs.promises, 'rename').rejects(errnoError(code))
        await writeFileAtomic(file, 'new', { fallbackInPlace: true })
        expect(rename.calledOnce).to.equal(true)
        expect(readText(file)).to.equal('new')
        expect(fs.statSync(file).ino, 'same inode: written in place').to.equal(inode)
        expect(modeOf(file)).to.equal('600')
        expect(tempLeftovers(dir)).to.deep.equal([])
      })
    }

    it('throws the rename error without fallbackInPlace (target untouched, temp removed)', async () => {
      fs.writeFileSync(file, 'old')
      sinon.stub(fs.promises, 'rename').rejects(errnoError('EBUSY'))
      const error = await rejectionOf(writeFileAtomic(file, 'new'))
      expect(error?.code).to.equal('EBUSY')
      expect(readText(file)).to.equal('old')
      expect(tempLeftovers(dir)).to.deep.equal([])
    })

    it('does not fall back on other rename errors', async () => {
      fs.writeFileSync(file, 'old')
      sinon.stub(fs.promises, 'rename').rejects(errnoError('EIO'))
      const error = await rejectionOf(
        writeFileAtomic(file, 'new', { fallbackInPlace: true })
      )
      expect(error?.code).to.equal('EIO')
      expect(readText(file)).to.equal('old')
      expect(tempLeftovers(dir)).to.deep.equal([])
    })

    // The node image's /usr/src/app is root-owned while config.json may be the node's: no
    // temp file can be created next to it, so pushConfig keeps working by writing in place.
    it('writes in place when no temp file can be created next to the target', async function () {
      if (isRoot()) this.skip() // root creates files in a 0555 dir
      fs.writeFileSync(file, 'old')
      fs.chmodSync(dir, 0o555)
      try {
        await writeFileAtomic(file, 'new', { fallbackInPlace: true })
        expect(readText(file)).to.equal('new')
        const error = await rejectionOf(writeFileAtomic(file, 'newer'))
        expect(error?.code, 'without fallbackInPlace').to.equal('EACCES')
        expect(readText(file)).to.equal('new')
      } finally {
        fs.chmodSync(dir, 0o755)
      }
    })

    it('fails (no fallback) when the target directory does not exist', async () => {
      const missing = path.join(dir, 'nope', 'config.json')
      const error = await rejectionOf(
        writeFileAtomic(missing, '{}', { fallbackInPlace: true })
      )
      expect(error?.code).to.equal('ENOENT')
      expect(fs.existsSync(path.dirname(missing))).to.equal(false)
    })

    // The writer this replaced (fs.promises.writeFile on the config path) followed a
    // symlinked config; a bare rename() would replace the link with a regular file, so the
    // operator's real file would go stale and later edits to it would never be seen.
    it('writes through a symlinked target and keeps the link', async () => {
      const realDir = tmpDir('mc-atomic-real-')
      extraDirs.push(realDir)
      const real = path.join(realDir, 'config.json')
      fs.writeFileSync(real, 'old')
      fs.chmodSync(real, 0o600)
      fs.symlinkSync(real, file)
      await writeFileAtomic(file, 'new')
      expect(fs.lstatSync(file).isSymbolicLink(), 'link kept').to.equal(true)
      expect(readText(real), 'real file updated').to.equal('new')
      expect(modeOf(real), 'real file mode kept').to.equal('600')
      expect(tempLeftovers(dir)).to.deep.equal([])
      expect(tempLeftovers(realDir)).to.deep.equal([])
    })

    it('removes its temp file when writing it fails (e.g. ENOSPC)', async () => {
      fs.writeFileSync(file, 'old')
      const realOpen = fs.promises.open
      sinon
        .stub(fs.promises, 'open')
        .callsFake(async (p: fs.PathLike, flags?: string | number, mode?: fs.Mode) => {
          const fh = await realOpen(p, flags, mode)
          if (flags === 'wx') {
            ;(fh as any).writeFile = () => Promise.reject(errnoError('ENOSPC'))
          }
          return fh
        })
      const error = await rejectionOf(writeFileAtomic(file, 'new'))
      expect(error?.code).to.equal('ENOSPC')
      expect(readText(file)).to.equal('old')
      expect(tempLeftovers(dir)).to.deep.equal([])
    })
  })

  // ---------------------------------------------------------------------------------------
  describe('model cache mounts', () => {
    let root: string
    let pub: string
    let verdict: ModelCacheMountVerdict
    let broken: boolean
    let cfg: ServiceModelCacheConfig
    let source: ModelCacheMountSource

    beforeEach(() => {
      root = tmpDir('mc-mounts-')
      pub = path.join(root, 'public')
      fs.mkdirSync(pub)
      const st = fs.lstatSync(pub)
      cfg = { enabled: true, path: root, maxSizeGb: 10 }
      verdict = { configuredPath: root, publicRealpath: pub, dev: st.dev, ino: st.ino }
      broken = false
      source = { getMountVerdict: () => verdict, isMountBroken: () => broken }
    })
    afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

    it('uses the fixed consumer contract (target and variable)', () => {
      expect(MODEL_CACHE_MOUNT_TARGET).to.equal('/ocean/model-cache')
      expect(MODEL_CACHE_ENV).to.equal('OCEAN_MODEL_CACHE')
    })

    it('mounts the verified public dir read-only, non-recursive, at /ocean/model-cache', async () => {
      const mounts = await getModelCacheMounts(cfg, source)
      expect(mounts).to.have.length(1)
      const [m] = mounts
      expect(m).to.deep.include({
        Type: 'bind',
        Source: pub,
        Target: '/ocean/model-cache',
        ReadOnly: true
      })
      expect(m.BindOptions?.NonRecursive).to.equal(true)
      // Docker's default; anything shared/slave would leak mount events
      expect(m.BindOptions?.Propagation ?? 'rprivate').to.equal('rprivate')
      expect(Object.keys(m).sort()).to.deep.equal(
        ['BindOptions', 'ReadOnly', 'Source', 'Target', 'Type'].sort()
      )
      expect(isModelCacheMount(m)).to.equal(true)
      expect(
        isModelCacheMount({ Type: 'bind', Source: pub, Target: '/data', ReadOnly: false })
      ).to.equal(false)
    })

    it('mounts the public dir only, never the cache root (private/ stays node-only)', async () => {
      const [m] = await getModelCacheMounts(cfg, source)
      expect(m.Source).to.equal(verdict.publicRealpath)
      expect(m.Source).to.not.equal(root)
    })

    it('mounts nothing while the cache is absent or disabled', async () => {
      expect(await getModelCacheMounts(undefined, source)).to.deep.equal([])
      expect(await getModelCacheMounts(null, source)).to.deep.equal([])
      expect(await getModelCacheMounts({ ...cfg, enabled: false }, source)).to.deep.equal(
        []
      )
    })

    it('mounts nothing without a manager', async () => {
      expect(await getModelCacheMounts(cfg, null)).to.deep.equal([])
      expect(await getModelCacheMounts(cfg, undefined)).to.deep.equal([])
    })

    it('mounts nothing before the manager has verified the root', async () => {
      verdict = null
      expect(await getModelCacheMounts(cfg, source)).to.deep.equal([])
    })

    it('mounts nothing when the verdict is for another configured path', async () => {
      expect(
        await getModelCacheMounts({ ...cfg, path: path.join(root, 'elsewhere') }, source)
      ).to.deep.equal([])
      expect(
        await getModelCacheMounts({ ...cfg, path: undefined }, source)
      ).to.deep.equal([])
    })

    it('mounts nothing while the mount is flagged broken', async () => {
      broken = true
      expect(await getModelCacheMounts(cfg, source)).to.deep.equal([])
      broken = false
      expect(await getModelCacheMounts(cfg, source)).to.have.length(1)
    })

    it('mounts nothing once the verified dir was replaced (dev/ino changed)', async () => {
      fs.renameSync(pub, `${pub}.old`) // keeps the old inode alive, so the new one differs
      fs.mkdirSync(pub)
      expect(await getModelCacheMounts(cfg, source)).to.deep.equal([])
    })

    it('mounts nothing when the verdict names another inode or device', async () => {
      verdict = { ...verdict, ino: verdict.ino + 1 }
      expect(await getModelCacheMounts(cfg, source)).to.deep.equal([])
      const st = fs.lstatSync(pub)
      verdict = { ...verdict, ino: st.ino, dev: st.dev + 1 }
      expect(await getModelCacheMounts(cfg, source)).to.deep.equal([])
    })

    it('mounts nothing when the verified dir became a symlink, even to itself', async () => {
      fs.renameSync(pub, `${pub}.real`)
      fs.symlinkSync(`${pub}.real`, pub)
      expect(await getModelCacheMounts(cfg, source)).to.deep.equal([])
    })

    it('mounts nothing when the verified dir is gone or is now a file', async () => {
      fs.rmSync(pub, { recursive: true })
      expect(await getModelCacheMounts(cfg, source)).to.deep.equal([])
      fs.writeFileSync(pub, 'not a dir')
      expect(await getModelCacheMounts(cfg, source)).to.deep.equal([])
    })

    it('never throws: a failing manager means no mount', async () => {
      const throwsVerdict: ModelCacheMountSource = {
        getMountVerdict: () => {
          throw new Error('boom')
        },
        isMountBroken: () => false
      }
      const throwsBroken: ModelCacheMountSource = {
        getMountVerdict: () => verdict,
        isMountBroken: () => {
          throw new Error('boom')
        }
      }
      expect(await getModelCacheMounts(cfg, throwsVerdict)).to.deep.equal([])
      expect(await getModelCacheMounts(cfg, throwsBroken)).to.deep.equal([])
    })

    describe('applyModelCacheEnv', () => {
      it('drops a user-supplied value when the cache is not mounted', () => {
        const env = { OCEAN_MODEL_CACHE: '/home/user/fake', HF_HOME: '/data/hf' }
        applyModelCacheEnv(env, false)
        expect(env).to.deep.equal({ HF_HOME: '/data/hf' })
      })

      it('replaces a user-supplied value with the mount target when mounted', () => {
        const env: Record<string, string> = { OCEAN_MODEL_CACHE: '/home/user/fake' }
        applyModelCacheEnv(env, true)
        expect(env).to.deep.equal({ OCEAN_MODEL_CACHE: '/ocean/model-cache' })
        const other: Record<string, string> = { A: '1' }
        applyModelCacheEnv(other, true)
        expect(other).to.deep.equal({ A: '1', OCEAN_MODEL_CACHE: '/ocean/model-cache' })
      })

      it('sets nothing when not mounted and nothing was supplied', () => {
        const env: Record<string, string> = { A: '1' }
        applyModelCacheEnv(env, false)
        expect(env).to.deep.equal({ A: '1' })
      })

      it('leaves similarly named variables alone', () => {
        const env = { OCEAN_MODEL_CACHE_DIR: 'x', ocean_model_cache: 'y' }
        applyModelCacheEnv(env, false)
        expect(env).to.deep.equal({ OCEAN_MODEL_CACHE_DIR: 'x', ocean_model_cache: 'y' })
      })
    })
  })

  // ---------------------------------------------------------------------------------------
  describe('docker engine: service containers and the model cache', () => {
    const DOCKERD_REFUSAL =
      'invalid mount config for type "bind": bind source path does not exist: /srv/model-cache/public'
    const CACHE_MOUNT: DockerMountObject = {
      Type: 'bind',
      Source: '/srv/model-cache/public',
      Target: MODEL_CACHE_MOUNT_TARGET,
      ReadOnly: true,
      BindOptions: { Propagation: 'rprivate', NonRecursive: true }
    }
    const BUCKET_MOUNT: DockerMountObject = {
      Type: 'bind',
      Source: '/srv/buckets/b1',
      Target: '/data/outputs',
      ReadOnly: false
    }
    const hasCacheMount = (opts: any): boolean =>
      (opts?.HostConfig?.Mounts ?? []).some(
        (m: DockerMountObject) => m.Target === MODEL_CACHE_MOUNT_TARGET
      )

    function fakeManager(verdict: ModelCacheMountVerdict | null) {
      let broken = false
      const reasons: string[] = []
      return {
        reasons,
        getMountVerdict: () => verdict,
        isMountBroken: () => broken,
        // records dockerd's reason; flips what isMountBroken() answers, like the manager
        markMountBroken: sinon.spy((reason: string) => {
          reasons.push(reason)
          broken = true
        })
      }
    }

    function stubNode(cfg: ServiceModelCacheConfig | null | undefined, manager: unknown) {
      return sinon.stub(OceanNode, 'getInstance').returns({
        getConfig: () => ({ serviceModelCache: cfg }),
        getModelCacheManager: () => manager,
        getPersistentStorage: (): null => null
      } as unknown as OceanNode)
    }

    function stubNoNode() {
      return sinon
        .stub(OceanNode, 'getInstance')
        .throws(new Error('KeyManager and BlockchainRegistry are required'))
    }

    describe('createServiceContainer', () => {
      function makeEngine(createContainer: sinon.SinonStub): any {
        const engine: any = Object.create(C2DEngineDocker.prototype)
        engine.docker = { createContainer }
        return engine
      }
      // dockerd refuses any create that carries the cache mount
      const refusesCacheMount = () =>
        sinon
          .stub()
          .callsFake((opts: any) =>
            hasCacheMount(opts)
              ? Promise.reject(new Error(DOCKERD_REFUSAL))
              : Promise.resolve({ id: 'c-new' })
          )
      const baseOpts = () => ({
        Image: 'img:1',
        Cmd: ['serve'],
        Env: [
          'A=1',
          'OCEAN_MODEL_CACHE=/ocean/model-cache',
          'OCEAN_MODEL_CACHE_HINT=keep-me'
        ],
        HostConfig: {
          NetworkMode: 'net-1',
          CapDrop: ['ALL'],
          SecurityOpt: ['no-new-privileges'],
          PidsLimit: 4096,
          Mounts: [BUCKET_MOUNT, CACHE_MOUNT]
        }
      })

      it('retries once without the cache mount and OCEAN_MODEL_CACHE when dockerd refuses it', async () => {
        const manager = fakeManager(null)
        stubNode({ enabled: true, path: '/srv/model-cache', maxSizeGb: 1 }, manager)
        const createContainer = refusesCacheMount()
        const engine = makeEngine(createContainer)
        const opts = baseOpts()
        const snapshot = structuredClone(opts)

        const container = await engine.createServiceContainer('svc-1', opts)

        expect(container).to.deep.equal({ id: 'c-new' })
        expect(createContainer.callCount).to.equal(2)
        expect(createContainer.firstCall.args[0]).to.deep.equal(snapshot)
        const retry = createContainer.secondCall.args[0]
        expect(retry.Env).to.deep.equal(['A=1', 'OCEAN_MODEL_CACHE_HINT=keep-me'])
        expect(retry.HostConfig.Mounts).to.deep.equal([BUCKET_MOUNT])
        expect(retry).to.deep.include({ Image: 'img:1', Cmd: ['serve'] })
        expect(retry.HostConfig).to.deep.include({
          NetworkMode: 'net-1',
          CapDrop: ['ALL'],
          SecurityOpt: ['no-new-privileges'],
          PidsLimit: 4096
        })
        expect(opts, 'caller options untouched').to.deep.equal(snapshot)
        expect(manager.markMountBroken.calledOnce).to.equal(true)
        expect(manager.reasons).to.deep.equal([DOCKERD_REFUSAL])
      })

      it('still retries when there is no node instance to flag the mount on', async () => {
        stubNoNode()
        const createContainer = refusesCacheMount()
        const container = await makeEngine(createContainer).createServiceContainer(
          'svc-1',
          baseOpts()
        )
        expect(container).to.deep.equal({ id: 'c-new' })
        expect(createContainer.callCount).to.equal(2)
      })

      it('still retries when the node has no manager', async () => {
        stubNode({ enabled: true, path: '/srv/model-cache', maxSizeGb: 1 }, null)
        const createContainer = refusesCacheMount()
        const container = await makeEngine(createContainer).createServiceContainer(
          'svc-1',
          baseOpts()
        )
        expect(container).to.deep.equal({ id: 'c-new' })
        expect(createContainer.callCount).to.equal(2)
      })

      it('does not retry a failed create that had no cache mount', async () => {
        const manager = fakeManager(null)
        stubNode({ enabled: true, path: '/srv/model-cache', maxSizeGb: 1 }, manager)
        const failure = new Error('no such image')
        const createContainer = sinon.stub().rejects(failure)
        const engine = makeEngine(createContainer)
        for (const opts of [
          { ...baseOpts(), HostConfig: { NetworkMode: 'n', Mounts: [BUCKET_MOUNT] } },
          { ...baseOpts(), HostConfig: { NetworkMode: 'n' } },
          { Image: 'img:1' }
        ]) {
          createContainer.resetHistory()
          const error = await rejectionOf(engine.createServiceContainer('svc-1', opts))
          expect(error).to.equal(failure)
          expect(createContainer.callCount, JSON.stringify(opts)).to.equal(1)
        }
        expect(manager.markMountBroken.called).to.equal(false)
      })

      it('propagates the second failure when the retry fails too', async () => {
        stubNoNode()
        const second = new Error('second failure')
        const createContainer = sinon.stub()
        createContainer.onFirstCall().rejects(new Error(DOCKERD_REFUSAL))
        createContainer.onSecondCall().rejects(second)
        const error = await rejectionOf(
          makeEngine(createContainer).createServiceContainer('svc-1', baseOpts())
        )
        expect(error).to.equal(second)
        expect(createContainer.callCount).to.equal(2)
        expect(hasCacheMount(createContainer.secondCall.args[0])).to.equal(false)
      })

      it('keeps the cache mount and the variable when the first create succeeds', async () => {
        stubNoNode()
        const createContainer = sinon.stub().resolves({ id: 'c-1' })
        const opts = baseOpts()
        await makeEngine(createContainer).createServiceContainer('svc-1', opts)
        expect(createContainer.calledOnceWith(opts)).to.equal(true)
      })
    })

    describe('serviceModelCacheMounts (live node config)', () => {
      let root: string
      let verdict: ModelCacheMountVerdict
      beforeEach(() => {
        root = tmpDir('mc-engine-')
        const pub = path.join(root, 'public')
        fs.mkdirSync(pub)
        const st = fs.lstatSync(pub)
        verdict = { configuredPath: root, publicRealpath: pub, dev: st.dev, ino: st.ino }
      })
      afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

      it('offers the mount from the live config and manager', async () => {
        stubNode({ enabled: true, path: root, maxSizeGb: 1 }, fakeManager(verdict))
        const engine: any = localDaemon(Object.create(C2DEngineDocker.prototype))
        const mounts = await engine.serviceModelCacheMounts()
        expect(mounts.map((m: DockerMountObject) => [m.Source, m.Target])).to.deep.equal([
          [verdict.publicRealpath, MODEL_CACHE_MOUNT_TARGET]
        ])
      })

      // dockerd resolves a bind on its own host: a daemon reached over TCP never gets it
      it('offers nothing on an engine whose daemon is remote', async () => {
        stubNode({ enabled: true, path: root, maxSizeGb: 1 }, fakeManager(verdict))
        const engine: any = Object.create(C2DEngineDocker.prototype)
        engine.getC2DConfig = () => ({
          connection: {
            socketPath: '/var/run/docker.sock',
            protocol: 'http',
            host: 'gpu-box',
            port: 2375
          }
        })
        expect(await engine.serviceModelCacheMounts()).to.deep.equal([])
        engine.getC2DConfig = () => ({
          connection: { protocol: 'http', host: 'gpu-box', port: 2375 }
        })
        expect(await engine.serviceModelCacheMounts()).to.deep.equal([])
      })

      it('offers nothing without a node, a manager or an enabled config', async () => {
        const engine: any = localDaemon(Object.create(C2DEngineDocker.prototype))
        const noNode = stubNoNode()
        expect(await engine.serviceModelCacheMounts()).to.deep.equal([])
        noNode.restore()
        const node = stubNode({ enabled: true, path: root, maxSizeGb: 1 }, null)
        expect(await engine.serviceModelCacheMounts()).to.deep.equal([])
        node.restore()
        stubNode({ enabled: false, path: root }, fakeManager(verdict))
        expect(await engine.serviceModelCacheMounts()).to.deep.equal([])
      })
    })

    // Both create sites: processServiceStart (start) and doRestartService (restart).
    describe('create sites', () => {
      const SERVICE_ID = 'svc-cache-1'
      const OWNER = '0x0000000000000000000000000000000000000001'
      const CLUSTER_HASH = 'hash-1'
      const USER_ENV = { OCEAN_MODEL_CACHE: '/home/user/fake-cache', HF_HOME: '/data/hf' }

      let root: string
      let pub: string
      let verdict: ModelCacheMountVerdict
      beforeEach(() => {
        root = tmpDir('mc-sites-')
        pub = path.join(root, 'public')
        fs.mkdirSync(pub)
        const st = fs.lstatSync(pub)
        verdict = { configuredPath: root, publicRealpath: pub, dev: st.dev, ino: st.ino }
      })
      afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

      function makeJob(overrides: Partial<ServiceJob> = {}): ServiceJob {
        return {
          serviceId: SERVICE_ID,
          clusterHash: CLUSTER_HASH,
          environment: 'env-1',
          owner: OWNER,
          image: 'img',
          tag: 'latest',
          containerImage: 'img:latest',
          containerId: '',
          networkId: '',
          status: ServiceStatusNumber.Starting,
          statusText: 'Starting',
          dateCreated: new Date().toISOString(),
          expiresAt: Date.now() + 3600_000,
          duration: 3600,
          exposedPorts: [],
          endpoints: [],
          userData: 'aa', // "decrypted" by the stub key manager below
          resources: [],
          payment: {
            chainId: 8996,
            token: '0xtoken',
            lockTx: '',
            claimTx: '',
            cancelTx: '',
            cost: 5
          },
          ...overrides
        }
      }

      function makeRestartJob(): ServiceJob {
        return makeJob({
          status: ServiceStatusNumber.Restarting,
          statusText: 'Restarting',
          payment: {
            chainId: 8996,
            token: '0xtoken',
            lockTx: '0xl',
            claimTx: '0xc',
            cancelTx: '',
            cost: 5
          }
        })
      }

      function makePipelineEngine(job: ServiceJob, createContainer?: sinon.SinonStub) {
        const container = {
          id: 'c-new',
          infoArchive: sinon.stub().resolves({}),
          putArchive: sinon.stub().resolves(undefined),
          start: sinon.stub().resolves(undefined),
          stop: sinon.stub().resolves(undefined),
          remove: sinon.stub().resolves(undefined)
        }
        const notFound: any = Object.assign(new Error('docker 404'), { statusCode: 404 })
        const engine: any = localDaemon(Object.create(C2DEngineDocker.prototype))
        engine.docker = {
          getNetwork: sinon.stub().returns({
            inspect: sinon.stub().rejects(notFound),
            remove: sinon.stub().resolves(undefined)
          }),
          getContainer: sinon.stub().returns(container),
          createNetwork: sinon.stub().resolves({ id: 'net-1' }),
          createContainer: createContainer ?? sinon.stub().resolves(container),
          listContainers: sinon.stub().resolves([]),
          listNetworks: sinon.stub().resolves([])
        }
        engine.db = {
          getServiceJob: sinon.stub().resolves([job]),
          updateServiceJob: sinon.stub().resolves(1)
        }
        engine.escrow = {
          createLock: sinon.stub().resolves('0xlock'),
          claimLock: sinon.stub().resolves('0xclaim'),
          cancelExpiredLock: sinon.stub().resolves('0xcancel'),
          waitForTransaction: sinon.stub().resolves(undefined),
          getMinLockTime: sinon.stub().returns(3600)
        }
        engine.keyManager = {
          decrypt: sinon.stub().resolves(Buffer.from(JSON.stringify(USER_ENV)))
        }
        engine.pullImageRef = sinon.stub().resolves(undefined)
        engine.cpuAllocations = new Map()
        engine.serviceOpsInFlight = new Set()
        engine.serviceOpPromises = new Set()
        engine.clusterConfig = {
          hash: CLUSTER_HASH,
          connection: { resources: [], serviceOnDemand: {} }
        }
        engine.stopped = false
        return { engine, container }
      }

      const cacheEnv = (opts: any): string[] =>
        (opts.Env as string[]).filter((v) => v.startsWith('OCEAN_MODEL_CACHE='))

      it('start: mounts the cache and announces it, replacing a user-supplied value', async () => {
        stubNode({ enabled: true, path: root, maxSizeGb: 10 }, fakeManager(verdict))
        const job = makeJob()
        const { engine } = makePipelineEngine(job)

        await engine.processServiceStart(job)

        expect(job.status, job.statusText).to.equal(ServiceStatusNumber.Running)
        const opts = engine.docker.createContainer.firstCall.args[0]
        expect(engine.docker.createContainer.callCount).to.equal(1)
        expect(opts.HostConfig.Mounts).to.have.length(1)
        expect(opts.HostConfig.Mounts[0]).to.deep.include({
          Type: 'bind',
          Source: pub,
          Target: '/ocean/model-cache',
          ReadOnly: true
        })
        expect(cacheEnv(opts)).to.deep.equal(['OCEAN_MODEL_CACHE=/ocean/model-cache'])
        expect(opts.Env).to.include('HF_HOME=/data/hf')
      })

      it('start: with the cache disabled, no mount and the user-supplied value is dropped', async () => {
        stubNode({ enabled: false, path: root, maxSizeGb: 10 }, fakeManager(verdict))
        const job = makeJob()
        const { engine } = makePipelineEngine(job)

        await engine.processServiceStart(job)

        expect(job.status, job.statusText).to.equal(ServiceStatusNumber.Running)
        const opts = engine.docker.createContainer.firstCall.args[0]
        expect(opts.HostConfig.Mounts).to.deep.equal([])
        expect(opts.Env).to.deep.equal(['HF_HOME=/data/hf'])
      })

      it('start: falls back without the cache when dockerd refuses it, then stops offering it', async () => {
        const manager = fakeManager(verdict)
        stubNode({ enabled: true, path: root, maxSizeGb: 10 }, manager)
        const job = makeJob()
        const createContainer = sinon
          .stub()
          .callsFake((opts: any) =>
            hasCacheMount(opts)
              ? Promise.reject(new Error(DOCKERD_REFUSAL))
              : Promise.resolve(container)
          )
        const { engine, container } = makePipelineEngine(job, createContainer)

        await engine.processServiceStart(job)

        expect(job.status, job.statusText).to.equal(ServiceStatusNumber.Running)
        expect(job.containerId).to.equal('c-new')
        expect(createContainer.callCount).to.equal(2)
        const retry = createContainer.secondCall.args[0]
        expect(retry.HostConfig.Mounts).to.deep.equal([])
        expect(cacheEnv(retry)).to.deep.equal([])
        expect(retry.Env).to.include('HF_HOME=/data/hf')
        expect(manager.markMountBroken.calledOnce).to.equal(true)

        // the next start does not even try the cache until a sync clears the flag
        const next = makeJob({ serviceId: 'svc-cache-2' })
        const second = makePipelineEngine(next)
        await second.engine.processServiceStart(next)
        expect(next.status, next.statusText).to.equal(ServiceStatusNumber.Running)
        const opts = second.engine.docker.createContainer.firstCall.args[0]
        expect(second.engine.docker.createContainer.callCount).to.equal(1)
        expect(opts.HostConfig.Mounts).to.deep.equal([])
        expect(cacheEnv(opts)).to.deep.equal([])
      })

      it('restart: mounts the cache and announces it', async () => {
        stubNode({ enabled: true, path: root, maxSizeGb: 10 }, fakeManager(verdict))
        const job = makeRestartJob()
        const { engine } = makePipelineEngine(job)

        await engine.doRestartService(job)

        expect(job.status, job.statusText).to.equal(ServiceStatusNumber.Running)
        const opts = engine.docker.createContainer.firstCall.args[0]
        expect(
          opts.HostConfig.Mounts.map((m: DockerMountObject) => m.Source)
        ).to.deep.equal([pub])
        expect(cacheEnv(opts)).to.deep.equal(['OCEAN_MODEL_CACHE=/ocean/model-cache'])
      })

      it('restart: falls back without the cache when dockerd refuses it', async () => {
        const manager = fakeManager(verdict)
        stubNode({ enabled: true, path: root, maxSizeGb: 10 }, manager)
        const job = makeRestartJob()
        const createContainer = sinon
          .stub()
          .callsFake((opts: any) =>
            hasCacheMount(opts)
              ? Promise.reject(new Error(DOCKERD_REFUSAL))
              : Promise.resolve(container)
          )
        const { engine, container } = makePipelineEngine(job, createContainer)

        await engine.doRestartService(job)

        expect(job.status, job.statusText).to.equal(ServiceStatusNumber.Running)
        expect(createContainer.callCount).to.equal(2)
        const retry = createContainer.secondCall.args[0]
        expect(retry.HostConfig.Mounts).to.deep.equal([])
        expect(cacheEnv(retry)).to.deep.equal([])
        expect(manager.markMountBroken.calledOnce).to.equal(true)
      })

      it('restart: with the cache disabled, no mount and the user-supplied value is dropped', async () => {
        stubNode({ enabled: false, path: root, maxSizeGb: 10 }, fakeManager(verdict))
        const job = makeRestartJob()
        const { engine } = makePipelineEngine(job)

        await engine.doRestartService(job)

        expect(job.status, job.statusText).to.equal(ServiceStatusNumber.Running)
        const opts = engine.docker.createContainer.firstCall.args[0]
        expect(opts.HostConfig.Mounts).to.deep.equal([])
        expect(cacheEnv(opts)).to.deep.equal([])
        expect(opts.Env).to.deep.equal(['HF_HOME=/data/hf'])
      })
    })
  })

  // ---------------------------------------------------------------------------------------
  describe('loadServiceTemplates diagnostics', () => {
    let dir: string
    const valid = (id: string, extra: Record<string, unknown> = {}) => ({
      id,
      image: 'quay.io/jupyter/datascience-notebook',
      tag: 'latest',
      exposedPorts: [8888],
      ...extra
    })
    const write = (rel: string, content: unknown) => {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
      fs.writeFileSync(
        path.join(dir, rel),
        typeof content === 'string' ? content : JSON.stringify(content)
      )
    }
    async function load(target: string | undefined = dir) {
      const diag: TemplateLoadDiagnostics = { errors: [] }
      const templates = await loadServiceTemplates(target, diag)
      return { ids: templates.map((t) => t.id).sort(), templates, errors: diag.errors }
    }

    beforeEach(() => {
      dir = tmpDir('mc-templates-')
    })
    afterEach(() => {
      fs.rmSync(dir, { recursive: true, force: true })
    })

    it('reports no errors for a clean flat dir (commandFile, workflow file, inline graph)', async () => {
      write('boot.sh', '#!/bin/bash\necho hi\n')
      write('workflows/w.json', { nodes: [{ id: 1 }] })
      write('a.json', valid('a', { commandFile: 'boot.sh' }))
      write(
        'b.json',
        valid('b', {
          workflows: [
            { id: 'w', name: 'W', file: 'workflows/w.json' },
            { id: 'inline', name: 'Inline', graph: { nodes: [] } }
          ]
        })
      )
      write('multi.json', [valid('c'), valid('d')])
      const { ids, templates, errors } = await load()
      expect(errors).to.deep.equal([])
      expect(ids).to.deep.equal(['a', 'b', 'c', 'd'])
      const b = templates.find((t) => t.id === 'b')
      expect(b.workflows.map((w) => w.graph)).to.deep.equal([
        { nodes: [{ id: 1 }] },
        { nodes: [] }
      ])
    })

    it('reports no errors for a clean folder layout with a root package.json', async () => {
      write('flow-a/template.json', valid('flow-a', { commandFile: 'bootstrap.sh' }))
      write('flow-a/bootstrap.sh', 'echo a')
      write('flow-b/template.json', valid('flow-b'))
      write('package.json', { name: 'service-templates', private: true })
      const { ids, errors } = await load()
      expect(errors).to.deep.equal([])
      expect(ids).to.deep.equal(['flow-a', 'flow-b'])
    })

    it('reports no errors for an existing empty dir', async () => {
      const { ids, errors } = await load()
      expect(errors).to.deep.equal([])
      expect(ids).to.deep.equal([])
    })

    it('reports a missing serviceTemplatesPath setting', async () => {
      const diag: TemplateLoadDiagnostics = { errors: [] }
      expect(await loadServiceTemplates(undefined, diag)).to.deep.equal([])
      expect(diag.errors).to.have.length(1)
    })

    it('reports a templates dir that cannot be read (missing, not a dir)', async () => {
      const missing = await load(path.join(dir, 'does-not-exist'))
      expect(missing.ids).to.deep.equal([])
      expect(missing.errors).to.have.length(1)
      expect(missing.errors[0]).to.include('does-not-exist')

      write('plain-file', 'x')
      const notDir = await load(path.join(dir, 'plain-file'))
      expect(notDir.ids).to.deep.equal([])
      expect(notDir.errors).to.have.length(1)
    })

    it('reports a templates dir the node cannot list (EACCES)', async function () {
      if (isRoot()) this.skip() // root reads anything
      write('a.json', valid('a'))
      fs.chmodSync(dir, 0o000)
      try {
        const { ids, errors } = await load()
        expect(ids).to.deep.equal([])
        expect(errors).to.have.length(1)
        expect(errors[0]).to.include('not readable')
      } finally {
        fs.chmodSync(dir, 0o755)
      }
    })

    it('reports a flow folder the node cannot read (EACCES)', async function () {
      if (isRoot()) this.skip() // root reads anything
      write('flow-a/template.json', valid('flow-a'))
      write('flow-b/template.json', valid('flow-b'))
      fs.chmodSync(path.join(dir, 'flow-b'), 0o000)
      try {
        const { ids, errors } = await load()
        expect(ids).to.deep.equal([])
        expect(errors).to.have.length(1)
      } finally {
        fs.chmodSync(path.join(dir, 'flow-b'), 0o755)
      }
    })

    it('reports a template file the node cannot read (EACCES), and still loads the others', async function () {
      if (isRoot()) this.skip() // root reads anything
      write('locked.json', valid('locked'))
      write('good.json', valid('good'))
      fs.chmodSync(path.join(dir, 'locked.json'), 0o000)
      try {
        const { ids, errors } = await load()
        expect(ids).to.deep.equal(['good'])
        expect(errors).to.have.length(1)
        expect(errors[0]).to.include('locked.json')
      } finally {
        fs.chmodSync(path.join(dir, 'locked.json'), 0o644)
      }
    })

    it('reports a template file with invalid JSON, and still loads the others', async () => {
      write('bad.json', '{ not json')
      write('good.json', valid('good'))
      const { ids, errors } = await load()
      expect(ids).to.deep.equal(['good'])
      expect(errors).to.have.length(1)
      expect(errors[0]).to.include('bad.json')
    })

    it('reports each template that fails the schema, including one inside an array', async () => {
      write('invalid.json', valid('inv', { dockerfile: 'FROM x' })) // tag + dockerfile
      write('mixed.json', [valid('ok-1'), { id: 'Not Valid' }, valid('ok-2')])
      const { ids, errors } = await load()
      expect(ids).to.deep.equal(['ok-1', 'ok-2'])
      expect(errors).to.have.length(2)
      expect(errors.some((e) => e.includes('invalid.json'))).to.equal(true)
      expect(errors.some((e) => e.includes('mixed.json'))).to.equal(true)
    })

    it('reports an unreadable or escaping commandFile (the template is skipped)', async () => {
      const outside = tmpDir('mc-templates-outside-')
      try {
        fs.writeFileSync(path.join(outside, 'evil.sh'), 'echo pwned')
        write('missing-cmd.json', valid('missing-cmd', { commandFile: 'nope.sh' }))
        write(
          'escape-cmd.json',
          valid('escape-cmd', {
            commandFile: path.relative(dir, path.join(outside, 'evil.sh'))
          })
        )
        write('dir-cmd.json', valid('dir-cmd', { commandFile: 'scripts' }))
        fs.mkdirSync(path.join(dir, 'scripts'))
        write('ok.json', valid('ok'))
        const { ids, errors } = await load()
        expect(ids).to.deep.equal(['ok'])
        expect(errors).to.have.length(3)
        for (const id of ['missing-cmd', 'escape-cmd', 'dir-cmd']) {
          expect(
            errors.some((e) => e.includes(`"${id}"`)),
            `${id} in ${JSON.stringify(errors)}`
          ).to.equal(true)
        }
      } finally {
        fs.rmSync(outside, { recursive: true, force: true })
      }
    })

    it('reports a workflow file with invalid JSON or that cannot be read (the workflow is dropped)', async () => {
      write('workflows/broken.json', '{ "nodes": [')
      write('workflows/good.json', { nodes: [] })
      write(
        'a.json',
        valid('a', {
          workflows: [
            { id: 'broken', name: 'Broken', file: 'workflows/broken.json' },
            { id: 'missing', name: 'Missing', file: 'workflows/missing.json' },
            { id: 'good', name: 'Good', file: 'workflows/good.json' }
          ]
        })
      )
      const { templates, errors } = await load()
      expect(templates).to.have.length(1)
      expect(templates[0].workflows.map((w) => w.id)).to.deep.equal(['good'])
      expect(errors).to.have.length(2)
      expect(errors.some((e) => e.includes('"broken"'))).to.equal(true)
      expect(errors.some((e) => e.includes('"missing"'))).to.equal(true)
    })

    it('reports a workflow file that escapes the templates dir', async () => {
      const outside = tmpDir('mc-templates-outside-')
      try {
        fs.writeFileSync(path.join(outside, 'secret.json'), '{"secret":true}')
        write(
          'a.json',
          valid('a', {
            workflows: [
              {
                id: 'escape',
                name: 'Escape',
                file: path.relative(dir, path.join(outside, 'secret.json'))
              }
            ]
          })
        )
        const { templates, errors } = await load()
        expect(templates[0].workflows).to.deep.equal([])
        expect(errors).to.have.length(1)
        expect(errors[0]).to.include('outside the templates dir')
      } finally {
        fs.rmSync(outside, { recursive: true, force: true })
      }
    })

    it('collects every problem of one load in a single diagnostics object', async () => {
      write('bad.json', '{ not json')
      write('cmd.json', valid('cmd', { commandFile: 'nope.sh' }))
      write(
        'wf.json',
        valid('wf', { workflows: [{ id: 'gone', name: 'Gone', file: 'gone.json' }] })
      )
      write('ok.json', valid('ok'))
      const { ids, errors } = await load()
      expect(ids).to.deep.equal(['ok', 'wf'])
      expect(errors).to.have.length(3)
    })

    it('works without a diagnostics object (existing callers)', async () => {
      write('bad.json', '{ not json')
      write('good.json', valid('good', { commandFile: 'missing.sh' }))
      write('ok.json', valid('ok'))
      const templates = await loadServiceTemplates(dir)
      expect(templates.map((t) => t.id)).to.deep.equal(['ok'])
      expect(await loadServiceTemplates(path.join(dir, 'nope'))).to.deep.equal([])
      expect(await loadServiceTemplates(undefined)).to.deep.equal([])
    })
  })

  // ---------------------------------------------------------------------------------------
  // Node-level, not per engine: engines are rebuilt on config pushes, the cache is not.
  describe('OceanNode: the node-level manager', () => {
    it('has no manager until one is set, and returns the one set', () => {
      const node: any = Object.create(OceanNode.prototype)
      expect(node.getModelCacheManager()).to.equal(null)
      const manager = { stop: sinon.stub().resolves() }
      node.setModelCacheManager(manager)
      expect(node.getModelCacheManager()).to.equal(manager)
      node.setModelCacheManager(null)
      expect(node.getModelCacheManager()).to.equal(null)
    })

    it('stops and drops the manager at tearDownAll, and still stops the engines', async () => {
      const node: any = Object.create(OceanNode.prototype)
      const manager = { stop: sinon.stub().resolves() }
      const engines = { stopAllEngines: sinon.stub().resolves() }
      node.setModelCacheManager(manager)
      node.c2dEngines = engines
      await node.tearDownAll()
      expect(manager.stop.calledOnce).to.equal(true)
      expect(engines.stopAllEngines.calledOnce).to.equal(true)
      expect(node.getModelCacheManager()).to.equal(null)
    })

    it('keeps the manager when the engines are rebuilt', async () => {
      const node: any = Object.create(OceanNode.prototype)
      const manager = { stop: sinon.stub().resolves() }
      node.setModelCacheManager(manager)
      node.config = {} // no c2dClusters: addC2DEngines builds nothing
      await node.addC2DEngines()
      expect(node.getModelCacheManager()).to.equal(manager)
      expect(manager.stop.called).to.equal(false)
    })
  })
})
