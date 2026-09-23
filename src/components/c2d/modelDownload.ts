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

// Read at most this many tar entries. A model repo has tens of files; a bound stops a pathological
// cache (or a wrong path pointing at something huge) from walking forever.
const MAX_CACHE_ENTRIES = 5000

/**
 * Sums the cache's byte counts by streaming the directory out of the container and reading ONLY the
 * tar HEADERS (name, size, type) — the payload is discarded as it arrives, so nothing large is
 * transferred and no shell, volume, or storage-driver assumption is involved. Returns null when the
 * cache does not exist yet (the normal state for the first seconds) or cannot be read.
 */
export async function readModelDownloadBytes(
  container: Dockerode.Container,
  cachePath: string
): Promise<{ downloadedBytes: number; files: number; inFlight: number } | null> {
  let archive: Readable
  try {
    archive = (await container.getArchive({ path: cachePath })) as Readable
  } catch (error: any) {
    // 404 until the engine creates the cache — not a failure, just nothing to report yet.
    if (error?.statusCode !== 404) {
      CORE_LOGGER.debug(`[model-download] archive ${cachePath} failed: ${error?.message}`)
    }
    return null
  }

  return await new Promise((resolve) => {
    const extract = tarStream.extract()
    let downloadedBytes = 0
    let files = 0
    let inFlight = 0
    let entries = 0
    let settled = false

    const finish = (
      result: { downloadedBytes: number; files: number; inFlight: number } | null
    ) => {
      if (settled) return
      settled = true
      resolve(result)
    }

    extract.on('entry', (header, stream, next) => {
      entries++
      // Only regular files carry bytes. A symlink (every snapshots/ entry) reports size 0 and its
      // target may not exist yet, so counting those would double-count or contribute nothing.
      if (header.type === 'file' && header.name.includes('/blobs/')) {
        downloadedBytes += header.size ?? 0
        if (IN_FLIGHT_SUFFIXES.some((suffix) => header.name.endsWith(suffix))) {
          inFlight++
        } else {
          files++
        }
      }
      stream.on('end', next)
      stream.resume() // discard the payload; only the header matters
      if (entries > MAX_CACHE_ENTRIES) {
        extract.destroy()
        finish({ downloadedBytes, files, inFlight })
      }
    })
    extract.on('finish', () => finish({ downloadedBytes, files, inFlight }))
    extract.on('error', (error: any) => {
      CORE_LOGGER.debug(`[model-download] tar read failed: ${error?.message}`)
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
    if (response.ok) {
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
    CORE_LOGGER.debug(
      `[model-download] hub lookup for ${modelId} failed: ${error?.message}`
    )
  }
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
