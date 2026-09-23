import type {
  ServiceImagePullProgress,
  ServiceJob
} from '../../@types/C2D/ServiceOnDemand.js'

// ── Image pull progress ───────────────────────────────────────────────

// How often the aggregated byte counts are pushed to the caller (which persists them). The daemon
// emits progress events per layer per ~100ms, which is far more often than a status poll reads.
const PULL_PROGRESS_EMIT_INTERVAL_MS = 1000

/**
 * Aggregates the Docker daemon's per-layer pull events into one byte/percentage view.
 *
 * Docker reports each layer separately, and only announces a layer's `total` when that layer
 * STARTS downloading — so the denominator grows during the pull and a naively recomputed
 * percentage walks backwards. The emitted `percent` is therefore clamped monotonic: it is the
 * honest lower bound at every moment, which is what a progress bar needs.
 *
 * Layers that are already on the host arrive as "Already exists" and contribute no bytes, so an
 * image that is fully cached completes at 0 bytes — the caller reports that as "complete" rather
 * than as a stalled 0%.
 */
export class ImagePullTracker {
  private readonly layers = new Map<
    string,
    { current: number; total: number; done: boolean }
  >()

  private lastEmitAt = 0
  private maxPercent = 0
  private extracting = false

  constructor(private readonly emit: (progress: ServiceImagePullProgress) => void) {}

  onEvent(event: any): void {
    const id: string | undefined = typeof event?.id === 'string' ? event.id : undefined
    const status: string = typeof event?.status === 'string' ? event.status : ''
    // Not a layer: the pull's own narration. Most of it carries no id ("Digest: sha256:…"), but
    // the opening "Pulling from library/python" line carries the TAG as its id — counted as a
    // layer it inflates layersTotal by one, so the pull ends reading 4/5 instead of 4/4.
    if (!id || status.startsWith('Pulling from') || status.startsWith('Digest:')) return

    const layer = this.layers.get(id) ?? { current: 0, total: 0, done: false }
    const current = Number(event?.progressDetail?.current)
    const total = Number(event?.progressDetail?.total)

    if (status.startsWith('Downloading')) {
      if (Number.isFinite(current)) layer.current = current
      if (Number.isFinite(total) && total > 0) layer.total = total
    } else if (
      status.startsWith('Verifying Checksum') ||
      status === 'Download complete'
    ) {
      // The byte stream for this layer is over; the daemon stops reporting `current`.
      if (layer.total > 0) layer.current = layer.total
    } else if (status.startsWith('Extracting')) {
      this.extracting = true
      if (layer.total > 0) layer.current = layer.total
    } else if (status === 'Pull complete' || status === 'Already exists') {
      if (layer.total > 0) layer.current = layer.total
      layer.done = true
    }

    this.layers.set(id, layer)
    this.maybeEmit()
  }

  /** Pull finished — report 100% once, so a listener never sits on the last partial sample. */
  finish(): void {
    const snapshot = this.snapshot()
    this.emit({ ...snapshot, phase: 'complete', percent: 100, updatedAt: Date.now() })
  }

  private maybeEmit(): void {
    const now = Date.now()
    if (now - this.lastEmitAt < PULL_PROGRESS_EMIT_INTERVAL_MS) return
    this.lastEmitAt = now
    this.emit({ ...this.snapshot(), updatedAt: now })
  }

  private snapshot(): ServiceImagePullProgress {
    let downloadedBytes = 0
    let totalBytes = 0
    let layersDone = 0
    for (const layer of this.layers.values()) {
      downloadedBytes += layer.current
      totalBytes += layer.total
      if (layer.done) layersDone++
    }
    const raw = totalBytes > 0 ? (downloadedBytes / totalBytes) * 100 : 0
    this.maxPercent = Math.min(100, Math.max(this.maxPercent, raw))
    return {
      phase: this.extracting ? 'extracting' : 'downloading',
      downloadedBytes,
      totalBytes,
      percent: Math.round(this.maxPercent),
      layersTotal: this.layers.size,
      layersDone,
      updatedAt: Date.now()
    }
  }
}

// ── Readiness probe ───────────────────────────────────────────────────

// Before the first check, giving the container a moment to bind its port.
export const PROBE_INITIAL_DELAY_SECONDS = 5
// While warming up. The InternalLoop ticks faster than this, so the probe throttles itself.
export const PROBE_PERIOD_SECONDS = 5
// Once ready the check keeps running — to catch an engine that dies without its container exiting —
// but far more slowly: it is a liveness check at that point, not a wait.
export const READY_PROBE_PERIOD_SECONDS = 30
const PROBE_TIMEOUT_MS = 2000

export interface ReadinessProbeResult {
  ok: boolean
  httpStatus?: number
  error?: string
  url: string
}

/**
 * The addresses worth trying to reach a service container on, best first.
 *
 * Which one works depends entirely on how the node itself is deployed, and the node cannot know
 * that up front: a node running on the host reaches the container's own bridge IP directly, a node
 * that publishes ports reaches them on loopback, and a node running inside Docker reaches neither
 * and has to go out through the host gateway. So we try them in order once and remember the winner.
 */
export function probeCandidates(
  job: ServiceJob,
  containerIps: string[],
  containerPort: number,
  path: string
): string[] {
  const endpoint =
    job.endpoints.find((ep) => ep.containerPort === containerPort) ?? job.endpoints[0]
  const hostPort = endpoint?.hostPort
  const urls: string[] = []
  for (const ip of containerIps) {
    if (ip) urls.push(`http://${ip}:${containerPort}${path}`)
  }
  if (hostPort) {
    urls.push(`http://127.0.0.1:${hostPort}${path}`)
    // Docker Desktop always, and Linux compose when the node declares `host-gateway`.
    urls.push(`http://host.docker.internal:${hostPort}${path}`)
    // The public URL handed to consumers — last, because it depends on NAT hairpinning.
    if (endpoint?.url) urls.push(`${endpoint.url}${path}`)
  }
  // De-duplicate while keeping order (nodeHost is often 'localhost', i.e. candidate 2 again).
  return [...new Set(urls)]
}

/**
 * Performs ONE readiness request. Never throws — a failure IS the result.
 *
 * A refused connection is reported without an httpStatus, which the caller treats as "not ready"
 * exactly like an unexpected status: an engine that binds its port only after loading its weights
 * (vLLM, commonly) is unreachable rather than unhealthy for that whole window.
 */
export async function runReadinessProbe(
  url: string,
  expectStatus: number[]
): Promise<ReadinessProbeResult> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS)
  try {
    const response = await fetch(url, {
      method: 'GET',
      signal: controller.signal,
      headers: { accept: '*/*' }
    })
    // Drain, so the socket is not left hanging on either path.
    await response.body?.cancel().catch(() => {})
    if (!expectStatus.includes(response.status)) {
      return {
        ok: false,
        httpStatus: response.status,
        url,
        error: `unexpected status ${response.status}`
      }
    }
    return { ok: true, httpStatus: response.status, url }
  } catch (e: any) {
    return {
      ok: false,
      url,
      error: e?.name === 'AbortError' ? 'timeout' : String(e?.message)
    }
  } finally {
    clearTimeout(timer)
  }
}
