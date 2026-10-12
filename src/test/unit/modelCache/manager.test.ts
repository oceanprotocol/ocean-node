import { expect } from 'chai'
import crypto from 'crypto'
import fs from 'fs'
import http from 'http'
import os from 'os'
import path from 'path'
import type { AddressInfo } from 'net'
import type { ServiceJob, ServiceTemplate } from '../../../@types/C2D/ServiceOnDemand.js'
import { ServiceStatusNumber } from '../../../@types/C2D/ServiceOnDemand.js'
import type { OceanNodeConfig } from '../../../@types/OceanNode.js'
import {
  hostPathVisible,
  ModelCacheManager,
  selectFiles
} from '../../../components/modelCache/manager.js'
import type { ServiceModelCacheConfig } from '../../../components/modelCache/types.js'
import { HfClient } from '../../../components/modelCache/hfClient.js'

// Drives whole sync runs of the model cache against a local stand-in for the Hub that
// answers the way the real one does: regular files through a relative 307 to
// /api/resolve-cache/..., LFS files through a 302 to a CDN path, Range everywhere.

const gitSha1 = (b: Buffer) =>
  crypto.createHash('sha1').update(`blob ${b.length}\0`).update(b).digest('hex')
const sha256 = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex')

interface StubRepo {
  sha: string
  files: Record<string, Buffer>
  lfs: Set<string>
  gated?: false | string
}

class StubHub {
  repos: Record<string, StubRepo> = {}
  failApi = new Set<string>() // repo, or repo@revision
  failFiles = new Set<string>()
  delayApiMs = 0
  requests: string[] = []
  private server: http.Server

  setRepo(
    name: string,
    files: Record<string, Buffer>,
    lfs: string[] = [],
    gated: false | string = false
  ) {
    this.repos[name] = {
      sha: crypto.randomBytes(20).toString('hex'),
      files,
      lfs: new Set(lfs),
      gated
    }
    return this.repos[name].sha
  }

  siblings(r: StubRepo) {
    return Object.entries(r.files).map(([f, b]) =>
      r.lfs.has(f)
        ? {
            rfilename: f,
            size: b.length,
            blobId: gitSha1(Buffer.from(`pointer ${f}`)),
            lfs: { sha256: sha256(b), size: b.length, pointerSize: 130 }
          }
        : { rfilename: f, size: b.length, blobId: gitSha1(b) }
    )
  }

  async start(): Promise<string> {
    this.server = http.createServer((req, res) => this.handle(req, res))
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve))
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`
  }

  stop(): Promise<void> {
    return new Promise((resolve) => this.server.close(() => resolve()))
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const u = new URL(req.url, 'http://stub')
    this.requests.push(`${u.pathname} ${req.headers.range ?? ''}`)
    let m = u.pathname.match(/^\/api\/models\/([^/]+\/[^/]+)\/revision\/([^/]+)$/)
    if (m && this.delayApiMs > 0 && !(req as any).delayed) {
      ;(req as any).delayed = true
      setTimeout(() => this.handle(req, res), this.delayApiMs)
      return
    }
    if (m) {
      const r = this.repos[m[1]]
      if (
        this.failApi.has(m[1]) ||
        this.failApi.has(`${m[1]}@${decodeURIComponent(m[2])}`)
      ) {
        res.statusCode = 503
        return res.end()
      }
      if (!r) {
        res.statusCode = 404
        return res.end()
      }
      res.setHeader('content-type', 'application/json')
      return res.end(
        JSON.stringify({
          id: m[1],
          sha: r.sha,
          private: false,
          gated: r.gated ?? false,
          disabled: false,
          siblings: this.siblings(r)
        })
      )
    }
    m = u.pathname.match(/^\/([^/]+\/[^/]+)\/resolve\/([0-9a-f]{40})\/(.+)$/)
    if (m) {
      const r = this.repos[m[1]]
      const file = decodeURIComponent(m[3])
      if (!r || !(file in r.files)) {
        res.statusCode = 404
        return res.end()
      }
      res.statusCode = r.lfs.has(file) ? 302 : 307
      res.setHeader(
        'location',
        r.lfs.has(file)
          ? `/cdn/${m[1]}/${encodeURIComponent(file)}?sig=x`
          : `/api/resolve-cache/models/${m[1]}/${m[2]}/${encodeURIComponent(file)}`
      )
      return res.end()
    }
    m = u.pathname.match(
      /^\/(?:cdn|api\/resolve-cache\/models)\/([^/]+\/[^/]+)\/(?:[0-9a-f]{40}\/)?(.+)$/
    )
    if (m) {
      const file = decodeURIComponent(m[2])
      if (this.failFiles.has(file)) {
        res.statusCode = 500
        return res.end()
      }
      const body = this.repos[m[1]]?.files[file]
      const rg = /bytes=(\d+)-(\d+)/.exec(req.headers.range ?? '')
      if (!body || !rg) {
        res.statusCode = body ? 200 : 404
        return res.end(body)
      }
      const s = Number(rg[1])
      const e = Math.min(Number(rg[2]), body.length - 1)
      res.statusCode = 206
      res.setHeader('content-range', `bytes ${s}-${e}/${body.length}`)
      return res.end(body.subarray(s, e + 1))
    }
    res.statusCode = 404
    res.end()
  }
}

function readJson(p: string): any {
  return JSON.parse(fs.readFileSync(p, 'utf8'))
}

describe('modelCache manager (whole sync runs)', function () {
  this.timeout(30000)
  let hub: StubHub
  let base: string
  let root: string
  let cfg: ServiceModelCacheConfig
  let templates: ServiceTemplate[]
  let jobs: ServiceJob[]
  let token: string | undefined

  const llmTemplate = (repo = 'org/llm', order = 2): ServiceTemplate =>
    ({
      id: `llm-${repo.replace('/', '-')}`,
      image: 'x',
      exposedPorts: [1],
      order,
      includes: [{ name: 'LLM', kind: 'model', repoId: repo }]
    }) as ServiceTemplate
  const comfyTemplate = (): ServiceTemplate =>
    ({
      id: 'comfy',
      image: 'x',
      exposedPorts: [1],
      order: 1,
      includes: [{ name: 'W', kind: 'model', repoId: 'org2/comfy' }],
      workflows: [
        {
          id: 'w',
          name: 'w',
          graph: {
            nodes: [
              {
                properties: {
                  models: [
                    {
                      url: 'https://huggingface.co/org2/comfy/resolve/main/sub/w.safetensors?download=true',
                      directory: 'checkpoints'
                    }
                  ]
                }
              }
            ]
          }
        }
      ]
    }) as ServiceTemplate

  function manager() {
    return new ModelCacheManager({
      getConfig: () =>
        ({ serviceModelCache: cfg, serviceTemplatesPath: undefined }) as OceanNodeConfig,
      loadTemplates: () => Promise.resolve(templates),
      getServiceJobs: () => Promise.resolve(jobs),
      hf: { baseUrl: base, retryDelaysMs: [1], token: () => token },
      chunkBytes: 4096,
      initialDelayMs: 3_600_000
    })
  }
  const index = () => readJson(path.join(root, 'public', 'index.json'))
  const state = () => readJson(path.join(root, 'private', 'state.json'))
  const snapDir = (repo: string, sha: string) =>
    path.join(
      root,
      'public',
      'hf',
      'hub',
      `models--${repo.replace('/', '--')}`,
      'snapshots',
      sha
    )

  beforeEach(async () => {
    hub = new StubHub()
    base = await hub.start()
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-manager-'))
    cfg = { enabled: true, path: root, maxSizeGb: 1, minFreeGb: 0, curated: [] }
    jobs = []
    token = undefined
    templates = [llmTemplate(), comfyTemplate()]
    hub.setRepo(
      'org/llm',
      {
        'config.json': Buffer.from('{"a":1}'),
        'model.safetensors': crypto.randomBytes(20000),
        'empty.txt': Buffer.alloc(0)
      },
      ['model.safetensors']
    )
    hub.setRepo(
      'org2/comfy',
      {
        'sub/w.safetensors': crypto.randomBytes(9000),
        'other.safetensors': crypto.randomBytes(5000)
      },
      ['sub/w.safetensors', 'other.safetensors']
    )
  })

  afterEach(async () => {
    await hub.stop()
    fs.rmSync(root, { recursive: true, force: true })
  })

  it('publishes template models: verified blobs, relative links, refs without newline, index', async () => {
    const m = manager()
    await m.runNow()
    const idx = index()
    const llm = hub.repos['org/llm']
    const snap = idx.repos['org/llm'].snapshots[llm.sha]
    expect(snap.complete).to.equal(true)
    expect(Object.keys(snap.files).sort()).to.deep.equal(
      ['config.json', 'empty.txt', 'model.safetensors'].sort()
    )
    expect(idx.repos['org/llm'].refs.main).to.equal(llm.sha)
    expect(idx.repos['org/llm'].wanted.main.status).to.equal('ok')
    const dir = snapDir('org/llm', llm.sha)
    for (const f of Object.keys(llm.files)) {
      const link = path.join(dir, f)
      expect(fs.lstatSync(link).isSymbolicLink(), f).to.equal(true)
      expect(path.isAbsolute(fs.readlinkSync(link)), f).to.equal(false)
      expect(fs.readFileSync(link).equals(llm.files[f]), f).to.equal(true)
    }
    const ref = fs.readFileSync(
      path.join(root, 'public', 'hf', 'hub', 'models--org--llm', 'refs', 'main'),
      'utf8'
    )
    expect(ref).to.equal(llm.sha)
    // ComfyUI: only the file the workflow names, no full snapshot of the repo
    const comfy = idx.repos['org2/comfy'].snapshots[hub.repos['org2/comfy'].sha]
    expect(comfy.complete).to.equal(false)
    expect(Object.keys(comfy.files)).to.deep.equal(['sub/w.safetensors'])
    expect(comfy.selection).to.deep.equal({ files: ['sub/w.safetensors'] })
    expect(m.getMountVerdict()?.publicRealpath).to.equal(
      path.join(fs.realpathSync(root), 'public')
    )
    expect(m.getStatus().state).to.equal('idle')
    // the 0-byte file never hit the network
    expect(hub.requests.some((r) => r.includes('empty.txt'))).to.equal(false)
  })

  it('on an upstream commit downloads only the changed blob, moves refs and retires the old snapshot', async () => {
    const m = manager()
    await m.runNow()
    const old = hub.repos['org/llm']
    const model = old.files['model.safetensors']
    hub.setRepo(
      'org/llm',
      {
        'config.json': Buffer.from('{"a":2}'),
        'model.safetensors': model,
        'empty.txt': Buffer.alloc(0)
      },
      ['model.safetensors']
    )
    hub.requests = []
    await m.runNow()
    const idx = index()
    expect(idx.repos['org/llm'].refs.main).to.equal(hub.repos['org/llm'].sha)
    expect(Object.keys(idx.repos['org/llm'].snapshots)).to.deep.equal([
      hub.repos['org/llm'].sha
    ])
    expect(fs.existsSync(snapDir('org/llm', old.sha)), 'old kept during grace').to.equal(
      true
    )
    expect(state().snapshots[`org/llm@${old.sha}`].retiredAt).to.be.a('string')
    expect(hub.requests.filter((r) => r.includes('model.safetensors'))).to.deep.equal([])
    expect(m.getStatus().downloadedBytes).to.equal(7)
  })

  it('deletes a retired snapshot only after the grace period and once no older live service holds it', async () => {
    const m = manager()
    await m.runNow()
    const old = hub.repos['org/llm'].sha
    hub.setRepo('org/llm', { 'config.json': Buffer.from('{"b":1}') })
    await m.runNow()
    // age the retirement past the grace period
    const st = state()
    const longAgo = new Date(Date.now() - 48 * 3600 * 1000).toISOString()
    st.snapshots[`org/llm@${old}`].retiredAt = longAgo
    const statePath = path.join(root, 'private', 'state.json')
    fs.chmodSync(statePath, 0o600) // the node keeps it read-only (0400)
    fs.writeFileSync(statePath, JSON.stringify(st))
    jobs = [
      {
        status: ServiceStatusNumber.Running,
        dateCreated: new Date(Date.now() - 72 * 3600 * 1000).toISOString()
      } as ServiceJob
    ]
    await m.runNow()
    expect(fs.existsSync(snapDir('org/llm', old)), 'held by a live service').to.equal(
      true
    )
    jobs = [
      {
        status: ServiceStatusNumber.Stopped,
        dateCreated: new Date(Date.now() - 72 * 3600 * 1000).toISOString()
      } as ServiceJob
    ]
    await m.runNow()
    expect(fs.existsSync(snapDir('org/llm', old)), 'deleted').to.equal(false)
    // the blob only the old commit used is gone too
    const blobs = fs.readdirSync(
      path.join(root, 'public', 'hf', 'hub', 'models--org--llm', 'blobs')
    )
    expect(blobs).to.have.length(1)
  })

  it('a Hub API failure during an unfinished fill keeps its verified files', async () => {
    hub.failFiles.add('model.safetensors')
    const m = manager()
    await m.runNow()
    const llm = hub.repos['org/llm']
    expect(index().repos['org/llm'].wanted.main.status).to.equal('error')
    const configBlob = path.join(
      root,
      'public',
      'hf',
      'hub',
      'models--org--llm',
      'blobs',
      gitSha1(llm.files['config.json'])
    )
    expect(fs.existsSync(configBlob), 'verified file downloaded').to.equal(true)
    hub.failApi.add('org/llm')
    await m.runNow()
    expect(fs.existsSync(configBlob), 'kept across the API failure').to.equal(true)
    hub.failApi.clear()
    hub.failFiles.clear()
    hub.requests = []
    await m.runNow()
    expect(index().repos['org/llm'].wanted.main.status).to.equal('ok')
    expect(
      hub.requests.some((r) => r.includes('config.json')),
      'not downloaded again'
    ).to.equal(false)
  })

  it('keeps serving a published snapshot while its Hub lookup fails', async () => {
    const m = manager()
    await m.runNow()
    const sha = hub.repos['org/llm'].sha
    hub.failApi.add('org/llm')
    await m.runNow()
    const idx = index()
    expect(idx.repos['org/llm'].refs.main).to.equal(sha)
    expect(idx.repos['org/llm'].snapshots[sha]).to.not.equal(undefined)
    expect(idx.repos['org/llm'].wanted.main.status).to.equal('error')
    expect(state().snapshots[`org/llm@${sha}`].retiredAt).to.equal(undefined)
  })

  it('skips the lowest-priority entry when the budget is exceeded, and defers an update that does not fit', async () => {
    // comfy (order 1) first, then org/llm (order 2): room for comfy's 9000 bytes only
    cfg.maxSizeGb = 15000 / 1e9
    const m = manager()
    await m.runNow()
    let idx = index()
    expect(idx.repos['org2/comfy'].wanted.main.status).to.equal('ok')
    expect(idx.repos['org/llm'].wanted.main.status).to.equal('skipped:budget')
    expect(idx.repos['org/llm'].snapshots).to.deep.equal({})
    // a larger budget, then an upstream change of comfy that does not fit next to the old
    cfg.maxSizeGb = 40000 / 1e9
    await m.runNow()
    const comfyOld = hub.repos['org2/comfy'].sha
    hub.setRepo(
      'org2/comfy',
      {
        'sub/w.safetensors': crypto.randomBytes(35000),
        'other.safetensors': Buffer.from('x')
      },
      ['sub/w.safetensors', 'other.safetensors']
    )
    await m.runNow()
    idx = index()
    expect(idx.repos['org2/comfy'].wanted.main.status).to.equal('deferred:budget')
    expect(idx.repos['org2/comfy'].refs.main).to.equal(comfyOld)
  })

  it('never caches gated repos', async () => {
    hub.setRepo('org/llm', { 'config.json': Buffer.from('{}') }, [], 'manual')
    const m = manager()
    await m.runNow()
    const idx = index()
    expect(idx.repos['org/llm'].wanted.main.status).to.equal('skipped:gated')
    expect(idx.repos['org/llm'].snapshots).to.deep.equal({})
    expect(hub.requests.some((r) => r.startsWith('/org/llm/resolve'))).to.equal(false)
  })

  it('applies curated entries over template specs (narrowing a repo)', async () => {
    cfg.curated = [{ repo: 'org/llm', allowPatterns: ['*.json'] }]
    const m = manager()
    await m.runNow()
    const snap = index().repos['org/llm'].snapshots[hub.repos['org/llm'].sha]
    expect(Object.keys(snap.files)).to.deep.equal(['config.json'])
    expect(snap.complete).to.equal(false)
    expect(snap.selection).to.deep.equal({ allowPatterns: ['*.json'] })
  })

  it('does nothing while disabled and refuses a non-empty directory it did not create', async () => {
    cfg.enabled = false
    const m = manager()
    await m.runNow()
    expect(m.getStatus().state).to.equal('disabled')
    expect(fs.readdirSync(root)).to.deep.equal([])
    cfg.enabled = true
    fs.writeFileSync(path.join(root, 'foreign.txt'), 'x')
    await m.runNow()
    expect(m.getStatus().state).to.equal('error')
    expect(m.getStatus().error).to.match(/not empty/)
    expect(m.getMountVerdict()).to.equal(null)
  })

  it('never publishes a raw error message: an undici header error with the token stays out of index.json', async () => {
    token = 'bad\ntoken-secret'
    const m = manager()
    await m.runNow()
    const raw = fs.readFileSync(path.join(root, 'public', 'index.json'), 'utf8')
    expect(raw).to.not.include('token-secret')
    expect(index().repos['org/llm'].wanted.main.status).to.equal('error')
  })

  it('a short write followed by a failed write never yields a corrupted file', async () => {
    const body = crypto.randomBytes(10000)
    hub.setRepo('org/x', { 'm.safetensors': body }, ['m.safetensors'])
    const part = path.join(root, 'x.part')
    const probe = await fs.promises.open(path.join(root, 'probe'), 'w')
    const proto = Object.getPrototypeOf(probe)
    await probe.close()
    const original = proto.write
    let calls = 0
    // first write: half of the bytes; second: ENOSPC; then normal
    proto.write = function (buf: Buffer, off: number, len: number, pos: number) {
      calls++
      if (calls === 1) return original.call(this, buf, off, Math.floor(len / 2), pos)
      if (calls === 2) {
        const e = new Error('no space') as NodeJS.ErrnoException
        e.code = 'ENOSPC'
        return Promise.reject(e)
      }
      return original.call(this, buf, off, len, pos)
    }
    try {
      await new HfClient({ baseUrl: base, retryDelaysMs: [1] }).downloadFile({
        repo: 'org/x',
        commit: hub.repos['org/x'].sha,
        file: 'm.safetensors',
        size: body.length,
        hash: sha256(body),
        lfs: true,
        partPath: part,
        signal: new AbortController().signal,
        chunkBytes: 4096
      })
    } finally {
      proto.write = original
    }
    expect(calls).to.be.greaterThan(2)
    expect(fs.readFileSync(part).equals(body)).to.equal(true)
  })

  it('publishes blobs read-only, so writing through a path cannot alter them', async function () {
    if (process.getuid?.() === 0) this.skip()
    await manager().runNow()
    const llm = hub.repos['org/llm']
    const blob = path.join(
      root,
      'public',
      'hf',
      'hub',
      'models--org--llm',
      'blobs',
      sha256(llm.files['model.safetensors'])
    )
    expect((fs.statSync(blob).mode & 0o777).toString(8)).to.equal('444')
    expect(() => fs.writeFileSync(blob, 'EVIL')).to.throw(/EACCES|EPERM/)
    expect(fs.readFileSync(blob).equals(llm.files['model.safetensors'])).to.equal(true)
    const idx = path.join(root, 'public', 'index.json')
    expect((fs.statSync(idx).mode & 0o777).toString(8)).to.equal('444')
  })

  it('never trusts a file it did not install at a blob path, whatever its size', async () => {
    const llm = hub.repos['org/llm']
    const model = llm.files['model.safetensors']
    const blobsDir = path.join(root, 'public', 'hf', 'hub', 'models--org--llm', 'blobs')
    // something (a write through a planted symlink) created the blob path first
    const m = manager()
    cfg.enabled = false
    await m.runNow()
    cfg.enabled = true
    fs.writeFileSync(path.join(root, '.ocean-model-cache'), JSON.stringify({ id: 'x' }))
    fs.mkdirSync(blobsDir, { recursive: true })
    const forged = path.join(blobsDir, sha256(model))
    fs.writeFileSync(forged, Buffer.alloc(model.length, 0x41))
    await m.runNow()
    const snap = index().repos['org/llm'].snapshots[llm.sha]
    expect(snap.files['model.safetensors']).to.equal(model.length)
    const served = path.join(snapDir('org/llm', llm.sha), 'model.safetensors')
    expect(fs.readFileSync(served).equals(model), 'verified content served').to.equal(
      true
    )
  })

  it('an interrupted resolve keeps the targets of unfinished downloads', async () => {
    hub.failFiles.add('model.safetensors')
    const m = manager()
    await m.runNow()
    const llm = hub.repos['org/llm']
    const configBlob = path.join(
      root,
      'public',
      'hf',
      'hub',
      'models--org--llm',
      'blobs',
      gitSha1(llm.files['config.json'])
    )
    expect(fs.existsSync(configBlob)).to.equal(true)
    // the next run is interrupted (a config push) during its first Hub call, and the
    // rerun that follows gets a 503 for org/llm
    hub.delayApiMs = 300
    const run = m.runNow()
    await new Promise((resolve) => setTimeout(resolve, 100))
    hub.failApi.add('org/llm')
    hub.delayApiMs = 0
    m.trigger()
    await run
    expect(fs.existsSync(configBlob), 'verified shard kept').to.equal(true)
  })

  it('does not mark a snapshot incomplete while another revision still serves it whole', async () => {
    const llm = hub.repos['org/llm']
    // a second template pins one file of the same commit
    templates.push({
      id: 'pinned',
      image: 'x',
      exposedPorts: [1],
      order: 3,
      workflows: [
        {
          id: 'p',
          name: 'p',
          graph: {
            u: `https://huggingface.co/org/llm/resolve/${llm.sha}/model.safetensors`
          }
        }
      ]
    } as ServiceTemplate)
    const m = manager()
    await m.runNow()
    expect(index().repos['org/llm'].snapshots[llm.sha].complete).to.equal(true)
    hub.failApi.add('org/llm@main')
    await m.runNow()
    const idx = index()
    expect(idx.repos['org/llm'].wanted.main.status).to.equal('error')
    expect(idx.repos['org/llm'].refs.main).to.equal(llm.sha)
    expect(idx.repos['org/llm'].snapshots[llm.sha].complete, 'still whole').to.equal(true)
    expect(Object.keys(idx.repos['org/llm'].snapshots[llm.sha].files)).to.have.length(3)
  })

  it('frozen templates keep everything the last good set wanted from a repo', async () => {
    const m = manager()
    await m.runNow()
    const llm = hub.repos['org/llm']
    // the LLM template now fails to load; a loaded one names a single file of the repo
    const loader = (_dir: string, diag: { errors: string[] }) => {
      diag.errors.push('llm-org-llm/template.json: invalid template')
      return Promise.resolve([
        {
          id: 'one-file',
          image: 'x',
          exposedPorts: [1],
          workflows: [
            {
              id: 'f',
              name: 'f',
              graph: {
                u: 'https://huggingface.co/org/llm/resolve/main/model.safetensors'
              }
            }
          ]
        } as ServiceTemplate
      ])
    }
    const frozen = new ModelCacheManager({
      getConfig: () =>
        ({ serviceModelCache: cfg, serviceTemplatesPath: undefined }) as OceanNodeConfig,
      loadTemplates: loader,
      getServiceJobs: () => Promise.resolve(jobs),
      hf: { baseUrl: base, retryDelaysMs: [1] },
      chunkBytes: 4096,
      initialDelayMs: 3_600_000
    })
    await frozen.runNow()
    expect(frozen.getStatus().templatesFrozen).to.equal(true)
    expect(index().repos['org/llm'].snapshots[llm.sha].complete).to.equal(true)
  })

  it('selectFiles and hostPathVisible', () => {
    const sib = (rfilename: string) => ({ rfilename, size: 1, blobId: 'a'.repeat(40) })
    const all = [sib('a.json'), sib('b/c.safetensors'), sib('d.txt')]
    expect(selectFiles(all, { kind: 'all' }).files).to.have.length(3)
    expect(
      selectFiles(all, { kind: 'patterns', patterns: ['*.safetensors'] }).files.map(
        (s) => s.rfilename
      )
    ).to.deep.equal(['b/c.safetensors'])
    const r = selectFiles(all, { kind: 'files', files: ['a.json', 'missing.bin'] })
    expect(r.files.map((s) => s.rfilename)).to.deep.equal(['a.json'])
    expect(r.missing).to.deep.equal(['missing.bin'])

    expect(
      hostPathVisible('/data/cache', {
        Mounts: [{ Source: '/data', Destination: '/data' }]
      })
    ).to.equal(true)
    expect(
      hostPathVisible('/data/cache', {
        Mounts: [{ Source: '/srv/x', Destination: '/data' }]
      })
    ).to.equal(false)
    expect(
      hostPathVisible('/data/cache', {
        Mounts: [{ Source: '/data/cache', Destination: '/data/cache', RW: false }]
      })
    ).to.equal(false)
    expect(hostPathVisible('/data/cache', { Mounts: [] })).to.equal(false)
  })
})
