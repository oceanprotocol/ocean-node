import type Dockerode from 'dockerode'
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
 *   <cache>/models--<org>--<name>/blobs/<sha>                      a finished file
 *   <cache>/models--<org>--<name>/blobs/<sha>[.<id>].incomplete    one being written
 *
 * llama.cpp downloads through the same cache but names its partial files `.downloadInProgress`.
 * Both are counted; only the complete/in-flight split depends on telling them apart. Recent
 * `huggingface_hub` inserts a per-process id before `.incomplete`, so the partial name cannot be
 * derived from the blob's — it has to be discovered.
 *
 * The hub fetches files in parallel, so several partial files coexist — only the AGGREGATE is
 * meaningful, never a per-file percentage.
 *
 * The cache cannot supply the denominator: the snapshot symlinks that name a repo's files are
 * created only AFTER each file finishes, so they say nothing about what is still arriving. The
 * total therefore comes from the Hub's own metadata — see fetchModelTotalBytes.
 */

// Suffixes a partially-downloaded file carries while it is being written. `huggingface_hub` (vLLM)
// uses `.incomplete`; llama.cpp's own `-hf` downloader uses `.downloadInProgress`.
const IN_FLIGHT_SUFFIXES = ['.incomplete', '.downloadInProgress']

// A model repo has tens of files; a bound stops a pathological cache (or a mistyped path pointing
// at something huge) from issuing thousands of stat calls.
const MAX_BLOB_FILES = 512

// Docker returns a path's stat in this header, base64-encoded JSON, with NO response body.
const PATH_STAT_HEADER = 'x-docker-container-path-stat'

// Kind values in Docker's container-changes listing.
const CHANGE_KIND_DELETED = 2

interface ContainerPathStat {
  size: number
  linkTarget?: string
}

/** One path's stat, read from Docker's stat header. null when the path is gone or unreadable. */
async function statContainerPath(
  container: Dockerode.Container,
  path: string
): Promise<ContainerPathStat | null> {
  try {
    const info: any = await container.infoArchive({ path })
    const header = info?.headers?.[PATH_STAT_HEADER]
    if (!header) {
      return null
    }
    const stat = JSON.parse(Buffer.from(String(header), 'base64').toString())
    const size = Number(stat?.size)
    if (!Number.isFinite(size)) {
      return null
    }
    return { size, linkTarget: stat?.linkTarget || undefined }
  } catch {
    // Vanished between listing and stat (a rename on completion), or never existed.
    return null
  }
}

/**
 * A file's size, following one symlink. Docker's path stat is an lstat, and newer
 * `huggingface_hub` can link a blob into a shared store — the link's own size would count a few
 * bytes for a multi-gigabyte file.
 */
async function fileSize(
  container: Dockerode.Container,
  path: string
): Promise<number | null> {
  const stat = await statContainerPath(container, path)
  if (!stat?.linkTarget) {
    return stat?.size ?? null
  }
  const target = stat.linkTarget.startsWith('/')
    ? stat.linkTarget
    : `${path.slice(0, path.lastIndexOf('/'))}/${stat.linkTarget}`
  return (await statContainerPath(container, target))?.size ?? null
}

/** The in-flight suffix a path ends with, or null for a finished file. */
function inFlightSuffix(path: string): string | null {
  return IN_FLIGHT_SUFFIXES.find((suffix) => path.endsWith(suffix)) ?? null
}

/**
 * The finished blob a partial file becomes: `<sha>.downloadInProgress`, `<sha>.incomplete` and
 * `<sha>.<id>.incomplete` all rename to `<sha>`, and a blob name never contains a dot.
 */
function finishedBlobPath(partialPath: string): string {
  const slash = partialPath.lastIndexOf('/')
  const name = partialPath.slice(slash + 1)
  return `${partialPath.slice(0, slash + 1)}${name.split('.')[0]}`
}

/**
 * The files in a Hugging Face cache's `blobs/` folders, from the container's changes listing.
 *
 * Matched on the cache's own layout (`models--<org>--<name>/blobs/<file>`) wherever it sits, not
 * under one fixed root: HF_HOME / HF_HUB_CACHE can move it, and the env that would say so rides in
 * encrypted userData the node cannot read. Snapshot symlinks and lock files live outside `blobs/`
 * and carry no weight data.
 */
export function selectBlobPaths(
  changes: Array<{ Path?: string; Kind?: number }> | null | undefined
): string[] {
  const paths = new Set<string>()
  for (const change of changes ?? []) {
    const path = change?.Path
    if (!path || change.Kind === CHANGE_KIND_DELETED) {
      continue
    }
    const segments = path.split('/')
    const n = segments.length
    if (
      n >= 3 &&
      segments[n - 3].startsWith('models--') &&
      segments[n - 2] === 'blobs' &&
      segments[n - 1]
    ) {
      paths.add(path)
    }
  }
  return [...paths].slice(0, MAX_BLOB_FILES)
}

export interface ModelDownloadBytes {
  downloadedBytes: number
  files: number
  inFlight: number
}

/**
 * The cache's blob paths, from Docker's changes endpoint: every path the container has added or
 * modified on top of its image — names only, no contents. It sees partial files under whatever
 * name the downloader picked, in every repo folder, with no dependence on when symlinks appear or
 * what order a directory lists in.
 *
 * The one expensive call here: on the containerd image store the daemon compares the container
 * against its whole image (measured 0.1-1.6s, growing with image size), so ModelDownloadSampler
 * calls it sparingly. Null when Docker could not answer.
 */
async function discoverBlobPaths(
  container: Dockerode.Container
): Promise<string[] | null> {
  try {
    return selectBlobPaths(await container.changes())
  } catch (error: any) {
    CORE_LOGGER.debug(`[model-download] listing changes failed: ${error?.message}`)
    return null
  }
}

/**
 * Sizes the given blob paths through Docker's path-stat header, which carries the size and returns
 * no body. A partial file renamed since it was listed is looked up again under its finished name,
 * so a file completing mid-sample is counted once rather than dropped; `paths` comes back with
 * those renames applied, and `renamed` says a download finished — usually the moment the
 * downloader starts its next file.
 */
async function measureBlobPaths(
  container: Dockerode.Container,
  blobPaths: string[]
): Promise<{ bytes: ModelDownloadBytes; paths: string[]; renamed: boolean }> {
  const listed = new Set(blobPaths)
  const counted = new Set<string>()
  const paths: string[] = []
  let renamed = false
  let downloadedBytes = 0
  let files = 0
  let inFlight = 0

  for (const path of blobPaths) {
    if (counted.has(path)) {
      continue
    }
    const size = await fileSize(container, path)
    if (size !== null) {
      counted.add(path)
      paths.push(path)
      downloadedBytes += size
      if (inFlightSuffix(path)) {
        inFlight++
      } else {
        files++
      }
      continue
    }
    if (!inFlightSuffix(path)) {
      continue
    }
    // Finished since it was listed: count it under the name it now has, unless the list already
    // carries that name and it will be (or was) counted there.
    renamed = true
    const finished = finishedBlobPath(path)
    if (listed.has(finished) || counted.has(finished)) {
      continue
    }
    const finishedSize = await fileSize(container, finished)
    if (finishedSize !== null) {
      counted.add(finished)
      paths.push(finished)
      downloadedBytes += finishedSize
      files++
    }
  }
  return { bytes: { downloadedBytes, files, inFlight }, paths, renamed }
}

/**
 * Sums the cache's byte counts WITHOUT transferring any of it: one changes listing, then a stat
 * per blob. Only sees the container's own filesystem — a cache mounted from a volume is invisible
 * here. Engine-agnostic within that: anything downloading through the Hugging Face cache layout is
 * measured, wherever the cache was put.
 *
 * Returns null when the cache does not exist yet (the normal state for the first seconds) or cannot
 * be read. Never throws: progress reporting must not be able to disturb a running service.
 */
export async function readModelDownloadBytes(
  container: Dockerode.Container
): Promise<ModelDownloadBytes | null> {
  const blobPaths = await discoverBlobPaths(container)
  if (!blobPaths || blobPaths.length === 0) {
    return null
  }
  return (await measureBlobPaths(container, blobPaths)).bytes
}

// Re-listing cadence. A known partial file finishing triggers a re-list on the next sample
// regardless, since that is when the downloader starts its next file; these bound how late a file
// that started on its own is noticed.
export const BLOB_REDISCOVER_MS = 30_000
// Before the cache holds anything: the first bytes should show up quickly.
export const BLOB_EMPTY_REDISCOVER_MS = 10_000

interface BlobDiscovery {
  containerId: string
  paths: string[]
  discoveredAt: number
  /** Set when a known download finished: re-list on the next sample. */
  stale: boolean
}

/**
 * Samples model downloads per service, re-listing the container's changes only when needed and
 * stat-ing the known paths in between — the stats are cheap, the listing is not.
 *
 * A file that starts without another finishing is counted up to BLOB_REDISCOVER_MS late, so the bar
 * can pause and then catch up; it never goes backwards. Readiness does not depend on any of this.
 */
export class ModelDownloadSampler {
  private discoveries = new Map<string, BlobDiscovery>()

  async sample(
    serviceId: string,
    container: Dockerode.Container,
    now: number = Date.now()
  ): Promise<ModelDownloadBytes | null> {
    let discovery = this.discoveries.get(serviceId)
    // A restart runs a new container, whose cache starts from nothing.
    if (discovery && discovery.containerId !== container.id) {
      discovery = undefined
    }
    if (!discovery || this.isDue(discovery, now)) {
      const paths = await discoverBlobPaths(container)
      if (!paths) {
        return null
      }
      discovery = { containerId: container.id, paths, discoveredAt: now, stale: false }
      this.discoveries.set(serviceId, discovery)
    }
    if (discovery.paths.length === 0) {
      return null
    }
    const measured = await measureBlobPaths(container, discovery.paths)
    discovery.paths = measured.paths
    discovery.stale = discovery.stale || measured.renamed
    return measured.bytes
  }

  /** Drops every service not in `keep` — called with the services still running. */
  retain(keep: Set<string>): void {
    for (const serviceId of this.discoveries.keys()) {
      if (!keep.has(serviceId)) {
        this.discoveries.delete(serviceId)
      }
    }
  }

  private isDue(discovery: BlobDiscovery, now: number): boolean {
    if (discovery.stale) {
      return true
    }
    const period =
      discovery.paths.length === 0 ? BLOB_EMPTY_REDISCOVER_MS : BLOB_REDISCOVER_MS
    return now - discovery.discoveredAt >= period
  }
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
// A lookup that failed transiently (timeout, 429, 5xx, network) is not asked again for this long.
// Without it every sample of every starting service would wait out the full timeout while the Hub
// is slow; with it the total simply appears a little later once the Hub recovers.
const HUB_RETRY_AFTER_MS = 60_000
const hubFailedAt = new Map<string, number>()

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
  const failedAt = hubFailedAt.get(key)
  if (failedAt !== undefined && Date.now() - failedAt < HUB_RETRY_AFTER_MS) {
    return null
  }
  const total = await lookupModelTotalBytes(modelId, quant)
  if (total === undefined) {
    hubFailedAt.set(key, Date.now())
    return null
  }
  hubFailedAt.delete(key)
  totalBytesCache.set(key, total)
  return total
}

/**
 * One Hub lookup. The answer (a size, or null for a definitive "none") is cached by the caller;
 * undefined means the Hub could not be asked, which is backed off rather than cached.
 */
async function lookupModelTotalBytes(
  modelId: string,
  quant?: string
): Promise<number | null | undefined> {
  if (quant) {
    return await fetchGgufFileBytes(modelId, quant)
  }
  try {
    const response = await fetch(
      `${HF_MODEL_API}/${hubPath(modelId)}?expand[]=safetensors`,
      {
        signal: AbortSignal.timeout(HF_TIMEOUT_MS)
      }
    )
    if (!response.ok) {
      // A 404 is a definitive "no such repo"; anything else (429, 5xx, a proxy hiccup) is
      // transient and must not poison the cache for the life of the process.
      return response.status === 404 ? null : undefined
    }
    const body: any = await response.json()
    const parameters = body?.safetensors?.parameters
    if (parameters && typeof parameters === 'object') {
      const bytes = Object.entries(parameters).reduce(
        (sum, [dtype, count]) =>
          sum + (Number(count) || 0) * (BYTES_PER_PARAM[dtype] ?? 2),
        0
      )
      return bytes > 0 ? Math.round(bytes) : null
    }
    if (Number(body?.safetensors?.total) > 0) {
      // Only a parameter count, no dtype breakdown: assume half precision, the default these
      // repos are served in.
      return Math.round(Number(body.safetensors.total) * 2)
    }
    // A successful response that carried no index IS definitive (a GGUF-only repo has none).
    return null
  } catch (error: any) {
    // Network error, timeout, unparseable body: no answer, but not evidence there is none.
    CORE_LOGGER.debug(
      `[model-download] hub lookup for ${modelId} failed: ${error?.message}`
    )
    return undefined
  }
}

/** A repo id as a Hub API path, each segment encoded. */
function hubPath(modelId: string): string {
  return modelId
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/')
}

/**
 * The size of ONE quantization file in a GGUF repo, for an engine that names it (llama.cpp's
 * `-hf <repo>:<quant>`).
 *
 * A GGUF repo publishes no safetensors index, so the parameter-count route returns nothing for it —
 * but the Hub does list every file with its size, and the engine downloads exactly one of them.
 * Matching on the quant tag gives the exact denominator instead of the whole repo's contents, which
 * for a repo carrying a dozen quantizations would be an order of magnitude out.
 *
 * Same contract as lookupModelTotalBytes: null is a definitive "no size", undefined a failure to ask.
 */
async function fetchGgufFileBytes(
  modelId: string,
  quant: string
): Promise<number | null | undefined> {
  try {
    const response = await fetch(`${HF_MODEL_API}/${hubPath(modelId)}?blobs=true`, {
      signal: AbortSignal.timeout(HF_TIMEOUT_MS)
    })
    if (!response.ok) {
      return response.status === 404 ? null : undefined
    }
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
    return undefined
  }
}

/**
 * Whether a recorded download has finished: the total reached AND nothing still arriving. The total
 * is an estimate (dtype × parameters), so on its own it can read 100% while the last shard is still
 * being written; no partial files left is what makes it final. A record with no total never
 * completes here, and sampling simply carries on until the service is ready.
 */
export function isModelDownloadComplete(
  download: ServiceModelDownload | undefined
): boolean {
  return download?.percent === 100 && download.filesInFlight === 0
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
