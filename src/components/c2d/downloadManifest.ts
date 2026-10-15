import type Dockerode from 'dockerode'
import { pipeline } from 'stream'
import * as tarStream from 'tar-stream'
import type { ServiceModelDownload } from '../../@types/C2D/ServiceOnDemand.js'
import { buildModelDownload, fileSize } from './modelDownload.js'

/**
 * Download progress from a manifest the service's launch script writes before its first download,
 * one `<kind>\t<bytes>\t<path>[\t<source>]` line per item (`bytes` 0 = unknown):
 *
 *   file  written to `<path>.part`, renamed to `<path>` once complete
 *   dir   a folder filled under names of its own, measured with `du`
 *
 * Re-read on every sample, since the script may append to it. Untrusted: it only affects this
 * service's own progress report.
 */
export const MANIFEST_PATH = '/tmp/ocean/downloads.tsv'
const MAX_DOWNLOAD_ENTRIES = 64
// Each `dir` entry costs a `du` inside the container.
const MAX_DIR_ENTRIES = 8
// For a service the node cannot probe: how long after start to look for a manifest, and the
// longest it is sampled, so a download that never completes is not sampled forever.
export const MANIFEST_DISCOVERY_MS = 30 * 60 * 1000
export const MANIFEST_SAMPLING_MS = 6 * 60 * 60 * 1000
const MAX_READ_BYTES = 64 * 1024
const BYTES = /^\d{1,13}$/

export interface DownloadEntry {
  kind: 'file' | 'dir'
  path: string
  bytes: number | null
}

export type DirectoryBytes = (path: string) => Promise<number | null>

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

/** `truncated`: the manifest names more than the caps allow, so it must never read as complete. */
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

/** Null when the script writes no manifest. */
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
  let downloadedBytes = 0
  let files = 0
  let inFlight = 0
  for (const { kind, path, bytes } of entries) {
    if (kind === 'dir') {
      const held = await directoryBytes(path)
      if (held === null) {
        continue
      }
      // A reused cache can hold more than this launch asked for.
      downloadedBytes += bytes ? Math.min(held, bytes) : held
      if (bytes && held >= bytes) {
        files++
      } else {
        inFlight++
      }
      continue
    }
    // Finished first, so a stale .part beside it cannot keep the file in flight.
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
