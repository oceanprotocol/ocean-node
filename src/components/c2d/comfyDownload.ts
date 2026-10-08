import type Dockerode from 'dockerode'
import { pipeline } from 'stream'
import * as tarStream from 'tar-stream'
import type { ServiceModelDownload } from '../../@types/C2D/ServiceOnDemand.js'
import {
  buildModelDownload,
  cachedHubLookup,
  fileSize,
  HF_TIMEOUT_MS
} from './modelDownload.js'

/**
 * Model-download progress for the ComfyUI bundle templates.
 *
 * Before fetching anything, a bundle's script lists the weights its workflows need in
 * `<base>/.models.tsv`, one `<dir>\t<url>` line each. It then downloads them with curl to
 * `<base>/models/<dir>/<file>.part`, renaming each to `<file>` once its size checks out. `<base>` is
 * `/data/outputs/comfy` when a bucket is mounted, `/tmp/comfy` otherwise.
 *
 * The script is client-supplied, so the list is untrusted: only plain Hugging Face file URLs are
 * kept, and those are the only addresses the node ever contacts on its behalf.
 */

const MODEL_LIST_FILE = '.models.tsv'
const MAX_LIST_BYTES = 64 * 1024
const MAX_ENTRIES = 64
const MODEL_DIR = /^[a-z0-9_]{1,32}$/
const URL_SEGMENT = /^[\w.-]+$/

export interface ComfyModelEntry {
  url: string
  path: string
}

export function comfyBaseDir(hasBucket: boolean): string {
  return hasBucket ? '/data/outputs/comfy' : '/tmp/comfy'
}

/** `https://huggingface.co/<org>/<repo>/resolve/<rev>/<path>.safetensors`, exactly. */
function isHubFileUrl(value: string): boolean {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }
  // Rebuilt from the parsed path, so a query, credentials, a port or a normalized `..` all fail.
  if (value !== `https://huggingface.co${url.pathname}`) {
    return false
  }
  const segments = url.pathname.split('/').slice(1)
  return (
    segments.length >= 5 &&
    segments[2] === 'resolve' &&
    segments.every((segment) => URL_SEGMENT.test(segment)) &&
    url.pathname.endsWith('.safetensors')
  )
}

export function parseComfyModelList(text: string, base: string): ComfyModelEntry[] {
  const entries = new Map<string, ComfyModelEntry>()
  for (const line of text.split('\n')) {
    if (entries.size >= MAX_ENTRIES) {
      break
    }
    const [dir, url] = line.trim().split('\t')
    if (!MODEL_DIR.test(dir) || !url || !isHubFileUrl(url)) {
      continue
    }
    // Same destination the script derives: `$MODELS/$sub/$(basename "$url")`.
    const path = `${base}/models/${dir}/${url.slice(url.lastIndexOf('/') + 1)}`
    if (!entries.has(path)) {
      entries.set(path, { url, path })
    }
  }
  return [...entries.values()]
}

/** One small file from the container, via Docker's archive endpoint. Null when absent or too big. */
async function readContainerFile(
  container: Dockerode.Container,
  path: string
): Promise<{ text: string; mtime: number } | null> {
  try {
    const extract = tarStream.extract()
    pipeline(await container.getArchive({ path }), extract, () => {})
    for await (const entry of extract) {
      const { type, size, mtime } = entry.header
      if (type !== 'file' || (size ?? 0) > MAX_LIST_BYTES) {
        return null
      }
      const chunks: Buffer[] = []
      for await (const chunk of entry) {
        chunks.push(chunk)
      }
      return {
        text: Buffer.concat(chunks).toString('utf8'),
        mtime: mtime?.getTime() ?? 0
      }
    }
    return null
  } catch {
    return null
  }
}

/**
 * A file's size from the Hub without downloading it. A file in large-file storage answers with a
 * redirect to the CDN whose `X-Linked-Size` is the file's size; a small one is served directly.
 */
async function lookupHubFileBytes(url: string): Promise<number | null | undefined> {
  try {
    const response = await fetch(url, {
      method: 'HEAD',
      redirect: 'manual',
      signal: AbortSignal.timeout(HF_TIMEOUT_MS)
    })
    if (response.status >= 400) {
      // Missing, or gated without a token: asking again will not change the answer.
      return [401, 403, 404].includes(response.status) ? null : undefined
    }
    const size = Number(
      response.headers.get('x-linked-size') ??
        (response.ok ? response.headers.get('content-length') : null)
    )
    return size > 0 ? size : null
  } catch {
    return undefined
  }
}

/**
 * Bytes on disk against the size of everything the list names. Null until the list exists — and,
 * in a reused bucket, until this launch has rewritten the previous one (hence the mtime check).
 * Never throws.
 */
export async function sampleComfyModelDownload(
  container: Dockerode.Container,
  hasBucket: boolean,
  startedAt: number
): Promise<ServiceModelDownload | null> {
  const base = comfyBaseDir(hasBucket)
  const list = await readContainerFile(container, `${base}/${MODEL_LIST_FILE}`)
  // tar keeps whole seconds, hence the one-second slack.
  if (!list || list.mtime < startedAt - 1000) {
    return null
  }
  const entries = parseComfyModelList(list.text, base)
  if (entries.length === 0) {
    return null
  }
  const sizes = await Promise.all(
    entries.map(({ url }) => cachedHubLookup(url, () => lookupHubFileBytes(url)))
  )
  let downloadedBytes = 0
  let files = 0
  let inFlight = 0
  for (const { path } of entries) {
    // Partial first: a file renamed between the two checks is then still found finished.
    const partial = await fileSize(container, `${path}.part`)
    if (partial !== null) {
      downloadedBytes += partial
      inFlight++
      continue
    }
    const finished = await fileSize(container, path)
    if (finished !== null) {
      downloadedBytes += finished
      files++
    }
  }
  const totalBytes = sizes.every((size) => size !== null)
    ? sizes.reduce((sum, size) => sum + size, 0)
    : null
  return {
    ...buildModelDownload({ downloadedBytes, files, inFlight }, totalBytes, null),
    filesTotal: entries.length
  }
}
