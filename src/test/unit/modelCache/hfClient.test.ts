import { expect } from 'chai'
import crypto from 'crypto'
import fs from 'fs'
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse
} from 'http'
import type { AddressInfo } from 'net'
import os from 'os'
import path from 'path'
import zlib from 'zlib'
import {
  HfClient,
  HfError,
  parseRevisionInfo,
  type DownloadParams,
  type HfClientOptions
} from '../../../components/modelCache/hfClient.js'

// HfClient against two local servers: `base` plays huggingface.co (the API, resolve/ and the
// same-origin /api/resolve-cache hop), `cdn` plays the LFS/Xet CDN on another origin, let in
// through extraAllowedOrigins the way the signed CDN hosts are in production. Every fetch
// goes through a guard that refuses anything but 127.0.0.1, so no test can reach the
// internet, even when the client is pointed at a redirect off-host.

const REPO = 'acme/tiny-model'
const COMMIT = 'c0ffee'.repeat(6) + 'c0ff'
const TOKEN = 'hf_test_token_123'
const BLOB_A = 'abcdef0123'.repeat(4)
const BLOB_B = '0123abcdef'.repeat(4)
const SHA_A = 'fedcba9876'.repeat(6) + 'fedc'
// git blob sha1 of the empty file ("blob 0\0") and sha256 of no bytes
const EMPTY_GIT_SHA1 = 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391'
const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
const MAX_API_BYTES = 16 * 1024 * 1024
const API_MAIN = `/api/models/${REPO}/revision/main?blobs=true`

type Handler = (req: IncomingMessage, res: ServerResponse) => void

interface SeenRequest {
  method: string
  url: string
  headers: IncomingMessage['headers']
}

function notFound(req: IncomingMessage, res: ServerResponse): void {
  res.writeHead(404, { 'content-type': 'text/plain' })
  res.end(`no route for ${req.url}`)
}

class StubServer {
  origin = ''
  seen: SeenRequest[] = []
  handler: Handler = notFound
  private readonly server: Server

  constructor() {
    this.server = createServer((req, res) => {
      this.seen.push({ method: req.method, url: req.url, headers: req.headers })
      req.on('error', () => {})
      res.on('error', () => {})
      this.handler(req, res)
    })
  }

  start(): Promise<void> {
    return new Promise((resolve) => {
      this.server.listen(0, '127.0.0.1', () => {
        const { port } = this.server.address() as AddressInfo
        this.origin = `http://127.0.0.1:${port}`
        resolve()
      })
    })
  }

  reset(): void {
    this.seen = []
    this.handler = notFound
  }

  stop(): Promise<void> {
    this.server.closeAllConnections()
    return new Promise((resolve) => {
      this.server.close(() => resolve())
    })
  }
}

const base = new StubServer()
const cdn = new StubServer()
const fetched: string[] = []
let token: string | undefined
let tmp: string

// The client's fetch: records every URL and refuses anything that is not a local stub.
const guardedFetch: typeof fetch = (input, init) => {
  const href = input instanceof Request ? input.url : String(input)
  fetched.push(href)
  if (new URL(href).hostname !== '127.0.0.1') {
    return Promise.reject(new Error(`test guard: refusing to fetch ${href}`))
  }
  return fetch(input, init)
}

function client(over: Partial<HfClientOptions> = {}): HfClient {
  return new HfClient({
    baseUrl: base.origin,
    token: () => token,
    fetchImpl: guardedFetch,
    extraAllowedOrigins: [cdn.origin],
    idleTimeoutMs: 2000,
    retryDelaysMs: [5, 5, 5],
    ...over
  })
}

function gitBlobSha1(b: Buffer): string {
  return crypto.createHash('sha1').update(`blob ${b.length}\0`).update(b).digest('hex')
}

function sha256(b: Buffer): string {
  return crypto.createHash('sha256').update(b).digest('hex')
}

const partPath = () => path.join(tmp, 'blob.part')
const readPart = () => fs.promises.readFile(partPath())
const partSize = async () => (await fs.promises.stat(partPath())).size
const encodePath = (file: string) => file.split('/').map(encodeURIComponent).join('/')
const resolvePath = (file: string) => `/${REPO}/resolve/${COMMIT}/${encodePath(file)}`
const ranges = (s: StubServer) => s.seen.map((r) => r.headers.range)
const signal = () => new AbortController().signal
// The distinct content codings a request accepted. Node's fetch (undici) follows the Fetch
// spec and appends `Accept-Encoding: identity` itself whenever a Range header is present,
// so with the client's explicit identity the wire value is "identity, identity".
const codings = (s: SeenRequest) => [
  ...new Set(
    String(s.headers['accept-encoding'] ?? '')
      .split(',')
      .map((c) => c.trim())
  )
]
const flipped = (b: Buffer) => Buffer.from(b.map((x) => x ^ 0xff))

function regular(content: Buffer, over: Partial<DownloadParams> = {}): DownloadParams {
  return {
    repo: REPO,
    commit: COMMIT,
    file: 'config.json',
    size: content.length,
    hash: gitBlobSha1(content),
    lfs: false,
    partPath: partPath(),
    signal: signal(),
    chunkBytes: 1024,
    ...over
  }
}

function lfs(content: Buffer, over: Partial<DownloadParams> = {}): DownloadParams {
  return regular(content, {
    file: 'model.safetensors',
    hash: sha256(content),
    lfs: true,
    ...over
  })
}

async function settle(p: Promise<unknown>): Promise<any> {
  try {
    await p
  } catch (e) {
    return e
  }
  return undefined
}

function thrown(fn: () => unknown): any {
  try {
    fn()
  } catch (e) {
    return e
  }
  return undefined
}

function requestedRange(req: IncomingMessage): { start: number; end: number } | null {
  const m = /^bytes=(\d+)-(\d+)$/.exec(String(req.headers.range ?? ''))
  return m ? { start: Number(m[1]), end: Number(m[2]) } : null
}

// An honest range server: 206 with the requested slice, or 200 with everything.
function serveRange(req: IncomingMessage, res: ServerResponse, content: Buffer): void {
  const r = requestedRange(req)
  if (!r) {
    res.writeHead(200, { 'content-length': content.length })
    res.end(content)
    return
  }
  const end = Math.min(r.end, content.length - 1)
  const body = content.subarray(r.start, end + 1)
  res.writeHead(206, {
    'content-range': `bytes ${r.start}-${end}/${content.length}`,
    'content-length': body.length
  })
  res.end(body)
}

function json(status: number, body: unknown): Handler {
  return (req, res) => {
    const data = Buffer.from(JSON.stringify(body))
    res.writeHead(status, {
      'content-type': 'application/json',
      'content-length': data.length
    })
    res.end(data)
  }
}

function redirect(status: number, location: string): Handler {
  return (req, res) => {
    res.writeHead(status, { location })
    res.end()
  }
}

// resolve/ answers the bytes itself (as the Hub does for 0-byte files); for the tests that
// are about the final answer rather than the redirect.
function hubDirect(file: string, serve: Handler): void {
  base.handler = (req, res) =>
    req.url === resolvePath(file) ? serve(req, res) : notFound(req, res)
}

// A regular (non-LFS) file: resolve/ answers 307 with a RELATIVE Location into
// /api/resolve-cache on the same origin, which serves the bytes.
const RESOLVE_CACHE = `/api/resolve-cache/models/${REPO}/${COMMIT}/config.json?etag=%22abc%22`
function hubRegular(content: Buffer): void {
  base.handler = (req, res) => {
    if (req.url === resolvePath('config.json'))
      return redirect(307, RESOLVE_CACHE)(req, res)
    if (req.url === RESOLVE_CACHE) return serveRange(req, res, content)
    notFound(req, res)
  }
}

// An LFS/Xet file: resolve/ answers 302 with an absolute signed URL on the CDN origin.
function hubLfs(content: Buffer): string {
  const signed = `/repos/ab/cd/${sha256(content)}?X-Amz-Signature=secret-signature&X-Amz-Expires=3600`
  base.handler = (req, res) => {
    if (req.url === resolvePath('model.safetensors')) {
      return redirect(302, cdn.origin + signed)(req, res)
    }
    notFound(req, res)
  }
  cdn.handler = (req, res) => serveRange(req, res, content)
  return signed
}

function revisionBody(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: REPO,
    sha: COMMIT,
    private: false,
    gated: false,
    disabled: false,
    siblings: [
      { rfilename: 'config.json', size: 16, blobId: BLOB_A },
      {
        rfilename: 'weights/model.safetensors',
        size: 1000,
        blobId: BLOB_B,
        lfs: { sha256: SHA_A, size: 1000, pointerSize: 134 }
      }
    ],
    ...over
  }
}

// Exactly n bytes of valid revision JSON (whitespace padding), so only a size cap can
// reject it.
function paddedRevisionJson(n: number): Buffer {
  const buf = Buffer.alloc(n, 0x20)
  buf.write(`{"sha":"${COMMIT}","siblings":[]`, 0)
  buf.write('}', n - 1)
  return buf
}

describe('modelCache HfClient', () => {
  before(async () => {
    await base.start()
    await cdn.start()
  })

  after(async () => {
    await base.stop()
    await cdn.stop()
  })

  beforeEach(async () => {
    base.reset()
    cdn.reset()
    fetched.length = 0
    token = TOKEN
    tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hfclient-test-'))
  })

  afterEach(async () => {
    await fs.promises.rm(tmp, { recursive: true, force: true })
  })

  describe('getRevisionInfo', () => {
    it('parses a 200 answer and asks for blobs with the token as Bearer', async () => {
      base.handler = json(200, revisionBody())
      const { info, skipped } = await client().getRevisionInfo(REPO, 'main', signal())
      expect(info).to.deep.equal({
        id: REPO,
        sha: COMMIT,
        private: false,
        gated: false,
        disabled: false,
        siblings: [
          { rfilename: 'config.json', size: 16, blobId: BLOB_A },
          {
            rfilename: 'weights/model.safetensors',
            size: 1000,
            blobId: BLOB_B,
            lfs: { sha256: SHA_A, size: 1000 }
          }
        ]
      })
      expect(skipped).to.deep.equal([])
      expect(base.seen).to.have.length(1)
      expect(base.seen[0].method).to.equal('GET')
      expect(base.seen[0].url).to.equal(API_MAIN)
      expect(base.seen[0].headers.authorization).to.equal(`Bearer ${TOKEN}`)
      expect(base.seen[0].headers.accept).to.equal('application/json')
    })

    it('reports gated as the Hub value ("auto", "manual") and false as false', async () => {
      const cases: [unknown, unknown][] = [
        ['auto', 'auto'],
        ['manual', 'manual'],
        [false, false],
        [true, 'true'],
        // anything but an explicit false stays gated (fail closed), a missing field too
        [null, 'unknown'],
        [undefined, 'unknown']
      ]
      for (const [gated, expected] of cases) {
        base.handler = json(200, revisionBody({ gated }))
        const { info } = await client().getRevisionInfo(REPO, 'main', signal())
        expect(info.gated, `gated: ${gated}`).to.equal(expected)
      }
    })

    it('carries private and disabled', async () => {
      base.handler = json(200, revisionBody({ private: true }))
      let { info } = await client().getRevisionInfo(REPO, 'main', signal())
      expect(info.private).to.equal(true)
      expect(info.disabled).to.equal(false)

      base.handler = json(200, revisionBody({ disabled: true }))
      ;({ info } = await client().getRevisionInfo(REPO, 'main', signal()))
      expect(info.private).to.equal(false)
      expect(info.disabled).to.equal(true)
    })

    it('skips siblings with unusable names, sizes or hashes and names them', async () => {
      const bad: unknown[] = [
        { rfilename: '../escape.bin', size: 1, blobId: BLOB_A },
        { rfilename: '/etc/passwd', size: 1, blobId: BLOB_A },
        { rfilename: 'a//b.bin', size: 1, blobId: BLOB_A },
        { rfilename: 'dir/./x.bin', size: 1, blobId: BLOB_A },
        { rfilename: 'dir/../x.bin', size: 1, blobId: BLOB_A },
        { rfilename: 'back\\slash.bin', size: 1, blobId: BLOB_A },
        { rfilename: 'bell\u0007.bin', size: 1, blobId: BLOB_A },
        { rfilename: `${'x'.repeat(256)}.bin`, size: 1, blobId: BLOB_A },
        { rfilename: 'short-blob.bin', size: 1, blobId: 'abc123' },
        { rfilename: 'upper-blob.bin', size: 1, blobId: BLOB_A.toUpperCase() },
        { rfilename: 'no-blob.bin', size: 1 },
        { rfilename: 'negative.bin', size: -1, blobId: BLOB_A },
        { rfilename: 'fraction.bin', size: 1.5, blobId: BLOB_A },
        { rfilename: 'string-size.bin', size: '16', blobId: BLOB_A },
        {
          rfilename: 'lfs-size.bin',
          size: 10,
          blobId: BLOB_A,
          lfs: { sha256: SHA_A, size: 11 }
        },
        {
          rfilename: 'lfs-sha.bin',
          size: 10,
          blobId: BLOB_A,
          lfs: { sha256: 'not-a-sha', size: 10 }
        },
        {
          rfilename: 'lfs-sha1.bin',
          size: 10,
          blobId: BLOB_A,
          lfs: { sha256: BLOB_A, size: 10 }
        },
        { rfilename: 'lfs-string.bin', size: 10, blobId: BLOB_A, lfs: 'yes' },
        { rfilename: 42, size: 1, blobId: BLOB_A },
        null
      ]
      const good = { rfilename: 'ok.json', size: 2, blobId: BLOB_B }
      base.handler = json(
        200,
        revisionBody({ siblings: [bad[0], good, ...bad.slice(1)] })
      )
      const { info, skipped } = await client().getRevisionInfo(REPO, 'main', signal())
      expect(info.siblings).to.deep.equal([good])
      expect(skipped).to.deep.equal([
        '../escape.bin',
        '/etc/passwd',
        'a//b.bin',
        'dir/./x.bin',
        'dir/../x.bin',
        'back\\slash.bin',
        'bell\u0007.bin',
        `${'x'.repeat(256)}.bin`,
        'short-blob.bin',
        'upper-blob.bin',
        'no-blob.bin',
        'negative.bin',
        'fraction.bin',
        'string-size.bin',
        'lfs-size.bin',
        'lfs-sha.bin',
        'lfs-sha1.bin',
        'lfs-string.bin',
        '<unnamed>',
        '<unnamed>'
      ])
    })

    it('rejects an answer without a 40-hex commit sha as invalid_response', async () => {
      const bodies: unknown[] = [
        revisionBody({ sha: undefined }),
        revisionBody({ sha: COMMIT.slice(0, 39) }),
        revisionBody({ sha: COMMIT + 'a' }),
        revisionBody({ sha: COMMIT.toUpperCase() }),
        revisionBody({ sha: 42 }),
        [],
        'just a string',
        null
      ]
      for (const body of bodies) {
        base.handler = json(200, body)
        const err = await settle(client().getRevisionInfo(REPO, 'main', signal()))
        expect(err, JSON.stringify(body)).to.be.instanceOf(HfError)
        expect(err.code, JSON.stringify(body)).to.equal('invalid_response')
        expect(err.retryable).to.equal(true)
      }
    })

    it('rejects a body that is not JSON as invalid_response', async () => {
      base.handler = (req, res) => {
        res.writeHead(200, { 'content-type': 'text/html' })
        res.end('<html>Too many requests</html>')
      }
      const err = await settle(client().getRevisionInfo(REPO, 'main', signal()))
      expect(err).to.be.instanceOf(HfError)
      expect(err.code).to.equal('invalid_response')
    })

    it('decodes a gzip answer', async () => {
      const gz = zlib.gzipSync(JSON.stringify(revisionBody()))
      base.handler = (req, res) => {
        res.writeHead(200, {
          'content-type': 'application/json',
          'content-encoding': 'gzip',
          'content-length': gz.length
        })
        res.end(gz)
      }
      const { info } = await client().getRevisionInfo(REPO, 'main', signal())
      expect(info.sha).to.equal(COMMIT)
      expect(info.siblings).to.have.length(2)
    })

    it('accepts a body of exactly 16 MiB and rejects one byte more', async () => {
      const exact = paddedRevisionJson(MAX_API_BYTES)
      base.handler = (req, res) => {
        res.writeHead(200, { 'content-length': exact.length })
        res.end(exact)
      }
      const ok = await client().getRevisionInfo(REPO, 'main', signal())
      expect(ok.info.sha).to.equal(COMMIT)

      // still valid JSON: without the cap this would parse
      const over = paddedRevisionJson(MAX_API_BYTES + 1)
      base.handler = (req, res) => {
        res.writeHead(200, { 'content-length': over.length })
        res.end(over)
      }
      const err = await settle(client().getRevisionInfo(REPO, 'main', signal()))
      expect(err).to.be.instanceOf(HfError)
      expect(err.code).to.equal('invalid_response')
      expect(err.message).to.include('larger than')
    })

    it('stops reading an endless streamed answer at the 16 MiB cap', async () => {
      base.handler = (req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' })
        const chunk = Buffer.alloc(1024 * 1024, 0x20)
        let open = true
        res.on('close', () => {
          open = false
        })
        const pump = (): void => {
          for (;;) {
            if (!open) return
            if (!res.write(chunk)) {
              res.once('drain', pump)
              return
            }
          }
        }
        pump()
      }
      const err = await settle(
        client().getRevisionInfo(REPO, 'main', AbortSignal.timeout(10_000))
      )
      expect(err).to.be.instanceOf(HfError)
      expect(err.code).to.equal('invalid_response')
      expect(err.message).to.include('larger than')
    })

    it('applies the cap to the decoded body (a small gzip answer cannot blow it up)', async () => {
      const bomb = zlib.gzipSync(paddedRevisionJson(MAX_API_BYTES + 1024 * 1024))
      expect(bomb.length).to.be.below(1024 * 1024)
      base.handler = (req, res) => {
        res.writeHead(200, {
          'content-type': 'application/json',
          'content-encoding': 'gzip',
          'content-length': bomb.length
        })
        res.end(bomb)
      }
      const err = await settle(client().getRevisionInfo(REPO, 'main', signal()))
      expect(err).to.be.instanceOf(HfError)
      expect(err.code).to.equal('invalid_response')
      expect(err.message).to.include('larger than')
    })

    it('maps HTTP errors: 404 not_found, 401/403 unauthorized, 429 rate_limited, others http', async () => {
      const cases: [number, string, boolean][] = [
        [404, 'not_found', false],
        [401, 'unauthorized', false],
        [403, 'unauthorized', false],
        [429, 'rate_limited', true],
        [500, 'http', true],
        [503, 'http', true],
        [400, 'http', false]
      ]
      for (const [status, code, retryable] of cases) {
        base.reset()
        base.handler = json(status, { error: 'nope' })
        const err = await settle(client().getRevisionInfo(REPO, 'main', signal()))
        expect(err, String(status)).to.be.instanceOf(HfError)
        expect(err.code, String(status)).to.equal(code)
        expect(err.status, String(status)).to.equal(status)
        expect(err.retryable, String(status)).to.equal(retryable)
        expect(base.seen, String(status)).to.have.length(1) // the caller decides on retries
      }
    })

    it('follows a same-origin relative redirect (renamed repo) with the token on both hops', async () => {
      const old = '/api/models/acme/old-name/revision/main?blobs=true'
      base.handler = (req, res) => {
        if (req.url === old) return redirect(307, API_MAIN)(req, res)
        if (req.url === API_MAIN) return json(200, revisionBody())(req, res)
        notFound(req, res)
      }
      const { info } = await client().getRevisionInfo('acme/old-name', 'main', signal())
      expect(info.sha).to.equal(COMMIT)
      expect(base.seen.map((s) => s.url)).to.deep.equal([old, API_MAIN])
      expect(base.seen.map((s) => s.headers.authorization)).to.deep.equal([
        `Bearer ${TOKEN}`,
        `Bearer ${TOKEN}`
      ])
    })

    it('never sends the token to another origin it is redirected to', async () => {
      base.handler = redirect(302, `${cdn.origin}/mirror${API_MAIN}`)
      cdn.handler = json(200, revisionBody())
      const { info } = await client().getRevisionInfo(REPO, 'main', signal())
      expect(info.sha).to.equal(COMMIT)
      expect(base.seen[0].headers.authorization).to.equal(`Bearer ${TOKEN}`)
      expect(cdn.seen).to.have.length(1)
      expect(cdn.seen[0].url).to.equal(`/mirror${API_MAIN}`)
      expect(cdn.seen[0].headers).to.not.have.property('authorization')
    })

    it('sends no authorization header without a token', async () => {
      for (const t of [undefined, '']) {
        token = t
        base.reset()
        base.handler = json(200, revisionBody())
        await client().getRevisionInfo(REPO, 'main', signal())
        expect(base.seen[0].headers, `token ${t}`).to.not.have.property('authorization')
      }
      base.reset()
      base.handler = json(200, revisionBody())
      const noTokenOption = new HfClient({
        baseUrl: base.origin,
        fetchImpl: guardedFetch
      })
      await noTokenOption.getRevisionInfo(REPO, 'main', signal())
      expect(base.seen[0].headers).to.not.have.property('authorization')
    })

    it('reads the token at use time', async () => {
      const c = client()
      base.handler = json(200, revisionBody())
      token = 'hf_first'
      await c.getRevisionInfo(REPO, 'main', signal())
      token = 'hf_second'
      await c.getRevisionInfo(REPO, 'main', signal())
      expect(base.seen.map((s) => s.headers.authorization)).to.deep.equal([
        'Bearer hf_first',
        'Bearer hf_second'
      ])
    })

    it('encodes the revision as one path segment', async () => {
      base.handler = json(200, revisionBody())
      await client().getRevisionInfo(REPO, 'refs/pr/1', signal())
      expect(base.seen[0].url).to.equal(
        `/api/models/${REPO}/revision/refs%2Fpr%2F1?blobs=true`
      )
    })

    it('refuses redirects off the allow-list without fetching them', async () => {
      const targets = [
        'https://evil.example/api?X-Amz-Signature=top-secret',
        'http://cdn-lfs.huggingface.co/x', // a Hugging Face host, but not https
        'https://huggingface.co.evil.example/x',
        'https://evilhuggingface.co/x',
        'https://1.2.3.4/x',
        'https://[::1]/x',
        'http://127.0.0.1:1/x', // local, but neither the base nor an allowed origin
        'file:///etc/passwd',
        '//evil.example/x' // protocol-relative: http://evil.example
      ]
      for (const location of targets) {
        base.reset()
        base.handler = redirect(302, location)
        const err = await settle(client().getRevisionInfo(REPO, 'main', signal()))
        expect(err, location).to.be.instanceOf(HfError)
        expect(err.code, location).to.equal('redirect')
        expect(err.message, location).to.not.include('top-secret')
        expect(base.seen, location).to.have.length(1)
      }
      expect(fetched.filter((u) => !u.startsWith(base.origin + '/'))).to.deep.equal([])
    })

    it('follows at most 5 redirects', async () => {
      const chain =
        (hops: number): Handler =>
        (req, res) => {
          const n =
            req.url === API_MAIN ? 0 : Number(/^\/hop\/(\d+)$/.exec(req.url)?.[1] ?? -1)
          if (n < 0) return notFound(req, res)
          if (n < hops) return redirect(302, `/hop/${n + 1}`)(req, res)
          json(200, revisionBody())(req, res)
        }
      base.handler = chain(5)
      const ok = await client().getRevisionInfo(REPO, 'main', signal())
      expect(ok.info.sha).to.equal(COMMIT)
      expect(base.seen).to.have.length(6)

      base.reset()
      base.handler = chain(6)
      const err = await settle(client().getRevisionInfo(REPO, 'main', signal()))
      expect(err).to.be.instanceOf(HfError)
      expect(err.code).to.equal('redirect')
      expect(err.message).to.include('too many redirects')
      expect(base.seen).to.have.length(6)
    })

    it('rejects a redirect without Location', async () => {
      base.handler = (req, res) => {
        res.writeHead(302)
        res.end()
      }
      const err = await settle(client().getRevisionInfo(REPO, 'main', signal()))
      expect(err).to.be.instanceOf(HfError)
      expect(err.code).to.equal('redirect')
    })

    it('stops waiting when the caller aborts', async () => {
      base.handler = () => {} // never answers
      const ac = new AbortController()
      setTimeout(() => ac.abort(), 50)
      const t0 = Date.now()
      const err = await settle(client().getRevisionInfo(REPO, 'main', ac.signal))
      expect(err).to.be.instanceOf(Error)
      expect(Date.now() - t0).to.be.below(2000)
    })
  })

  describe('HfError', () => {
    it('is retryable only for rate limits, 5xx / connection-level http errors and invalid answers', () => {
      const cases: [HfError, boolean][] = [
        [new HfError('x', 'rate_limited', 429), true],
        [new HfError('x', 'http', 500), true],
        [new HfError('x', 'http', 503), true],
        [new HfError('x', 'http'), true], // early close / idle timeout: no status
        [new HfError('x', 'invalid_response'), true],
        [new HfError('x', 'http', 400), false],
        [new HfError('x', 'http', 416), false],
        [new HfError('x', 'not_found', 404), false],
        [new HfError('x', 'unauthorized', 401), false],
        [new HfError('x', 'redirect'), false],
        [new HfError('x', 'hash_mismatch'), false],
        [new HfError('x', 'size_mismatch'), false],
        [new HfError('x', 'aborted'), false]
      ]
      for (const [err, retryable] of cases) {
        expect(err.retryable, `${err.code} ${err.status}`).to.equal(retryable)
        expect(err).to.be.instanceOf(Error)
      }
    })
  })

  describe('parseRevisionInfo', () => {
    it('rejects a missing or non-array sibling list', () => {
      for (const siblings of [undefined, {}, 'config.json', null]) {
        const err = thrown(() => parseRevisionInfo({ sha: COMMIT, siblings }, 'x'))
        expect(err, String(siblings)).to.be.instanceOf(HfError)
        expect(err.code).to.equal('invalid_response')
      }
    })

    it('accepts 20000 siblings and rejects 20001', () => {
      const list = (n: number) =>
        Array.from({ length: n }, (_, i) => ({
          rfilename: `shard-${i}.bin`,
          size: i,
          blobId: BLOB_A
        }))
      const { info } = parseRevisionInfo({ sha: COMMIT, siblings: list(20_000) }, 'x')
      expect(info.siblings).to.have.length(20_000)
      const err = thrown(() =>
        parseRevisionInfo({ sha: COMMIT, siblings: list(20_001) }, 'x')
      )
      expect(err).to.be.instanceOf(HfError)
      expect(err.code).to.equal('invalid_response')
    })

    it('keeps a 0-byte file and treats lfs: null as a regular file', () => {
      const { info, skipped } = parseRevisionInfo(
        {
          sha: COMMIT,
          siblings: [
            { rfilename: 'empty.txt', size: 0, blobId: EMPTY_GIT_SHA1 },
            { rfilename: 'plain.txt', size: 3, blobId: BLOB_A, lfs: null }
          ]
        },
        'x'
      )
      expect(skipped).to.deep.equal([])
      expect(info.siblings).to.deep.equal([
        { rfilename: 'empty.txt', size: 0, blobId: EMPTY_GIT_SHA1 },
        { rfilename: 'plain.txt', size: 3, blobId: BLOB_A }
      ])
      expect(info.id).to.equal('')
    })
  })

  describe('downloadFile: Hub redirect flows', () => {
    it('regular file: follows the 307 RELATIVE redirect into /api/resolve-cache, token on both hops', async () => {
      const data = crypto.randomBytes(37)
      hubRegular(data)
      await client().downloadFile(regular(data))
      expect(await readPart()).to.deep.equal(data)
      expect(base.seen.map((s) => s.url)).to.deep.equal([
        resolvePath('config.json'),
        RESOLVE_CACHE
      ])
      for (const s of base.seen) {
        expect(s.headers.authorization).to.equal(`Bearer ${TOKEN}`)
        expect(s.headers.range).to.equal('bytes=0-36')
        expect(codings(s)).to.deep.equal(['identity'])
      }
      expect(cdn.seen).to.have.length(0)
    })

    it('LFS file: follows the 302 to the CDN origin with the same Range and no token', async () => {
      const data = crypto.randomBytes(37)
      const signed = hubLfs(data)
      await client().downloadFile(lfs(data))
      expect(await readPart()).to.deep.equal(data)
      expect(base.seen).to.have.length(1)
      expect(base.seen[0].url).to.equal(resolvePath('model.safetensors'))
      expect(base.seen[0].headers.authorization).to.equal(`Bearer ${TOKEN}`)
      expect(cdn.seen).to.have.length(1)
      expect(cdn.seen[0].url).to.equal(signed)
      expect(cdn.seen[0].headers).to.not.have.property('authorization')
      expect(cdn.seen[0].headers.range).to.equal('bytes=0-36')
      expect(codings(cdn.seen[0])).to.deep.equal(['identity'])
    })

    it('errors on the CDN hop never carry the signed URL', async () => {
      const data = crypto.randomBytes(16)
      hubLfs(data)
      cdn.handler = json(500, { error: 'cdn down' })
      let err = await settle(client().downloadFile(lfs(data)))
      expect(err).to.be.instanceOf(HfError)
      expect(err.code).to.equal('http')
      expect(err.message).to.include(`${REPO}@${COMMIT.slice(0, 12)}/model.safetensors`)
      expect(err.message).to.not.include('secret-signature')
      expect(err.message).to.not.include(cdn.origin)

      cdn.reset()
      cdn.handler = () => {} // stalls
      err = await settle(client({ idleTimeoutMs: 60 }).downloadFile(lfs(data)))
      expect(err).to.be.instanceOf(HfError)
      expect(err.message).to.include('no data for')
      expect(err.message).to.not.include('secret-signature')
    })

    it('follows https redirects to Hugging Face CDN hosts without the token (fake fetch, no network)', async () => {
      const data = crypto.randomBytes(12)
      const hosts = [
        'cas-bridge.xethub.hf.co',
        'cdn-lfs.huggingface.co',
        'cdn-lfs-us-1.hf.co',
        'huggingface.co'
      ]
      for (const host of hosts) {
        base.reset()
        hubDirect(
          'model.safetensors',
          redirect(302, `https://${host}/blob/${sha256(data)}?Signature=sig`)
        )
        const seen: { host: string; auth: string; range: string; enc: string }[] = []
        const fakeFetch: typeof fetch = (input, init) => {
          const url = new URL(String(input))
          const h = new Headers(init?.headers)
          seen.push({
            host: url.host,
            auth: h.get('authorization'),
            range: h.get('range'),
            enc: h.get('accept-encoding')
          })
          if (url.hostname === '127.0.0.1') return fetch(input, init)
          if (url.host !== host)
            return Promise.reject(new Error(`unexpected ${url.host}`))
          const m = /^bytes=(\d+)-(\d+)$/.exec(h.get('range') ?? '')
          const [s, e] = [Number(m[1]), Number(m[2])]
          return Promise.resolve(
            new Response(new Uint8Array(data.subarray(s, e + 1)), {
              status: 206,
              headers: { 'content-range': `bytes ${s}-${e}/${data.length}` }
            })
          )
        }
        await client({ fetchImpl: fakeFetch }).downloadFile(
          lfs(data, { partPath: path.join(tmp, `${host}.part`) })
        )
        expect(await fs.promises.readFile(path.join(tmp, `${host}.part`))).to.deep.equal(
          data
        )
        expect(seen, host).to.deep.equal([
          {
            host: new URL(base.origin).host,
            auth: `Bearer ${TOKEN}`,
            range: 'bytes=0-11',
            enc: 'identity'
          },
          { host, auth: null, range: 'bytes=0-11', enc: 'identity' }
        ])
      }
    })

    it('production defaults: the token goes to https://huggingface.co only, never to the Xet bridge', async () => {
      const data = crypto.randomBytes(12)
      const xet = `/xet-bridge-us/${sha256(data)}`
      const seen: { origin: string; path: string; auth: string }[] = []
      const fakeFetch: typeof fetch = (input, init) => {
        const url = new URL(String(input))
        const h = new Headers(init?.headers)
        seen.push({
          origin: url.origin,
          path: url.pathname,
          auth: h.get('authorization')
        })
        if (url.origin === 'https://huggingface.co') {
          if (url.pathname === `/api/models/${REPO}/revision/main`) {
            return Promise.resolve(
              new Response(JSON.stringify(revisionBody()), {
                status: 200,
                headers: { 'content-type': 'application/json' }
              })
            )
          }
          if (url.pathname === resolvePath('model.safetensors')) {
            return Promise.resolve(
              new Response(null, {
                status: 302,
                headers: {
                  location: `https://cas-bridge.xethub.hf.co${xet}?X-Xet-Signed-Range=bytes%3D0-11&Signature=sig`
                }
              })
            )
          }
        }
        if (url.origin === 'https://cas-bridge.xethub.hf.co' && url.pathname === xet) {
          return Promise.resolve(
            new Response(new Uint8Array(data), {
              status: 206,
              headers: { 'content-range': `bytes 0-11/${data.length}` }
            })
          )
        }
        return Promise.reject(new Error(`unexpected ${url.href}`))
      }
      const c = new HfClient({
        token: () => TOKEN,
        fetchImpl: fakeFetch,
        retryDelaysMs: [1]
      })
      const { info } = await c.getRevisionInfo(REPO, 'main', signal())
      expect(info.sha).to.equal(COMMIT)
      await c.downloadFile(lfs(data))
      expect(await readPart()).to.deep.equal(data)
      expect(seen).to.deep.equal([
        {
          origin: 'https://huggingface.co',
          path: `/api/models/${REPO}/revision/main`,
          auth: `Bearer ${TOKEN}`
        },
        {
          origin: 'https://huggingface.co',
          path: resolvePath('model.safetensors'),
          auth: `Bearer ${TOKEN}`
        },
        { origin: 'https://cas-bridge.xethub.hf.co', path: xet, auth: null }
      ])
    })

    it('percent-encodes each path segment of the file name', async () => {
      const data = crypto.randomBytes(8)
      const file = 'sub dir/my model+v1#[x].safetensors'
      hubDirect(file, (req, res) => serveRange(req, res, data))
      await client().downloadFile(regular(data, { file }))
      expect(base.seen[0].url).to.equal(
        `/${REPO}/resolve/${COMMIT}/sub%20dir/my%20model%2Bv1%23%5Bx%5D.safetensors`
      )
      expect(await readPart()).to.deep.equal(data)
    })
  })

  describe('downloadFile: hashing', () => {
    it('0-byte regular file: no request at all, empty part, git blob sha1 e69de29b', async () => {
      const remaining: number[] = []
      await client().downloadFile(
        regular(Buffer.alloc(0), {
          hash: EMPTY_GIT_SHA1,
          beforeChunk: (n) => {
            remaining.push(n)
            return Promise.resolve()
          }
        })
      )
      expect(fetched).to.deep.equal([])
      expect(base.seen).to.have.length(0)
      expect(remaining).to.deep.equal([])
      expect(await partSize()).to.equal(0)
    })

    it('0-byte LFS file: no request at all, empty part, sha256 e3b0c442', async () => {
      await client().downloadFile(lfs(Buffer.alloc(0), { hash: EMPTY_SHA256 }))
      expect(fetched).to.deep.equal([])
      expect(await partSize()).to.equal(0)
    })

    it('0-byte file checked against the other algorithm is a hash_mismatch, still without a request', async () => {
      let err = await settle(
        client().downloadFile(regular(Buffer.alloc(0), { hash: EMPTY_SHA256 }))
      )
      expect(err).to.be.instanceOf(HfError)
      expect(err.code).to.equal('hash_mismatch')
      err = await settle(
        client().downloadFile(lfs(Buffer.alloc(0), { hash: EMPTY_GIT_SHA1 }))
      )
      expect(err).to.be.instanceOf(HfError)
      expect(err.code).to.equal('hash_mismatch')
      expect(fetched).to.deep.equal([])
    })

    it('regular files are git blobs: the git sha1 passes, the plain sha1 of the bytes does not', async () => {
      const data = crypto.randomBytes(21)
      hubDirect('config.json', (req, res) => serveRange(req, res, data))
      const plainSha1 = crypto.createHash('sha1').update(data).digest('hex')
      const err = await settle(client().downloadFile(regular(data, { hash: plainSha1 })))
      expect(err).to.be.instanceOf(HfError)
      expect(err.code).to.equal('hash_mismatch')
      expect(await partSize()).to.equal(0)

      await client().downloadFile(regular(data))
      expect(await readPart()).to.deep.equal(data)
    })

    it('LFS files are plain sha256: the sha256 passes, the git blob sha1 does not', async () => {
      const data = crypto.randomBytes(21)
      hubLfs(data)
      const err = await settle(
        client().downloadFile(lfs(data, { hash: gitBlobSha1(data) }))
      )
      expect(err).to.be.instanceOf(HfError)
      expect(err.code).to.equal('hash_mismatch')
      expect(await partSize()).to.equal(0)

      await client().downloadFile(lfs(data))
      expect(await readPart()).to.deep.equal(data)
    })

    it('hash mismatch: truncates the part, fails with hash_mismatch, does not retry', async () => {
      const data = crypto.randomBytes(16)
      hubDirect('config.json', (req, res) => serveRange(req, res, flipped(data)))
      const err = await settle(client().downloadFile(regular(data)))
      expect(err).to.be.instanceOf(HfError)
      expect(err.code).to.equal('hash_mismatch')
      expect(err.message).to.include(`${REPO}@${COMMIT.slice(0, 12)}/config.json`)
      expect(base.seen).to.have.length(1)
      expect(await partSize()).to.equal(0)
    })
  })

  describe('downloadFile: chunking and Range validation', () => {
    it('downloads in chunkBytes Range requests (last one short) and reports remaining bytes and progress', async () => {
      const data = crypto.randomBytes(10)
      hubDirect('config.json', (req, res) => serveRange(req, res, data))
      const remaining: number[] = []
      let progressed = 0
      await client().downloadFile(
        regular(data, {
          chunkBytes: 4,
          beforeChunk: (n) => {
            remaining.push(n)
            return Promise.resolve()
          },
          onBytes: (n) => {
            progressed += n
            return Promise.resolve()
          }
        })
      )
      expect(ranges(base)).to.deep.equal(['bytes=0-3', 'bytes=4-7', 'bytes=8-9'])
      expect(remaining).to.deep.equal([10, 6, 2])
      expect(progressed).to.equal(10)
      expect(await readPart()).to.deep.equal(data)
    })

    it('chunks through the CDN: every chunk resolves on the base origin, then fetches its Range on the CDN', async () => {
      const data = crypto.randomBytes(16)
      hubLfs(data)
      await client().downloadFile(lfs(data, { chunkBytes: 5 }))
      const expected = ['bytes=0-4', 'bytes=5-9', 'bytes=10-14', 'bytes=15-15']
      expect(ranges(base)).to.deep.equal(expected)
      expect(ranges(cdn)).to.deep.equal(expected)
      expect(base.seen.map((s) => s.headers.authorization)).to.deep.equal(
        expected.map(() => `Bearer ${TOKEN}`)
      )
      expect(cdn.seen.map((s) => s.headers.authorization)).to.deep.equal(
        expected.map((): string => undefined)
      )
      expect(await readPart()).to.deep.equal(data)
    })

    it('handles MiB-sized ranges that arrive in many network chunks', async () => {
      const data = crypto.randomBytes(3 * 1024 * 1024 + 123)
      hubLfs(data)
      let progressed = 0
      await client().downloadFile(
        lfs(data, {
          chunkBytes: 1_000_003,
          onBytes: (n) => {
            progressed += n
            return Promise.resolve()
          }
        })
      )
      expect(ranges(cdn)).to.deep.equal([
        'bytes=0-1000002',
        'bytes=1000003-2000005',
        'bytes=2000006-3000008',
        `bytes=3000009-${data.length - 1}`
      ])
      expect(progressed).to.equal(data.length)
      expect((await readPart()).equals(data)).to.equal(true)
    })

    it('accepts a shorter but consistent 206 and asks for the rest next', async () => {
      const data = crypto.randomBytes(10)
      hubDirect('config.json', (req, res) => {
        const r = requestedRange(req)
        const end = Math.min(r.end, r.start + 2) // at most 3 bytes per answer
        const body = data.subarray(r.start, end + 1)
        res.writeHead(206, {
          'content-range': `bytes ${r.start}-${end}/${data.length}`,
          'content-length': body.length
        })
        res.end(body)
      })
      await client().downloadFile(regular(data, { chunkBytes: 4 }))
      expect(ranges(base)).to.deep.equal([
        'bytes=0-3',
        'bytes=3-6',
        'bytes=6-9',
        'bytes=9-9'
      ])
      expect(await readPart()).to.deep.equal(data)
    })

    it('accepts a 206 whose total is unknown (*)', async () => {
      const data = crypto.randomBytes(10)
      hubDirect('config.json', (req, res) => {
        const r = requestedRange(req)
        const body = data.subarray(r.start, r.end + 1)
        res.writeHead(206, {
          'content-range': `bytes ${r.start}-${r.end}/*`,
          'content-length': body.length
        })
        res.end(body)
      })
      await client().downloadFile(regular(data, { chunkBytes: 4 }))
      expect(await readPart()).to.deep.equal(data)
    })

    it('accepts a 200 (Range ignored) at offset 0 as the whole file, in one request', async () => {
      const data = crypto.randomBytes(10)
      hubDirect('config.json', (req, res) => {
        res.writeHead(200, { 'content-length': data.length })
        res.end(data)
      })
      await client().downloadFile(regular(data, { chunkBytes: 4 }))
      expect(ranges(base)).to.deep.equal(['bytes=0-3'])
      expect(await readPart()).to.deep.equal(data)
    })

    it('rejects a 200 (Range ignored) mid-file after retries, never appending to the part', async () => {
      const data = crypto.randomBytes(10)
      await fs.promises.writeFile(partPath(), data.subarray(0, 4))
      hubDirect('config.json', (req, res) => {
        res.writeHead(200, { 'content-length': data.length })
        res.end(data)
      })
      const err = await settle(client().downloadFile(regular(data, { chunkBytes: 4 })))
      expect(err).to.be.instanceOf(HfError)
      expect(err.code).to.equal('invalid_response')
      expect(err.message).to.include('Range ignored mid-file')
      expect(ranges(base)).to.deep.equal([
        'bytes=4-7',
        'bytes=4-7',
        'bytes=4-7',
        'bytes=4-7'
      ])
      expect(await readPart()).to.deep.equal(data.subarray(0, 4))
    })

    const badContentRanges: [string, (s: number, e: number, size: number) => string][] = [
      [
        'a start other than the requested one',
        (s, e, size) => `bytes ${s + 1}-${e}/${size}`
      ],
      ['an end past the requested end', (s, e, size) => `bytes ${s}-${e + 1}/${size}`],
      ['a total other than the file size', (s, e, size) => `bytes ${s}-${e}/${size + 1}`],
      ['a malformed value', (s, e) => `bytes=${s}-${e}`],
      ['no value at all', () => undefined]
    ]
    for (const [label, contentRange] of badContentRanges) {
      it(`rejects a 206 with ${label} (retried, then invalid_response, nothing written)`, async () => {
        const data = crypto.randomBytes(10)
        hubDirect('config.json', (req, res) => {
          const r = requestedRange(req)
          const body = data.subarray(r.start, r.end + 1)
          const value = contentRange(r.start, r.end, data.length)
          res.writeHead(206, {
            ...(value ? { 'content-range': value } : {}),
            'content-length': body.length
          })
          res.end(body)
        })
        const err = await settle(client().downloadFile(regular(data, { chunkBytes: 4 })))
        expect(err).to.be.instanceOf(HfError)
        expect(err.code).to.equal('invalid_response')
        expect(err.message).to.include('bad Content-Range')
        expect(base.seen).to.have.length(4)
        expect(await partSize()).to.equal(0)
      })
    }

    it('rejects a gzip content-encoding even on a well-formed 206', async () => {
      const data = crypto.randomBytes(10)
      hubDirect('config.json', (req, res) => {
        const r = requestedRange(req)
        const gz = zlib.gzipSync(data.subarray(r.start, r.end + 1))
        res.writeHead(206, {
          'content-range': `bytes ${r.start}-${r.end}/${data.length}`,
          'content-encoding': 'gzip',
          'content-length': gz.length
        })
        res.end(gz)
      })
      const err = await settle(client().downloadFile(regular(data)))
      expect(err).to.be.instanceOf(HfError)
      expect(err.code).to.equal('invalid_response')
      expect(err.message).to.include('content-encoding gzip')
      expect(base.seen.map(codings)).to.deep.equal([
        ['identity'],
        ['identity'],
        ['identity'],
        ['identity']
      ])
      expect(await partSize()).to.equal(0)
    })

    it('accepts an explicit identity content-encoding', async () => {
      const data = crypto.randomBytes(10)
      hubDirect('config.json', (req, res) => {
        const r = requestedRange(req)
        const body = data.subarray(r.start, r.end + 1)
        res.writeHead(206, {
          'content-range': `bytes ${r.start}-${r.end}/${data.length}`,
          'content-encoding': 'identity',
          'content-length': body.length
        })
        res.end(body)
      })
      await client().downloadFile(regular(data))
      expect(await readPart()).to.deep.equal(data)
    })

    it('rejects a body longer than its Content-Range and never writes past it', async () => {
      const data = crypto.randomBytes(16)
      hubDirect('config.json', (req, res) => {
        const body = data.subarray(0, 8) // 8 bytes for a range that announces 0-3
        res.writeHead(206, {
          'content-range': `bytes 0-3/${data.length}`,
          'content-length': body.length
        })
        res.end(body)
      })
      const err = await settle(client().downloadFile(regular(data)))
      expect(err).to.be.instanceOf(HfError)
      expect(err.code).to.equal('size_mismatch')
      expect(base.seen.length).to.be.within(1, 4)
      const part = await readPart()
      expect(part.length).to.be.at.most(4)
      expect(part).to.deep.equal(data.subarray(0, part.length))
    })

    it('rejects a 200 at offset 0 whose body is longer than the file', async () => {
      const data = crypto.randomBytes(16)
      const longer = Buffer.concat([data, crypto.randomBytes(4)])
      hubDirect('config.json', (req, res) => {
        res.writeHead(200, { 'content-length': longer.length })
        res.end(longer)
      })
      const err = await settle(client().downloadFile(regular(data)))
      expect(err).to.be.instanceOf(HfError)
      expect(err.code).to.equal('size_mismatch')
      const part = await readPart()
      expect(part.length).to.be.at.most(data.length)
      expect(part).to.deep.equal(data.subarray(0, part.length))
    })
  })

  describe('downloadFile: retries and timeouts', () => {
    it('a body that ends early is retried from where it stopped, then succeeds', async () => {
      const data = crypto.randomBytes(16)
      let n = 0
      hubDirect('config.json', (req, res) => {
        const r = requestedRange(req)
        if (n++ === 0) {
          // announce the whole range, send 7 bytes, end cleanly (chunked encoding)
          res.writeHead(206, {
            'content-range': `bytes ${r.start}-${r.end}/${data.length}`
          })
          res.end(data.subarray(r.start, r.start + 7))
          return
        }
        serveRange(req, res, data)
      })
      const remaining: number[] = []
      await client().downloadFile(
        regular(data, {
          beforeChunk: (left) => {
            remaining.push(left)
            return Promise.resolve()
          }
        })
      )
      expect(ranges(base)).to.deep.equal(['bytes=0-15', 'bytes=7-15'])
      expect(remaining).to.deep.equal([16, 9])
      expect(await readPart()).to.deep.equal(data)
    })

    it('a connection reset mid-body is retried from the bytes already written', async () => {
      const data = crypto.randomBytes(16)
      let n = 0
      hubDirect('config.json', (req, res) => {
        if (n++ === 0) {
          res.writeHead(206, {
            'content-range': `bytes 0-15/${data.length}`,
            'content-length': data.length
          })
          res.write(data.subarray(0, 7))
          setTimeout(() => res.socket?.destroy(), 50)
          return
        }
        serveRange(req, res, data)
      })
      await client().downloadFile(regular(data))
      expect(ranges(base)).to.deep.equal(['bytes=0-15', 'bytes=7-15'])
      expect(await readPart()).to.deep.equal(data)
    })

    it('retries 5xx and 429 answers, then succeeds', async () => {
      const data = crypto.randomBytes(16)
      const statuses = [503, 429]
      hubDirect('config.json', (req, res) => {
        const status = statuses.shift()
        if (status) return json(status, { error: 'busy' })(req, res)
        serveRange(req, res, data)
      })
      await client().downloadFile(regular(data))
      expect(base.seen).to.have.length(3)
      expect(await readPart()).to.deep.equal(data)
    })

    it('gives up after 4 attempts that make no progress', async () => {
      const data = crypto.randomBytes(16)
      hubDirect('config.json', json(500, { error: 'down' }))
      const err = await settle(client().downloadFile(regular(data)))
      expect(err).to.be.instanceOf(HfError)
      expect(err.code).to.equal('http')
      expect(err.status).to.equal(500)
      expect(base.seen).to.have.length(4)
    })

    it('does not retry 404, 401 and 403', async () => {
      const data = crypto.randomBytes(16)
      const cases: [number, string][] = [
        [404, 'not_found'],
        [401, 'unauthorized'],
        [403, 'unauthorized']
      ]
      for (const [status, code] of cases) {
        base.reset()
        hubDirect('config.json', json(status, { error: 'no' }))
        const err = await settle(client().downloadFile(regular(data)))
        expect(err, String(status)).to.be.instanceOf(HfError)
        expect(err.code, String(status)).to.equal(code)
        expect(base.seen, String(status)).to.have.length(1)
      }
    })

    it('an attempt that made progress resets the attempt budget', async () => {
      const data = crypto.randomBytes(6)
      hubDirect('config.json', (req, res) => {
        const r = requestedRange(req)
        // 1 byte per answer, then a clean early end: 6 attempts, more than the budget of 4
        res.writeHead(206, {
          'content-range': `bytes ${r.start}-${r.end}/${data.length}`
        })
        res.end(data.subarray(r.start, r.start + 1))
      })
      await client().downloadFile(regular(data))
      expect(ranges(base)).to.deep.equal([
        'bytes=0-5',
        'bytes=1-5',
        'bytes=2-5',
        'bytes=3-5',
        'bytes=4-5',
        'bytes=5-5'
      ])
      expect(await readPart()).to.deep.equal(data)
    })

    it('idle timeout: a server that stalls mid-body is abandoned and the rest fetched again', async () => {
      const data = crypto.randomBytes(16)
      let n = 0
      hubDirect('config.json', (req, res) => {
        if (n++ === 0) {
          res.writeHead(206, {
            'content-range': `bytes 0-15/${data.length}`,
            'content-length': data.length
          })
          res.write(data.subarray(0, 5)) // then nothing
          return
        }
        serveRange(req, res, data)
      })
      const t0 = Date.now()
      await client({ idleTimeoutMs: 150 }).downloadFile(regular(data))
      expect(ranges(base)).to.deep.equal(['bytes=0-15', 'bytes=5-15'])
      expect(await readPart()).to.deep.equal(data)
      expect(Date.now() - t0).to.be.below(2000)
    })

    it('idle timeout also covers a server that never answers', async () => {
      const data = crypto.randomBytes(16)
      let n = 0
      hubDirect('config.json', (req, res) => {
        if (n++ === 0) return // no headers, no body
        serveRange(req, res, data)
      })
      await client({ idleTimeoutMs: 150 }).downloadFile(regular(data))
      expect(ranges(base)).to.deep.equal(['bytes=0-15', 'bytes=0-15'])
      expect(await readPart()).to.deep.equal(data)
    })

    it('a stall on every attempt ends with an http error after the retry budget', async () => {
      const data = crypto.randomBytes(16)
      hubDirect('config.json', () => {}) // never answers
      const err = await settle(client({ idleTimeoutMs: 60 }).downloadFile(regular(data)))
      expect(err).to.be.instanceOf(HfError)
      expect(err.code).to.equal('http')
      expect(err.message).to.include('no data for')
      expect(base.seen).to.have.length(4)
    })
  })

  describe('downloadFile: resuming a .part', () => {
    it('asks only for the missing range and re-hashes the prefix (regular, git sha1)', async () => {
      const data = crypto.randomBytes(16)
      await fs.promises.writeFile(partPath(), data.subarray(0, 6))
      hubDirect('config.json', (req, res) => serveRange(req, res, data))
      const remaining: number[] = []
      let progressed = 0
      await client().downloadFile(
        regular(data, {
          beforeChunk: (n) => {
            remaining.push(n)
            return Promise.resolve()
          },
          onBytes: (n) => {
            progressed += n
            return Promise.resolve()
          }
        })
      )
      expect(ranges(base)).to.deep.equal(['bytes=6-15'])
      expect(remaining).to.deep.equal([10])
      expect(progressed).to.equal(10)
      expect(await readPart()).to.deep.equal(data)
    })

    it('asks only for the missing range and re-hashes the prefix (LFS, sha256, via the CDN)', async () => {
      const data = crypto.randomBytes(16)
      await fs.promises.writeFile(partPath(), data.subarray(0, 9))
      hubLfs(data)
      await client().downloadFile(lfs(data, { chunkBytes: 4 }))
      expect(ranges(cdn)).to.deep.equal(['bytes=9-12', 'bytes=13-15'])
      expect(await readPart()).to.deep.equal(data)
    })

    it('a corrupt prefix fails the hash check: the prefix is hashed from disk, not trusted', async () => {
      const data = crypto.randomBytes(16)
      await fs.promises.writeFile(partPath(), flipped(data.subarray(0, 6)))
      hubDirect('config.json', (req, res) => serveRange(req, res, data))
      const err = await settle(client().downloadFile(regular(data)))
      expect(err).to.be.instanceOf(HfError)
      expect(err.code).to.equal('hash_mismatch')
      expect(ranges(base)).to.deep.equal(['bytes=6-15'])
      expect(await partSize()).to.equal(0)
    })

    it('a .part that is already complete is only verified: no request', async () => {
      const data = crypto.randomBytes(16)
      await fs.promises.writeFile(partPath(), data)
      const remaining: number[] = []
      await client().downloadFile(
        regular(data, {
          beforeChunk: (n) => {
            remaining.push(n)
            return Promise.resolve()
          }
        })
      )
      expect(fetched).to.deep.equal([])
      expect(remaining).to.deep.equal([])
      expect(await readPart()).to.deep.equal(data)
    })

    it('a complete but corrupt .part is truncated with hash_mismatch, without a request', async () => {
      const data = crypto.randomBytes(16)
      await fs.promises.writeFile(partPath(), flipped(data))
      const err = await settle(client().downloadFile(lfs(data)))
      expect(err).to.be.instanceOf(HfError)
      expect(err.code).to.equal('hash_mismatch')
      expect(fetched).to.deep.equal([])
      expect(await partSize()).to.equal(0)
    })

    it('a .part longer than the file is truncated and downloaded again from 0', async () => {
      const data = crypto.randomBytes(16)
      await fs.promises.writeFile(
        partPath(),
        Buffer.concat([data, crypto.randomBytes(8)])
      )
      hubDirect('config.json', (req, res) => serveRange(req, res, data))
      await client().downloadFile(regular(data))
      expect(ranges(base)).to.deep.equal(['bytes=0-15'])
      expect(await readPart()).to.deep.equal(data)
    })
  })

  describe('downloadFile: redirect policy', () => {
    it('refuses a redirect to a host off the allow-list (https://evil.example) and never contacts it', async () => {
      const data = crypto.randomBytes(16)
      hubDirect(
        'model.safetensors',
        redirect(302, 'https://evil.example/blob?X-Amz-Signature=top-secret')
      )
      const err = await settle(client().downloadFile(lfs(data)))
      expect(err).to.be.instanceOf(HfError)
      expect(err.code).to.equal('redirect')
      expect(err.message).to.include('evil.example')
      expect(err.message).to.not.include('top-secret')
      expect(fetched.filter((u) => !u.startsWith(base.origin + '/'))).to.deep.equal([])
      expect(base.seen.length).to.be.within(1, 4)
      expect(cdn.seen).to.have.length(0)
      expect(await partSize()).to.equal(0)
    })

    it('refuses a plain-http redirect even to a Hugging Face host', async () => {
      const data = crypto.randomBytes(16)
      hubDirect(
        'model.safetensors',
        redirect(302, 'http://cdn-lfs.huggingface.co/blob?Signature=sig')
      )
      const err = await settle(client().downloadFile(lfs(data)))
      expect(err).to.be.instanceOf(HfError)
      expect(err.code).to.equal('redirect')
      expect(fetched.filter((u) => !u.startsWith(base.origin + '/'))).to.deep.equal([])
    })

    it('too many redirects fails with a redirect error', async () => {
      const data = crypto.randomBytes(16)
      base.handler = (req, res) => redirect(302, `/loop/${base.seen.length}`)(req, res)
      const err = await settle(client().downloadFile(regular(data)))
      expect(err).to.be.instanceOf(HfError)
      expect(err.code).to.equal('redirect')
      expect(err.message).to.include('too many redirects')
      // 1 request + 5 followed redirects per attempt
      expect(base.seen.length % 6).to.equal(0)
      expect(base.seen.length).to.be.within(6, 24)
    })
  })

  describe('downloadFile: abort and caller hooks', () => {
    it('an already aborted signal fails with aborted before any request', async () => {
      const data = crypto.randomBytes(16)
      const ac = new AbortController()
      ac.abort()
      hubDirect('config.json', (req, res) => serveRange(req, res, data))
      const err = await settle(
        client().downloadFile(regular(data, { signal: ac.signal }))
      )
      expect(err).to.be.instanceOf(HfError)
      expect(err.code).to.equal('aborted')
      expect(base.seen).to.have.length(0)
    })

    it('aborting mid-body fails with aborted and keeps the bytes already written', async () => {
      const data = crypto.randomBytes(16)
      const ac = new AbortController()
      hubDirect('config.json', (req, res) => {
        res.writeHead(206, {
          'content-range': `bytes 0-15/${data.length}`,
          'content-length': data.length
        })
        res.write(data.subarray(0, 5)) // then stall
      })
      let written = 0
      const err = await settle(
        client({ idleTimeoutMs: 10_000 }).downloadFile(
          regular(data, {
            signal: ac.signal,
            onBytes: (n) => {
              written += n
              ac.abort()
              return Promise.resolve()
            }
          })
        )
      )
      expect(err).to.be.instanceOf(HfError)
      expect(err.code).to.equal('aborted')
      expect(written).to.be.within(1, 5)
      expect(await readPart()).to.deep.equal(data.subarray(0, written))
      expect(base.seen).to.have.length(1)
    })

    it('aborting during the retry backoff fails with aborted at once', async () => {
      const data = crypto.randomBytes(16)
      hubDirect('config.json', json(503, { error: 'busy' }))
      const ac = new AbortController()
      const t0 = Date.now()
      setTimeout(() => ac.abort(), 100)
      const err = await settle(
        client({ retryDelaysMs: [10_000] }).downloadFile(
          regular(data, { signal: ac.signal })
        )
      )
      expect(err).to.be.instanceOf(HfError)
      expect(err.code).to.equal('aborted')
      expect(Date.now() - t0).to.be.below(2000)
      expect(base.seen).to.have.length(1)
    })

    it('a throwing beforeChunk (disk floor) stops the download unretried and keeps the part', async () => {
      const data = crypto.randomBytes(10)
      hubDirect('config.json', (req, res) => serveRange(req, res, data))
      let calls = 0
      const err = await settle(
        client().downloadFile(
          regular(data, {
            chunkBytes: 4,
            beforeChunk: () =>
              ++calls === 2
                ? Promise.reject(new Error('below the disk floor'))
                : Promise.resolve()
          })
        )
      )
      expect(err).to.be.instanceOf(Error)
      expect(err.message).to.equal('below the disk floor')
      expect(base.seen).to.have.length(1)
      expect(await readPart()).to.deep.equal(data.subarray(0, 4))
    })
  })

  // Kept last: under mocha's bail these expose source defects (see the report) without
  // hiding the behaviour suites above.
  describe('strict validation edge cases', () => {
    it('rejects a commit sha that is not a string (a one-element array stringifies to a valid sha)', () => {
      const err = thrown(() => parseRevisionInfo({ sha: [COMMIT], siblings: [] }, 'x'))
      expect(err).to.be.instanceOf(HfError)
      expect(err.code).to.equal('invalid_response')
    })

    it('skips siblings whose blobId or lfs.sha256 is not a string', () => {
      const { info, skipped } = parseRevisionInfo(
        {
          sha: COMMIT,
          siblings: [
            { rfilename: 'a.bin', size: 1, blobId: [BLOB_A] },
            {
              rfilename: 'b.bin',
              size: 1,
              blobId: BLOB_A,
              lfs: { sha256: [SHA_A], size: 1 }
            }
          ]
        },
        'x'
      )
      expect(info.siblings).to.deep.equal([])
      expect(skipped).to.deep.equal(['a.bin', 'b.bin'])
    })

    it('treats an answer without a gated field as gated (design: gated !== false => skip)', () => {
      const { info } = parseRevisionInfo({ sha: COMMIT, siblings: [] }, 'x')
      expect(info.gated).to.not.equal(false)
    })

    it('a 206 whose Content-Range ends before it starts (empty body) fails instead of looping', async () => {
      const data = crypto.randomBytes(10)
      await fs.promises.writeFile(partPath(), data.subarray(0, 4))
      hubDirect('config.json', (req, res) => {
        const r = requestedRange(req)
        res.writeHead(206, {
          'content-range': `bytes ${r.start}-${r.start - 1}/${data.length}`,
          'content-length': 0
        })
        res.end()
      })
      const ac = new AbortController()
      let chunks = 0
      const err = await settle(
        client().downloadFile(
          regular(data, {
            signal: ac.signal,
            // safety net so a looping client cannot hang the suite
            beforeChunk: () => {
              if (++chunks > 20) ac.abort()
              return Promise.resolve()
            }
          })
        )
      )
      expect(err).to.be.instanceOf(HfError)
      expect(err.code, `gave up only after ${base.seen.length} requests`).to.not.equal(
        'aborted'
      )
      expect(base.seen.length).to.be.at.most(4)
    })
  })
})
