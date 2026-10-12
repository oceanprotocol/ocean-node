import crypto from 'crypto'
import fs from 'fs'
import type { HfRevisionInfo, HfSibling } from './types.js'
import { isValidRepoFilePath, SHA1_RE, SHA256_RE } from './validate.js'

export const DEFAULT_CHUNK_BYTES = 2 * 1024 ** 3
const MAX_API_BYTES = 16 * 1024 * 1024
const MAX_SIBLINGS = 20_000
const API_TIMEOUT_MS = 30_000
const IDLE_TIMEOUT_MS = 60_000
const MAX_HOPS = 5
const MAX_CHUNK_ATTEMPTS = 4
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])

export class HfError extends Error {
  constructor(
    message: string,
    public readonly code:
      | 'not_found'
      | 'unauthorized'
      | 'rate_limited'
      | 'http'
      | 'invalid_response'
      | 'redirect'
      | 'hash_mismatch'
      | 'size_mismatch'
      | 'aborted',
    public readonly status?: number
  ) {
    super(message)
  }

  get retryable(): boolean {
    return (
      this.code === 'rate_limited' ||
      (this.code === 'http' && (this.status === undefined || this.status >= 500)) ||
      this.code === 'invalid_response'
    )
  }
}

export interface HfClientOptions {
  baseUrl?: string // tests only; never taken from config or env
  token?: () => string | undefined // read at use time; sent only to the base origin
  fetchImpl?: typeof fetch
  extraAllowedOrigins?: string[] // tests only (e.g. a stub CDN on another local port)
  idleTimeoutMs?: number
  retryDelaysMs?: number[]
}

export interface DownloadParams {
  repo: string
  commit: string
  file: string
  size: number
  hash: string // sha256 (LFS) or git blob sha1 (regular file)
  lfs: boolean
  partPath: string
  signal: AbortSignal
  chunkBytes?: number
  // Awaited before every chunk with the bytes still missing; throw to stop (disk floor,
  // config change). The .part is kept, so the next run resumes.
  beforeChunk?: (remaining: number) => Promise<void>
  // Called after every write (progress accounting).
  onBytes?: (n: number) => void
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new HfError('aborted', 'aborted'))
    const t = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(t)
      reject(new HfError('aborted', 'aborted'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

function errorFromStatus(status: number, what: string): HfError {
  if (status === 404) return new HfError(`${what}: not found`, 'not_found', status)
  if (status === 401 || status === 403) {
    return new HfError(`${what}: unauthorized (gated or private)`, 'unauthorized', status)
  }
  if (status === 429) return new HfError(`${what}: rate limited`, 'rate_limited', status)
  return new HfError(`${what}: HTTP ${status}`, 'http', status)
}

export class HfClient {
  private readonly base: URL
  private readonly fetchImpl: typeof fetch

  constructor(private readonly opts: HfClientOptions = {}) {
    this.base = new URL(opts.baseUrl ?? 'https://huggingface.co')
    this.fetchImpl = opts.fetchImpl ?? fetch
  }

  private hostAllowed(url: URL): boolean {
    if (url.origin === this.base.origin) return true
    if ((this.opts.extraAllowedOrigins ?? []).includes(url.origin)) return true
    if (url.protocol !== 'https:') return false
    const h = url.hostname
    if (/^[\d.]+$/.test(h) || h.includes(':') || h.startsWith('[')) return false
    return (
      h === 'huggingface.co' ||
      h.endsWith('.huggingface.co') ||
      h === 'hf.co' ||
      h.endsWith('.hf.co')
    )
  }

  // GET following redirects by hand: the token goes only to the base origin (the Hub sends
  // regular files through a same-origin relative redirect that needs it for gated repos),
  // never to the CDN, and every hop must stay on Hugging Face hosts.
  private async get(
    url: URL,
    headers: Record<string, string>,
    signal: AbortSignal,
    what: string
  ): Promise<Response> {
    let current = url
    for (let hop = 0; hop <= MAX_HOPS; hop++) {
      if (!this.hostAllowed(current)) {
        throw new HfError(`${what}: refusing redirect to ${current.host}`, 'redirect')
      }
      const token = this.opts.token?.()
      const res = await this.fetchImpl(current, {
        method: 'GET',
        redirect: 'manual',
        headers: {
          ...headers,
          ...(token && current.origin === this.base.origin
            ? { authorization: `Bearer ${token}` }
            : {})
        },
        signal
      })
      if (!REDIRECT_STATUSES.has(res.status)) return res
      const location = res.headers.get('location')
      await res.body?.cancel().catch(() => {})
      if (!location) throw new HfError(`${what}: redirect without location`, 'redirect')
      current = new URL(location, current)
    }
    throw new HfError(`${what}: too many redirects`, 'redirect')
  }

  async getRevisionInfo(
    repo: string,
    revision: string,
    signal: AbortSignal
  ): Promise<{ info: HfRevisionInfo; skipped: string[] }> {
    const what = `${repo}@${revision}`
    const url = new URL(
      `/api/models/${repo}/revision/${encodeURIComponent(revision)}?blobs=true`,
      this.base
    )
    const timeout = AbortSignal.timeout(API_TIMEOUT_MS)
    const res = await this.get(
      url,
      { accept: 'application/json' },
      AbortSignal.any([signal, timeout]),
      what
    )
    if (res.status !== 200) {
      await res.body?.cancel().catch(() => {})
      throw errorFromStatus(res.status, what)
    }
    const chunks: Buffer[] = []
    let total = 0
    for await (const chunk of res.body as AsyncIterable<Uint8Array>) {
      total += chunk.byteLength
      if (total > MAX_API_BYTES) {
        throw new HfError(
          `${what}: API response larger than ${MAX_API_BYTES} bytes`,
          'invalid_response'
        )
      }
      chunks.push(Buffer.from(chunk))
    }
    let body: any
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    } catch {
      throw new HfError(`${what}: API response is not JSON`, 'invalid_response')
    }
    return parseRevisionInfo(body, what)
  }

  // Downloads one file into p.partPath (resuming whatever is there) and verifies it. Leaves
  // a verified, fsynced file at partPath; the caller moves it into place.
  async downloadFile(p: DownloadParams): Promise<void> {
    const what = `${p.repo}@${p.commit.slice(0, 12)}/${p.file}`
    const chunkBytes = p.chunkBytes ?? DEFAULT_CHUNK_BYTES
    const hasher = crypto.createHash(p.lfs ? 'sha256' : 'sha1')
    if (!p.lfs) hasher.update(`blob ${p.size}\0`)
    // Positional writes at the verified length, never O_APPEND: a short write followed by
    // a failure must not leave bytes the hasher never saw in front of the retried range.
    const fh = await fs.promises.open(
      p.partPath,
      fs.constants.O_RDWR | fs.constants.O_CREAT,
      0o644
    )
    try {
      let len = (await fh.stat()).size
      if (len > p.size) {
        await fh.truncate(0)
        len = 0
      }
      if (len > 0) await hashPrefix(fh, len, hasher, p.signal, what)
      const state = { len }
      let failures = 0
      while (state.len < p.size) {
        if (p.signal.aborted) throw new HfError(`${what}: aborted`, 'aborted')
        await p.beforeChunk?.(p.size - state.len)
        const before = state.len
        try {
          await this.fetchChunk(p, what, fh, hasher, state, chunkBytes)
          if (state.len === before) {
            throw new HfError(`${what}: no bytes received`, 'invalid_response')
          }
          failures = 0
        } catch (e) {
          if (p.signal.aborted || e?.code === 'aborted') {
            throw new HfError(`${what}: aborted`, 'aborted')
          }
          // Drop anything written past what the hasher has seen.
          if ((await fh.stat()).size !== state.len) await fh.truncate(state.len)
          if (state.len > before) failures = 0
          failures++
          const retryable =
            !(e instanceof HfError) || e.retryable || e.code === 'redirect'
          if (!retryable || failures >= MAX_CHUNK_ATTEMPTS) throw e
          const delays = this.opts.retryDelaysMs ?? [1000, 5000, 15000]
          await sleep(delays[Math.min(failures - 1, delays.length - 1)], p.signal)
        }
      }
      if ((await fh.stat()).size !== p.size) {
        await fh.truncate(0)
        throw new HfError(`${what}: size on disk differs from the Hub's`, 'size_mismatch')
      }
      const digest = hasher.digest('hex')
      if (digest !== p.hash) {
        await fh.truncate(0)
        throw new HfError(`${what}: hash mismatch`, 'hash_mismatch')
      }
      await fh.sync()
    } finally {
      await fh.close()
    }
  }

  private async fetchChunk(
    p: DownloadParams,
    what: string,
    fh: fs.promises.FileHandle,
    hasher: crypto.Hash,
    state: { len: number },
    chunkBytes: number
  ): Promise<void> {
    const start = state.len
    const end = Math.min(p.size, start + chunkBytes) - 1
    const idle = new AbortController()
    const idleMs = this.opts.idleTimeoutMs ?? IDLE_TIMEOUT_MS
    let timer = setTimeout(() => idle.abort(), idleMs)
    const signal = AbortSignal.any([p.signal, idle.signal])
    try {
      const url = new URL(
        `/${p.repo}/resolve/${p.commit}/${p.file.split('/').map(encodeURIComponent).join('/')}`,
        this.base
      )
      const res = await this.get(
        url,
        { range: `bytes=${start}-${end}`, 'accept-encoding': 'identity' },
        signal,
        what
      )
      const encoding = res.headers.get('content-encoding')
      if (encoding && encoding !== 'identity') {
        await res.body?.cancel().catch(() => {})
        throw new HfError(
          `${what}: unexpected content-encoding ${encoding}`,
          'invalid_response'
        )
      }
      let expected: number
      if (res.status === 206) {
        const m = /^bytes (\d+)-(\d+)\/(\d+|\*)$/.exec(
          res.headers.get('content-range') ?? ''
        )
        if (
          !m ||
          Number(m[1]) !== start ||
          Number(m[2]) < start ||
          Number(m[2]) > end ||
          (m[3] !== '*' && Number(m[3]) !== p.size)
        ) {
          await res.body?.cancel().catch(() => {})
          throw new HfError(`${what}: bad Content-Range`, 'invalid_response')
        }
        expected = Number(m[2]) - start + 1
      } else if (res.status === 200 && start === 0) {
        expected = p.size // the server ignored Range: the whole file
      } else {
        await res.body?.cancel().catch(() => {})
        if (res.status === 200) {
          throw new HfError(`${what}: Range ignored mid-file`, 'invalid_response')
        }
        throw errorFromStatus(res.status, what)
      }
      let received = 0
      for await (const chunk of res.body as AsyncIterable<Uint8Array>) {
        clearTimeout(timer)
        timer = setTimeout(() => idle.abort(), idleMs)
        if (received + chunk.byteLength > expected) {
          throw new HfError(`${what}: response longer than requested`, 'size_mismatch')
        }
        const buf = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
        await writeAll(fh, buf, state.len)
        hasher.update(buf)
        received += buf.byteLength
        state.len += buf.byteLength
        p.onBytes?.(buf.byteLength)
      }
      if (received !== expected) {
        throw new HfError(
          `${what}: connection closed after ${received} of ${expected} bytes`,
          'http'
        )
      }
    } catch (e) {
      if (idle.signal.aborted && !p.signal.aborted) {
        throw new HfError(`${what}: no data for ${idleMs / 1000} s`, 'http')
      }
      throw e
    } finally {
      clearTimeout(timer)
    }
  }
}

async function writeAll(
  fh: fs.promises.FileHandle,
  buf: Buffer,
  position: number
): Promise<void> {
  let off = 0
  while (off < buf.byteLength) {
    const { bytesWritten } = await fh.write(
      buf,
      off,
      buf.byteLength - off,
      position + off
    )
    if (bytesWritten === 0) throw new Error('write made no progress')
    off += bytesWritten
  }
}

async function hashPrefix(
  fh: fs.promises.FileHandle,
  len: number,
  hasher: crypto.Hash,
  signal: AbortSignal,
  what: string
): Promise<void> {
  const buf = Buffer.allocUnsafe(8 * 1024 * 1024)
  let pos = 0
  while (pos < len) {
    if (signal.aborted) throw new HfError(`${what}: aborted`, 'aborted')
    const { bytesRead } = await fh.read(buf, 0, Math.min(buf.byteLength, len - pos), pos)
    if (bytesRead === 0) throw new Error('short read while resuming a partial download')
    hasher.update(buf.subarray(0, bytesRead))
    pos += bytesRead
  }
}

// RegExp.test stringifies its argument (["<hex>"] would pass), so check the type first.
function isHex(value: unknown, re: RegExp): value is string {
  return typeof value === 'string' && re.test(value)
}

export function parseRevisionInfo(
  body: any,
  what: string
): { info: HfRevisionInfo; skipped: string[] } {
  if (!body || typeof body !== 'object' || !isHex(body.sha, SHA1_RE)) {
    throw new HfError(`${what}: API response has no commit sha`, 'invalid_response')
  }
  if (!Array.isArray(body.siblings) || body.siblings.length > MAX_SIBLINGS) {
    throw new HfError(`${what}: API response has no usable file list`, 'invalid_response')
  }
  const skipped: string[] = []
  const siblings: HfSibling[] = []
  for (const s of body.siblings) {
    const name = s?.rfilename
    const sizeOk = Number.isSafeInteger(s?.size) && s.size >= 0
    const blobOk = isHex(s?.blobId, SHA1_RE)
    const lfs = s?.lfs
    const lfsOk =
      lfs === undefined ||
      lfs === null ||
      (isHex(lfs.sha256, SHA256_RE) && lfs.size === s.size)
    if (!isValidRepoFilePath(name) || !sizeOk || !blobOk || !lfsOk) {
      skipped.push(typeof name === 'string' ? name : '<unnamed>')
      continue
    }
    siblings.push({
      rfilename: name,
      size: s.size,
      blobId: s.blobId,
      ...(lfs ? { lfs: { sha256: lfs.sha256, size: lfs.size } } : {})
    })
  }
  // Fail closed: only an explicit false means "not gated".
  const gated = body.gated === false ? false : String(body.gated ?? 'unknown')
  return {
    info: {
      id: String(body.id ?? ''),
      sha: body.sha,
      private: body.private === true,
      gated,
      disabled: body.disabled === true,
      siblings
    },
    skipped
  }
}
