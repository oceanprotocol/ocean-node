import type Dockerode from 'dockerode'
import { pipeline } from 'stream'
import * as tarStream from 'tar-stream'
import type { ServiceModelDownload } from '../../@types/C2D/ServiceOnDemand.js'
import { buildModelDownload, fileSize } from './modelDownload.js'

/**
 * Download progress from a manifest the service's own launch script writes.
 *
 * Before its first download, a template script lists what it will fetch in MANIFEST_PATH, one
 * `<kind>\t<bytes>\t<path>[\t<source>]` line per item:
 *
 *   file  one file, written to `<path>.part` and renamed to `<path>` once complete
 *   dir   a folder a tool fills under names of its own (huggingface_hub's snapshot cache),
 *         measured with `du` and complete once it holds `<bytes>`
 *
 * `bytes` is what the item will weigh, or 0 when the script could not tell. A script may append
 * lines while it runs, so the file is re-read on every sample. It lives in the container's own
 * filesystem, so a new container never sees an earlier one's. Like the script that writes it, the
 * manifest is untrusted: it only ever decides what this service's own progress report says.
 */
export const MANIFEST_PATH = '/tmp/ocean/downloads.tsv'
const MAX_DOWNLOAD_ENTRIES = 64
// Each `dir` entry costs a `du` inside the container, so far fewer of them are measured.
const MAX_DIR_ENTRIES = 8
// How long after its container starts a service the node cannot probe is checked for a manifest.
// A script writes it before its first download; setup steps before that can take minutes.
export const MANIFEST_DISCOVERY_MS = 30 * 60 * 1000
// The longest a service the node cannot probe is sampled after its container starts, so a download
// that never reads as complete (an unknown size, a file that never arrives) is not sampled forever.
export const MANIFEST_SAMPLING_MS = 6 * 60 * 60 * 1000
const MAX_READ_BYTES = 64 * 1024
const BYTES = /^\d{1,13}$/

export interface DownloadEntry {
  kind: 'file' | 'dir'
  path: string
  bytes: number | null
}

/** Bytes held under a folder in the container, or null when it is not there yet. */
export type DirectoryBytes = (path: string) => Promise<number | null>

/** One small file from the container, via Docker's archive endpoint. Null when absent or too big. */
async function readContainerFile(
  container: Dockerode.Container,
  path: string
): Promise<string | null> {
  try {
    const extract = tarStream.extract()
    pipeline(await container.getArchive({ path }), extract, () => {})
    for await (const entry of extract) {
      const { type, size } = entry.header
      if (type !== 'file' || (size ?? 0) > MAX_READ_BYTES) {
        return null
      }
      const chunks: Buffer[] = []
      for await (const chunk of entry) {
        chunks.push(chunk)
      }
      return Buffer.concat(chunks).toString('utf8')
    }
    return null
  } catch {
    return null
  }
}

/**
 * The manifest's entries, capped at MAX_DOWNLOAD_ENTRIES (MAX_DIR_ENTRIES of them `dir`). `truncated`
 * says it names more than that, so the entries are not the whole download.
 */
export function parseDownloadManifest(text: string): {
  entries: DownloadEntry[]
  truncated: boolean
} {
  const entries = new Map<string, DownloadEntry>()
  let dirs = 0
  for (const line of text.split('\n')) {
    const [kind, bytes, path] = line.trim().split('\t')
    if (
      (kind !== 'file' && kind !== 'dir') ||
      !BYTES.test(bytes ?? '') ||
      !path?.startsWith('/') ||
      path.includes('\0') ||
      entries.has(path)
    ) {
      continue
    }
    if (
      entries.size >= MAX_DOWNLOAD_ENTRIES ||
      (kind === 'dir' && dirs >= MAX_DIR_ENTRIES)
    ) {
      return { entries: [...entries.values()], truncated: true }
    }
    if (kind === 'dir') {
      dirs++
    }
    entries.set(path, { kind, path, bytes: Number(bytes) || null })
  }
  return { entries: [...entries.values()], truncated: false }
}

/**
 * Bytes on disk against the sizes the entries declare. The total and the file count are reported
 * only when they are the whole download, so a truncated list never reads as complete.
 */
export async function measureDownloads(
  container: Dockerode.Container,
  entries: DownloadEntry[],
  truncated: boolean,
  directoryBytes?: DirectoryBytes
): Promise<ServiceModelDownload> {
  let downloadedBytes = 0
  let files = 0
  let inFlight = 0
  for (const { kind, path, bytes } of entries) {
    if (kind === 'dir') {
      const held = directoryBytes ? await directoryBytes(path) : null
      if (held === null) {
        continue
      }
      // Capped: a reused cache can hold more than this launch asked for.
      downloadedBytes += bytes ? Math.min(held, bytes) : held
      if (bytes && held >= bytes) {
        files++
      } else {
        inFlight++
      }
      continue
    }
    // Finished first, so a stale .part left beside it cannot hold the file in flight forever.
    const finished = await fileSize(container, path)
    if (finished !== null) {
      downloadedBytes += finished
      files++
      continue
    }
    const partial = await fileSize(container, `${path}.part`)
    if (partial !== null) {
      downloadedBytes += partial
      inFlight++
    }
  }
  const totalBytes =
    !truncated && entries.every(({ bytes }) => bytes !== null)
      ? entries.reduce((sum, { bytes }) => sum + bytes, 0)
      : null
  return {
    ...buildModelDownload({ downloadedBytes, files, inFlight }, totalBytes, null),
    ...(truncated ? {} : { filesTotal: entries.length })
  }
}

/** Progress from the launch script's manifest. Null when the script writes none. Never throws. */
export async function sampleDownloadManifest(
  container: Dockerode.Container,
  directoryBytes: DirectoryBytes
): Promise<ServiceModelDownload | null> {
  const manifest = await readContainerFile(container, MANIFEST_PATH)
  if (!manifest) {
    return null
  }
  const { entries, truncated } = parseDownloadManifest(manifest)
  if (entries.length === 0) {
    return null
  }
  try {
    return await measureDownloads(container, entries, truncated, directoryBytes)
  } catch {
    return null
  }
}
