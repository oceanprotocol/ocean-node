import net from 'net'
import type { ServiceJob } from '../../../@types/C2D/ServiceOnDemand.js'
import { EncryptMethod } from '../../../@types/fileObject.js'
import type { KeyManager } from '../../KeyManager/index.js'
import type { C2DDatabase } from '../../database/C2DDatabase.js'

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
    // eslint-disable-next-line no-await-in-loop
    if (await isPortFree(candidate)) {
      allocatedPorts.add(candidate)
      return candidate
    }
  }
  throw new Error(`No free host port in range ${rangeStart}–${rangeEnd}`)
}

export function releaseHostPort(port: number): void {
  allocatedPorts.delete(port)
}

function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.createServer()
    s.once('error', () => resolve(false))
    s.listen(port, '0.0.0.0', () => s.close(() => resolve(true)))
  })
}
