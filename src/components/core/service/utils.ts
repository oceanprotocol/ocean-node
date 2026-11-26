import net from 'net'
import type { ServiceJob } from '../../../@types/C2D/ServiceOnDemand.js'
import {
  ServiceStatusNumber,
  ServiceStatusText
} from '../../../@types/C2D/ServiceOnDemand.js'
import type { ServicePortRequest } from '../../../@types/commands.js'
import { CORE_LOGGER } from '../../../utils/logging/common.js'
import { EncryptMethod } from '../../../@types/fileObject.js'
import type { KeyManager } from '../../KeyManager/index.js'
import type { C2DDatabase } from '../../database/C2DDatabase.js'
import type { C2DEngine } from '../../c2d/compute_engine_base.js'
import type { C2DEngines } from '../../c2d/compute_engines.js'
import { sanitizePublicMetrics } from '../../c2d/index.js'

// Looks up a service job and resolves the engine that OWNS it (by clusterHash). Every
// engine shares the same C2DDatabase, so any engine's db returns the job — taking the
// first engine that "finds" it (the old pattern) breaks on nodes with several docker
// engines: the wrong engine's lifecycle lock and InternalLoop would not protect the
// job, resurrecting the teardown-mid-restart race. engine === null with a non-null job
// means no configured engine matches the job's clusterHash (node config changed).
export async function findServiceJobAndEngine(
  engines: C2DEngines,
  serviceId: string,
  owner?: string
): Promise<{ job: ServiceJob | null; engine: C2DEngine | null }> {
  const all = engines.getAllEngines()
  if (all.length === 0) return { job: null, engine: null }
  const [job] = await all[0].db.getServiceJob(serviceId, owner)
  if (!job) return { job: null, engine: null }
  const engine = all.find((e) => e.getC2DConfig().hash === job.clusterHash) ?? null
  return { job, engine }
}

// Converts the decrypted userData object into a flat container env-var map (stringified values).
export function userDataToEnv(userData: Record<string, unknown>): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(userData)) {
    if (v !== undefined && v !== null) env[k] = String(v)
  }
  return env
}

// Decrypts the ECIES userData string (encrypted by the client to the node's public key)
// and JSON-parses it. Called only transiently in memory — at SERVICE_START and SERVICE_RESTART
// to build the container env. Returns {} when no userData was supplied.
export async function decryptUserData(
  encryptedUserData: string | undefined,
  keyManager: KeyManager
): Promise<Record<string, unknown>> {
  if (!encryptedUserData) return {}
  const plain = await keyManager.decrypt(
    Uint8Array.from(Buffer.from(encryptedUserData, 'hex')),
    EncryptMethod.ECIES
  )
  return JSON.parse(plain.toString())
}

// Strips the opaque encrypted userData blob from a ServiceJob before it enters an API
// response (it is node-only-decryptable and useless to callers). null-safe, so handlers
// can pass engine results straight through. EVERY handler returning service jobs
// (SERVICE_START / STOP / EXTEND / RESTART / GET_STATUS) must map results through this.
export function toPublicServiceJob(
  job: ServiceJob | null,
  opts: { includeMetrics?: boolean } = {}
): Omit<ServiceJob, 'userData'> | null {
  if (!job) return null
  const { userData, runtimeMetrics, previousContainerId, terminationReason, ...rest } =
    job
  // userData is ALWAYS stripped. The owner-scoped status path may opt in to the sanitized
  // runtime metrics (internal `prev` accumulator dropped); otherwise they stay absent.
  // SERVICE_LIST uses toListedServiceJob, which never includes metrics.
  const pub: Omit<ServiceJob, 'userData'> = { ...rest }
  if (opts.includeMetrics && runtimeMetrics) {
    pub.runtimeMetrics = sanitizePublicMetrics(runtimeMetrics)
  }
  return pub
}

// Listing-grade sanitization for SERVICE_LIST, which is NOT owner-scoped: on top of the
// always-stripped userData (the encrypted env blob), it removes everything that reveals
// HOW a service is configured — CMD/ENTRYPOINT overrides and any inline Dockerfile — and
// what it produced (its output archives and saved logs), keeping identity, status, resources, endpoints, payment metadata and the owner's
// arbitrary `metadata` labels. `metadata` is returned in both this node-wide list and the
// owner-scoped SERVICE_GET_STATUS.
export function toListedServiceJob(
  job: ServiceJob | null
): Omit<
  ServiceJob,
  | 'userData'
  | 'runtimeMetrics'
  | 'dockerCmd'
  | 'dockerEntrypoint'
  | 'dockerfile'
  | 'additionalDockerFiles'
  | 'outputArchives'
  | 'logArchives'
  | 'previousContainerId'
> | null {
  if (!job) return null
  const {
    userData,
    runtimeMetrics,
    dockerCmd,
    dockerEntrypoint,
    dockerfile,
    additionalDockerFiles,
    outputArchives,
    logArchives,
    previousContainerId,
    terminationReason,
    readiness,
    modelDownload,
    ...pub
  } = job
  // "Is this service actually serving?" is the listing's whole point for a node operator, so the
  // readiness RESULT is kept — but reduced to what answers that, without the diagnostics (probed
  // address, error text) meant for the owner.
  // Progress is kept for the same reason, minus `modelId`: which model a consumer is running is
  // their business, and this listing is readable by any caller, not just the owner.
  const listedModelDownload = modelDownload
    ? (({ modelId, ...rest }) => rest)(modelDownload)
    : undefined
  return {
    ...pub,
    ...(readiness
      ? {
          readiness: {
            state: readiness.state,
            engine: readiness.engine,
            readySince: readiness.readySince
          }
        }
      : {}),
    ...(listedModelDownload ? { modelDownload: listedModelDownload } : {})
  }
}

const SINCE_DURATION_RE = /^(\d+)(s|m|h|d)$/
const SINCE_DURATION_UNIT_SECONDS: Record<string, number> = {
  s: 1,
  m: 60,
  h: 3600,
  d: 86400
}

// Parses the `since` param for SERVICE_GET_STREAMABLE_LOGS into a Unix timestamp (seconds),
// the format `container.logs({ since })` expects. Accepts either an absolute Unix timestamp
// (all-digit string, e.g. "1735689600") or a relative duration counted back from now
// (e.g. "30s", "45m", "2h", "7d") — the latter is a client convenience since the Docker
// Engine API itself only understands absolute timestamps. Returns undefined for "no filter"
// (parameter omitted). Throws on an unrecognized format so the caller can turn it into a 400.
export function parseSinceParam(since?: string): number | undefined {
  if (!since) return undefined
  if (/^\d+$/.test(since)) return parseInt(since, 10)
  const match = since.match(SINCE_DURATION_RE)
  if (!match) {
    throw new Error(
      `Invalid "since" parameter: "${since}". Use a Unix timestamp in seconds, or a relative ` +
        'duration like "30s", "45m", "2h", "7d".'
    )
  }
  const [, amountStr, unit] = match
  const amount = parseInt(amountStr, 10)
  return Math.floor(Date.now() / 1000) - amount * SINCE_DURATION_UNIT_SECONDS[unit]
}

// Port allocation — in-memory set seeded from DB on engine restart
const allocatedPorts = new Set<number>()

// Re-seed the in-memory reservation set from persisted jobs after a (re)start. Intentionally
// HOST-WIDE (every cluster, not one daemon's hash): a paid service's host-port reservation must
// survive a restart for its whole paid window, INCLUDING when the owning daemon was removed from
// config. Such an orphaned service keeps a DB record but has no engine to re-seed its port or to
// OS-bind it (its container is gone once stopped), so a per-cluster seed would leave its port
// unprotected and another daemon whose range now covers it could reserve it mid-window. Seeding
// host-wide makes the allocator honor every persisted reservation. Gated on `expiresAt`: a job
// past its paid window has no claim on the port, so it is NOT re-seeded — this is the eventual
// release for an orphan that no engine will ever mark Expired (bounded to the next restart). Uses
// the same host-wide source buildServiceOnDemandPortInfo advertises, keeping the allocator and the
// advertised usedHostPorts snapshot aligned.
export async function seedAllocatedPorts(db: C2DDatabase): Promise<void> {
  const jobs = await db.getRunningServiceJobs()
  const now = Date.now()
  for (const job of jobs) {
    if (job.expiresAt && job.expiresAt <= now) continue
    for (const ep of job.endpoints ?? []) allocatedPorts.add(ep.hostPort)
  }
}

// Release in-memory host-port reservations left by ORPHANED service jobs — jobs whose owning
// daemon was removed from config, so no engine runs their expiry sweep. seedAllocatedPorts only
// drops expired ports at boot; this is the mid-run counterpart, freeing them during the SAME
// process instead of holding them until the next restart. `configuredClusterHashes` is every
// cluster that still has an engine: an expired job on one of those is left ENTIRELY to its own
// engine's expireService (container teardown, output archival, then release) — reclaim must never
// pre-empt that. Only expired jobs on absent clusters are reclaimed here.
//
// Each reclaimed job is FINALIZED (status → Expired) before its ports are released. This is the
// crux of the correctness, not bookkeeping: an orphan left Stopped keeps appearing in
// getRunningServiceJobs() on every later sweep, so once its port is freed and a NEW start reuses
// it (that start's endpoint not yet persisted, so not in `active`), the next sweep would see the
// port as still belonging to the expired orphan and wrongly release the new reservation — charging
// a service whose container then cannot bind. Marking the orphan Expired drops it from future
// sweeps so the port is never re-flagged; and because the port stays reserved until the job is
// terminal, no new start can grab it until it is permanently de-flagged (the in-memory set already
// serialises reservation — a port in allocatedPorts cannot be re-reserved). Guards on release:
//   - a port a still-active (in-window) job also holds is never released (port reused);
//   - a job is reclaimed only if EVERY one of its reserved ports is genuinely unbound at the OS
//     level — if a container still binds one, the whole job is left for a later sweep (don't
//     finalize or half-release a job whose container is still up).
// Returns how many ports were released.
export async function reclaimExpiredHostPorts(
  db: C2DDatabase,
  configuredClusterHashes: Set<string>
): Promise<number> {
  const jobs = await db.getRunningServiceJobs()
  const now = Date.now()
  const active = new Set<number>()
  const orphanExpired: ServiceJob[] = []
  for (const job of jobs) {
    if (!(job.expiresAt && job.expiresAt <= now)) {
      for (const ep of job.endpoints ?? []) active.add(ep.hostPort)
    } else if (!configuredClusterHashes.has(job.clusterHash)) {
      orphanExpired.push(job) // expired AND its cluster is gone
    }
    // expired + configured cluster → skip: its engine's expireService owns the teardown
  }
  let released = 0
  for (const job of orphanExpired) {
    const reservedPorts = (job.endpoints ?? [])
      .map((ep) => ep.hostPort)
      .filter((p) => allocatedPorts.has(p) && !active.has(p))
    if (!reservedPorts.length) continue
    let allUnbound = true
    for (const p of reservedPorts)
      if (!(await isPortFree(p))) {
        allUnbound = false // a container still holds this port — leave the whole job reserved
        break
      }
    if (!allUnbound) continue
    try {
      // Finalize first (see note above): terminal status removes it from later sweeps.
      job.status = ServiceStatusNumber.Expired
      job.statusText = ServiceStatusText[ServiceStatusNumber.Expired]
      await db.updateServiceJob(job)
    } catch (e) {
      CORE_LOGGER.error(
        `reclaimExpiredHostPorts: could not finalize orphan job ${job.serviceId}: ${e?.message}`
      )
      continue // leave the ports reserved; retry next tick
    }
    for (const p of reservedPorts) {
      releaseHostPort(p)
      released++
    }
  }
  return released
}

export async function allocateHostPort(
  rangeStart: number,
  rangeEnd: number
): Promise<number> {
  const size = rangeEnd - rangeStart + 1
  for (let i = 0; i < Math.min(size, 50); i++) {
    const candidate = rangeStart + Math.floor(Math.random() * size)
    if (allocatedPorts.has(candidate)) continue
    // Reserve before the async check to close the TOCTOU window: the synchronous
    // has()->add() pair is atomic, so no concurrent caller can claim the same port
    // while we await isPortFree(). Release the reservation if the OS port is busy.
    allocatedPorts.add(candidate)
    if (await isPortFree(candidate)) return candidate
    allocatedPorts.delete(candidate)
  }
  throw new Error(`No free host port in range ${rangeStart}–${rangeEnd}`)
}

export function releaseHostPort(port: number): void {
  allocatedPorts.delete(port)
}

// Marks an already-assigned port as reserved (idempotent). Used by restart, which
// re-binds the ports recorded on the job: after a stop (or an Error path) released
// them, they must go back into the set before the container binds them again.
export function reserveHostPort(port: number): void {
  allocatedPorts.add(port)
}

export function portInRange(port: number, range: [number, number]): boolean {
  return Number.isInteger(port) && port >= range[0] && port <= range[1]
}

// Read-only snapshot of the in-memory host-port reservations that fall inside `range`. Lets
// getComputeEnvironments surface IN-FLIGHT reservations — a port claimed by a service start
// that has reserved it but whose job endpoints are not persisted yet — on top of the ports it
// reads from the running-jobs table. The in-memory set is process-wide (it spans every daemon
// in the node), so the caller MUST pass its own daemon's hostPortRange: filtering to the range
// keeps one daemon from advertising another daemon's ports as used. This is exact only because
// daemon ranges are guaranteed DISJOINT — overlap is rejected at config load by
// assertNoOverlappingServiceHostPortRanges (src/utils/config/builder.ts). Returns a fresh array.
export function reservedHostPortsInRange(range: [number, number]): number[] {
  const out: number[] = []
  for (const port of allocatedPorts) if (portInRange(port, range)) out.push(port)
  return out
}

// Best-effort, NON-reserving freeness check for a specific host port — a port is "free" when it
// is neither in the in-memory reservation set nor bound at the OS level. Used by the service
// start handler for a fast 400 on an obviously-unavailable pinned port; it does not reserve, so
// the authoritative, charge-safe reservation stays in the engine (reserveSpecificHostPort).
export function isHostPortFree(port: number): Promise<boolean> {
  if (allocatedPorts.has(port)) return Promise.resolve(false)
  return isPortFree(port)
}

// Thrown when a specifically-requested (pinned) host port cannot be reserved — it is out of
// range or already taken. A CLIENT error: callers map it to 400, not 500.
export class HostPortUnavailableError extends Error {}

// Reserve a SPECIFIC host port requested by the caller. Mirrors allocateHostPort's atomic
// reserve-then-check pattern: synchronous has()->add() closes the TOCTOU window, and the
// reservation is rolled back if the OS port turns out to be busy. `ownedBusyOk` skips BOTH the
// in-memory and OS checks for a port the caller's own (still-running) service already binds — it
// will be freed at teardown and re-bound by the new container. Throws HostPortUnavailableError.
export async function reserveSpecificHostPort(
  port: number,
  rangeStart: number,
  rangeEnd: number,
  opts: { ownedBusyOk?: boolean } = {}
): Promise<void> {
  if (!portInRange(port, [rangeStart, rangeEnd]))
    throw new HostPortUnavailableError(
      `host port ${port} is outside the allowed range ${rangeStart}–${rangeEnd}`
    )
  // ownedBusyOk: the port is already held by the caller's own (still-running) service — it is
  // in allocatedPorts and its old container still binds it. Keep it reserved and skip BOTH the
  // "already taken" check and the OS freeness check (which would both fail for a port we own);
  // it is freed at teardown and re-bound by the new container. Gated on allocatedPorts.has():
  // "owned" is inferred from job.endpoints, but seedAllocatedPorts only seeds RUNNING jobs, so a
  // Stopped/Error service's old port may have been reassigned after a node restart. Only skip the
  // checks when the port is genuinely still in the live reservation set; otherwise fall through to
  // the normal reserve + OS-freeness path so a reassigned port is not blindly double-reserved.
  if (opts.ownedBusyOk && allocatedPorts.has(port)) {
    allocatedPorts.add(port) // idempotent; stays reserved across the restart
    return
  }
  if (allocatedPorts.has(port))
    throw new HostPortUnavailableError(`host port ${port} is not free`)
  allocatedPorts.add(port)
  if (!(await isPortFree(port))) {
    allocatedPorts.delete(port)
    throw new HostPortUnavailableError(`host port ${port} is not free`)
  }
}

// Normalize the two command port forms into the canonical internal shape. `ports` (the
// preferred pair form) supersedes the legacy `exposedPorts` when both are sent (a warning is
// logged). Omitting both ⇒ no exposed ports (unchanged behaviour). This is the single place
// precedence is resolved, so HTTP, P2P and directCommand all behave identically.
export function normalizePortSpec(
  ports?: ServicePortRequest[],
  exposedPorts?: number[]
): { exposedPorts: number[]; requestedHostPorts?: Record<string, number> } {
  if (ports && ports.length) {
    if (exposedPorts && exposedPorts.length)
      CORE_LOGGER.warn(
        'Both "ports" and "exposedPorts" were provided; using "ports" and ignoring "exposedPorts"'
      )
    const requestedHostPorts: Record<string, number> = {}
    for (const p of ports)
      if (p.hostPort !== undefined)
        requestedHostPorts[String(p.containerPort)] = p.hostPort
    return {
      exposedPorts: ports.map((p) => p.containerPort),
      requestedHostPorts: Object.keys(requestedHostPorts).length
        ? requestedHostPorts
        : undefined
    }
  }
  return { exposedPorts: exposedPorts ?? [] }
}

function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.createServer()
    s.once('error', () => resolve(false))
    s.listen(port, '0.0.0.0', () => s.close(() => resolve(true)))
  })
}
