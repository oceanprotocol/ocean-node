import type Dockerode from 'dockerode'
import type { ServiceModelDownload } from '../../@types/C2D/ServiceOnDemand.js'
import { cachedHubLookup, HF_TIMEOUT_MS } from './modelDownload.js'
import {
  MAX_DOWNLOAD_ENTRIES,
  measureDownloads,
  readContainerFile
} from './downloadManifest.js'

/**
 * Model-download progress for ComfyUI bundle scripts that predate the download manifest (see
 * downloadManifest), read from the list they keep for their own download loop.
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

/**
 * The list's destinations, capped at MAX_DOWNLOAD_ENTRIES. `truncated` says the list names more than that,
 * so the entries are not the whole download.
 */
export function parseComfyModelList(
  text: string,
  base: string
): { entries: ComfyModelEntry[]; truncated: boolean } {
  const entries = new Map<string, ComfyModelEntry>()
  for (const line of text.split('\n')) {
    const [dir, url] = line.trim().split('\t')
    if (!MODEL_DIR.test(dir) || !url || !isHubFileUrl(url)) {
      continue
    }
    // Same destination the script derives: `$MODELS/$sub/$(basename "$url")`.
    const path = `${base}/models/${dir}/${url.slice(url.lastIndexOf('/') + 1)}`
    if (entries.has(path)) {
      continue
    }
    if (entries.size >= MAX_DOWNLOAD_ENTRIES) {
      return { entries: [...entries.values()], truncated: true }
    }
    entries.set(path, { url, path })
  }
  return { entries: [...entries.values()], truncated: false }
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
  const { entries, truncated } = parseComfyModelList(list.text, base)
  if (entries.length === 0) {
    return null
  }
  // A truncated list is not the whole download: no sizes, so no total or file count that would
  // declare it complete early.
  const sizes: (number | null)[] = truncated
    ? entries.map((): null => null)
    : await Promise.all(
        entries.map(({ url }) => cachedHubLookup(url, () => lookupHubFileBytes(url)))
      )
  return await measureDownloads(
    container,
    entries.map(({ path }, i) => ({ kind: 'file' as const, path, bytes: sizes[i] })),
    truncated
  )
}
