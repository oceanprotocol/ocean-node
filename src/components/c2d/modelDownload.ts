import type Dockerode from 'dockerode'
import tarStream from 'tar-stream'
import type { Readable } from 'stream'
import type { ServiceModelDownload } from '../../@types/C2D/ServiceOnDemand.js'
import { CORE_LOGGER } from '../../utils/logging/common.js'

/**
 * How much of its model a service has downloaded, read from the container's Hugging Face cache.
 *
 * The weights are fetched by `huggingface_hub` INSIDE the container, after it reports Running and
 * before the engine can serve anything — the single longest wait a consumer sees, and one nothing
 * reports today. The engine exposes no HTTP endpoint while it happens (there is no server yet), so
 * the only structured source is the cache the downloader writes into:
 *
 *   <cache>/models--<org>--<name>/blobs/<sha>             a finished file
 *   <cache>/blobs/<sha>.incomplete                        one being written, size == bytes received
 *
 * llama.cpp downloads through the same cache but names its partial files `.downloadInProgress`.
 * Both are counted; only the complete/in-flight split depends on telling them apart.
 *
 * The `.incomplete` mechanism is what makes HF downloads resumable, so it is a far steadier contract
 * than parsing progress bars out of the container log. Verified against a live download: the byte
 * counts track the transfer exactly, and several `.incomplete` files coexist because the hub fetches
 * files in parallel — so only the AGGREGATE is meaningful, never a per-file percentage.
 *
 * The cache cannot supply the denominator: `snapshots/<sha>/*` are symlinks (tar reports size 0 for
 * those) pointing at blobs that do not exist yet, and they appear one by one as files resolve. The
 * total therefore comes from the Hub's own metadata — see fetchModelTotalBytes.
 */

// Suffixes a partially-downloaded file carries while it is being written. `huggingface_hub` (vLLM)
// uses `.incomplete`; llama.cpp's own `-hf` downloader uses `.downloadInProgress`. Both verified
// against live downloads.
const IN_FLIGHT_SUFFIXES = ['.incomplete', '.downloadInProgress']

// A model repo has tens of files; a bound stops a pathological cache (or a mistyped path pointing
// at something huge) from issuing thousands of stat calls.
const MAX_BLOB_FILES = 512

// Docker returns a path's stat in this header, base64-encoded JSON, with NO response body.
const PATH_STAT_HEADER = 'x-docker-container-path-stat'

/** One file's size, read from Docker's stat header. null when the path is gone or unreadable. */
async function statContainerPath(
  container: Dockerode.Container,
  path: string
): Promise<number | null> {
  try {
    const info: any = await container.infoArchive({ path })
    const header = info?.headers?.[PATH_STAT_HEADER]
    if (!header) return null
    const stat = JSON.parse(Buffer.from(String(header), 'base64').toString())
    const size = Number(stat?.size)
    return Number.isFinite(size) ? size : null
  } catch {
    // Vanished between listing and stat (a rename on completion), or never existed.
    return null
  }
}

/**
 * Sums the cache's byte counts WITHOUT transferring any of it.
 *
 * Docker's archive endpoint streams file CONTENTS, and it does so for any directory that contains
 * them — measured at 367 MB of socket traffic to list a 350 MB `blobs/` folder, scaling with the
 * model (a 15 GB one would move 15 GB, every few seconds). So `blobs/` is never listed. Instead:
 *
 *  1. `snapshots/` is listed, which holds only directories and symlinks — 2.5 KB and ~14 ms,
 *     whatever the model's size — and every symlink's target names a blob.
 *  2. Each blob is then stat-ed through Docker's path-stat header, which carries the size and
 *     returns no body at all (~9 ms, zero content).
 *
 * In-flight files are found by stat-ing the in-progress name beside each target: a partially
 * downloaded blob is written as `<sha>.incomplete` (huggingface_hub) or `<sha>.downloadInProgress`
 * (llama.cpp) and only renamed to `<sha>` on completion, while its snapshot symlink already points
 * at the final name.
 *
 * Returns null when the cache does not exist yet (the normal state for the first seconds) or cannot
 * be read. Never throws: progress reporting must not be able to disturb a running service.
 */
export async function readModelDownloadBytes(
  container: Dockerode.Container,
  cachePath: string
): Promise<{ downloadedBytes: number; files: number; inFlight: number } | null> {
  const repoDirs = await listDirectoryEntries(container, cachePath, 'directory')
  if (!repoDirs) return null

  let downloadedBytes = 0
  let files = 0
  let inFlight = 0
  let seen = 0

  for (const repoDir of repoDirs) {
    if (!repoDir.startsWith('models--')) continue
    const blobTargets = await listSnapshotBlobTargets(
      container,
      `${cachePath}/${repoDir}`
    )
    for (const blobName of blobTargets) {
      if (seen >= MAX_BLOB_FILES) break
      seen++
      const blobPath = `${cachePath}/${repoDir}/blobs/${blobName}`
      // The finished blob, if the download completed.
      const size = await statContainerPath(container, blobPath)
      if (size !== null) {
        downloadedBytes += size
        files++
        continue
      }
      // Otherwise it may still be arriving under its in-progress name.
      for (const suffix of IN_FLIGHT_SUFFIXES) {
        const partial = await statContainerPath(container, `${blobPath}${suffix}`)
        if (partial !== null) {
          downloadedBytes += partial
          inFlight++
          break
        }
      }
    }
  }
  return { downloadedBytes, files, inFlight }
}

/**
 * The blob names a repo's snapshots point at.
 *
 * `snapshots/<sha>/<file>` are symlinks into `blobs/`, so this directory carries no file data and
 * its listing is cheap regardless of how large the model is. The symlink target's basename is the
 * blob to stat.
 */
async function listSnapshotBlobTargets(
  container: Dockerode.Container,
  repoPath: string
): Promise<string[]> {
  const targets = await listSymlinkTargets(container, `${repoPath}/snapshots`)
  return targets ?? []
}

/**
 * Names of the immediate children of a container directory, of the given tar entry type.
 *
 * Only ever called on directories that hold no file data of their own (the cache root, which holds
 * repo folders), so nothing large crosses the socket — see the note on readModelDownloadBytes.
 */
async function listDirectoryEntries(
  container: Dockerode.Container,
  path: string,
  keep: 'file' | 'directory'
): Promise<string[] | null> {
  // `stopAtDepth` is what keeps this cheap: Docker tars a directory RECURSIVELY and there is no
  // shallow-list option, so a cache root would stream every weight file before this could filter
  // by depth. Entries arrive in tree order, so the stream is abandoned as soon as something below
  // the level being listed appears — the payloads never start.
  const entries = await readTarHeaders(container, path, 1)
  if (!entries) return null
  return entries
    .filter((entry) => entry.depth === 1 && entry.type === keep)
    .map((entry) => entry.name)
}

/**
 * Basenames of every symlink target under a directory tree (here: `snapshots/<sha>/<file>` points
 * at `../../blobs/<sha>`). Symlinks carry no payload, so this stays cheap at any model size.
 */
async function listSymlinkTargets(
  container: Dockerode.Container,
  path: string
): Promise<string[] | null> {
  const entries = await readTarHeaders(container, path)
  if (!entries) return null
  const targets = new Set<string>()
  for (const entry of entries) {
    if (entry.type !== 'symlink' || !entry.linkname) continue
    const basename = entry.linkname.split('/').filter(Boolean).pop()
    if (basename) targets.add(basename)
  }
  return [...targets]
}

interface TarEntryHeader {
  name: string
  type: string
  depth: number
  linkname?: string
}

/** Reads a container path's tar entry headers. Null when the path is absent or unreadable. */
async function readTarHeaders(
  container: Dockerode.Container,
  path: string,
  stopAtDepth?: number
): Promise<TarEntryHeader[] | null> {
  let archive: Readable
  try {
    archive = (await container.getArchive({ path })) as Readable
  } catch (error: any) {
    // 404 until the engine creates the cache — not a failure, just nothing to report yet.
    if (error?.statusCode !== 404) {
      CORE_LOGGER.debug(`[model-download] listing ${path} failed: ${error?.message}`)
    }
    return null
  }

  return await new Promise((resolve) => {
    const extract = tarStream.extract()
    const entries: TarEntryHeader[] = []
    let settled = false
    const finish = (result: TarEntryHeader[] | null) => {
      if (settled) return
      settled = true
      resolve(result)
    }

    extract.on('entry', (header, stream, next) => {
      // Paths arrive prefixed with the requested directory's own name; drop it so `depth` counts
      // from the directory that was asked for.
      const relative = header.name.split('/').slice(1).filter(Boolean)
      if (relative.length > 0) {
        entries.push({
          name: relative[relative.length - 1],
          type: String(header.type),
          depth: relative.length,
          linkname: (header as any).linkname
        })
      }
      // Deeper than asked for: everything wanted at this level has already been seen, and what
      // follows is file data. Stop before any of it is transferred.
      if (stopAtDepth !== undefined && relative.length > stopAtDepth) {
        extract.destroy()
        archive.destroy()
        finish(entries)
        return
      }
      stream.on('end', next)
      stream.resume()
      if (entries.length >= MAX_BLOB_FILES) {
        extract.destroy()
        archive.destroy()
        finish(entries)
      }
    })
    extract.on('finish', () => finish(entries))
    extract.on('error', (error: any) => {
      CORE_LOGGER.debug(`[model-download] listing ${path} failed: ${error?.message}`)
      finish(null)
    })
    archive.on('error', () => finish(null))
    archive.pipe(extract)
  })
}

// Bytes on the wire per parameter, by the dtype key the Hub reports. Anything unrecognized counts
// as 2 — the overwhelmingly common half-precision case, and a wrong guess here only skews a bar.
const BYTES_PER_PARAM: Record<string, number> = {
  F64: 8,
  I64: 8,
  F32: 4,
  I32: 4,
  U32: 4,
  BF16: 2,
  F16: 2,
  I16: 2,
  U16: 2,
  F8_E4M3: 1,
  F8_E5M2: 1,
  I8: 1,
  U8: 1,
  BOOL: 1,
  I4: 0.5,
  U4: 0.5
}

const HF_MODEL_API = 'https://huggingface.co/api/models'
const HF_TIMEOUT_MS = 8000
// One lookup per model for the life of the process: the answer cannot change for a given repo, and
// this is read on the metrics cadence for every starting service.
const totalBytesCache = new Map<string, number | null>()

/**
 * The size of the weights an engine will download for a model, from the Hub's safetensors index.
 *
 * Deliberately NOT the repo's `usedStorage`: that counts every artifact in the repo, including the
 * .bin duplicates and GGUF quantizations of the same weights that nothing downloads — for a small
 * model it reads roughly triple what is actually fetched, which would park a progress bar at a third
 * of the truth for the entire wait.
 *
 * Returns null for a repo with no safetensors index (GGUF-only repos, gated repos, anything the Hub
 * has not indexed) and whenever the Hub is unreachable. The caller then reports bytes downloaded
 * with no percentage, rather than a ratio against a made-up denominator.
 */
export async function fetchModelTotalBytes(
  modelId: string,
  quant?: string
): Promise<number | null> {
  const key = quant ? `${modelId}:${quant}` : modelId
  if (totalBytesCache.has(key)) return totalBytesCache.get(key) ?? null

  let total: number | null = null
  try {
    if (quant) {
      const ggufTotal = await fetchGgufFileBytes(modelId, quant)
      totalBytesCache.set(key, ggufTotal)
      return ggufTotal
    }
    const path = modelId
      .split('/')
      .map((segment) => encodeURIComponent(segment))
      .join('/')
    const response = await fetch(`${HF_MODEL_API}/${path}?expand[]=safetensors`, {
      signal: AbortSignal.timeout(HF_TIMEOUT_MS)
    })
    if (!response.ok) {
      // A 404 is a definitive "no such repo" and worth remembering; anything else (429, 5xx, a
      // proxy hiccup) is transient and must not poison the cache for the life of the process.
      if (response.status === 404) {
        totalBytesCache.set(key, null)
      }
      return null
    }
    {
      const body: any = await response.json()
      const parameters = body?.safetensors?.parameters
      if (parameters && typeof parameters === 'object') {
        const bytes = Object.entries(parameters).reduce(
          (sum, [dtype, count]) =>
            sum + (Number(count) || 0) * (BYTES_PER_PARAM[dtype] ?? 2),
          0
        )
        total = bytes > 0 ? Math.round(bytes) : null
      } else if (Number(body?.safetensors?.total) > 0) {
        // Only a parameter count, no dtype breakdown: assume half precision, the default these
        // repos are served in.
        total = Math.round(Number(body.safetensors.total) * 2)
      }
    }
  } catch (error: any) {
    // Network error, timeout, unparseable body: no answer, but not evidence there is none. Return
    // without caching so the next sample can ask again.
    CORE_LOGGER.debug(
      `[model-download] hub lookup for ${modelId} failed: ${error?.message}`
    )
    return null
  }
  // A successful response that carried no index IS definitive (a GGUF-only repo has none), so it
  // is cached like any other answer.
  totalBytesCache.set(key, total)
  return total
}

/**
 * The size of ONE quantization file in a GGUF repo, for an engine that names it (llama.cpp's
 * `-hf <repo>:<quant>`).
 *
 * A GGUF repo publishes no safetensors index, so the parameter-count route returns nothing for it —
 * but the Hub does list every file with its size, and the engine downloads exactly one of them.
 * Matching on the quant tag gives the exact denominator instead of the whole repo's contents, which
 * for a repo carrying a dozen quantizations would be an order of magnitude out.
 */
async function fetchGgufFileBytes(
  modelId: string,
  quant: string
): Promise<number | null> {
  try {
    const path = modelId
      .split('/')
      .map((segment) => encodeURIComponent(segment))
      .join('/')
    const response = await fetch(`${HF_MODEL_API}/${path}?blobs=true`, {
      signal: AbortSignal.timeout(HF_TIMEOUT_MS)
    })
    if (!response.ok) return null
    const body: any = await response.json()
    const siblings: any[] = Array.isArray(body?.siblings) ? body.siblings : []
    const wanted = quant.toLowerCase()
    const match = siblings.find((file) => {
      const name = String(file?.rfilename ?? '').toLowerCase()
      return name.endsWith('.gguf') && name.includes(wanted)
    })
    const size = Number(match?.size ?? match?.lfs?.size)
    return Number.isFinite(size) && size > 0 ? size : null
  } catch (error: any) {
    CORE_LOGGER.debug(
      `[model-download] gguf lookup for ${modelId}:${quant} failed: ${error?.message}`
    )
    return null
  }
}

/** Builds the record persisted on the job, capping the ratio (see the note on repo variants). */
export function buildModelDownload(
  downloaded: { downloadedBytes: number; files: number; inFlight: number },
  totalBytes: number | null,
  modelId: string | null
): ServiceModelDownload {
  // The Hub reports the REPO's safetensors size while the engine downloads only what it needs —
  // identical in the common case, but a repo carrying several variants over-counts. Cap rather than
  // report >100%, and treat "reached the total" as complete.
  const percent =
    totalBytes && totalBytes > 0
      ? Math.min(100, Math.round((downloaded.downloadedBytes / totalBytes) * 100))
      : undefined
  return {
    ...(modelId ? { modelId } : {}),
    downloadedBytes: downloaded.downloadedBytes,
    ...(totalBytes ? { totalBytes } : {}),
    ...(percent !== undefined ? { percent } : {}),
    filesComplete: downloaded.files,
    filesInFlight: downloaded.inFlight,
    updatedAt: Date.now()
  }
}
