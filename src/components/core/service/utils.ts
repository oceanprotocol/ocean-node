import net from 'net'
import type { ServiceJob } from '../../../@types/C2D/ServiceOnDemand.js'
import { EncryptMethod } from '../../../@types/fileObject.js'
import type { KeyManager } from '../../KeyManager/index.js'
import type { C2DDatabase } from '../../database/C2DDatabase.js'
import type { C2DEngine } from '../../c2d/compute_engine_base.js'
import type { C2DEngines } from '../../c2d/compute_engines.js'

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
  job: ServiceJob | null
): Omit<ServiceJob, 'userData'> | null {
  if (!job) return null
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { userData, ...pub } = job
  return pub
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

export async function seedAllocatedPorts(
  db: C2DDatabase,
  clusterHash: string
): Promise<void> {
  const jobs = await db.getRunningServiceJobs(clusterHash)
  for (const job of jobs) for (const ep of job.endpoints) allocatedPorts.add(ep.hostPort)
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
    // eslint-disable-next-line no-await-in-loop
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

function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.createServer()
    s.once('error', () => resolve(false))
    s.listen(port, '0.0.0.0', () => s.close(() => resolve(true)))
  })
}
