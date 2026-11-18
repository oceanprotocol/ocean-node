import {
  C2DStatusNumber,
  C2DStatusText,
  type ContainerMetricsSnapshot,
  type DBComputeJob
} from '../../../@types/C2D/C2D.js'
import {
  ServiceStatusNumber,
  SERVICE_START_PENDING_STATUSES,
  type ServiceJob,
  type ServiceModelDownload,
  type ServiceReadiness
} from '../../../@types/C2D/ServiceOnDemand.js'
import { DATABASE_LOGGER } from '../../../utils/logging/common.js'
import type { ComputeDatabaseProvider, ServiceJobExpected } from '../C2DDatabase.js'
import {
  ACTIVE_SERVICE_STATUSES,
  EXPIRABLE_SERVICE_STATUSES,
  agreementIdVariants,
  holdsReservation,
  jobToBody,
  matchesExpected,
  oldImageCutoff,
  withJobIdHash
} from '../computeJobs.js'
import { Conditions, SqlClient, insertRow } from './SqlClient.js'

const JOBS = 'c2djobs'
const SERVICE_JOBS = 'service_jobs'
const IMAGES = 'docker_images'
const LOCKS = 'service_locks'
// the input DIDs of a job are one string in the "inputDID" column
const DID_SEPARATOR = '__,__'

// "dateCreated" and "dateFinished" of a job are decimal seconds in a TEXT column: as text,
// '999999999.5' is above '1785760660', so they are compared and sorted as numbers
const asNumber = (column: string) => `CAST("${column}" AS DOUBLE PRECISION)`
const NEWEST_CREATED_FIRST = ` ORDER BY ${asNumber('dateCreated')} DESC`

// PostgreSQL fails a query that casts a text that is not a number, for all rows: such a
// date must not get into the table
function seconds(date: string | null | undefined): string | null {
  if (date === null || date === undefined || date === '') return null
  if (!Number.isFinite(Number(date))) {
    throw new Error(`The date of a job must be in Unix seconds, not '${date}'`)
  }
  return date
}

// a body is JSON text; a database from an older release holds it as bytes
export function parseBody(body: string | Uint8Array): any {
  return JSON.parse(typeof body === 'string' ? body : Buffer.from(body).toString())
}

function rowToJob(row: any): DBComputeJob {
  const { body, expireTimestamp, inputDID, ...columns } = row
  return withJobIdHash({
    ...columns,
    inputDID: typeof inputDID === 'string' ? splitDids(inputDID) : inputDID,
    ...parseBody(body),
    maxJobDuration: expireTimestamp
  })
}

function splitDids(dids: string): string[] {
  return dids === '' ? [] : dids.split(DID_SEPARATOR)
}

// the columns of a service job that change with it; the body holds the full job
function serviceJobColumns(job: ServiceJob): Record<string, unknown> {
  return {
    owner: job.owner,
    clusterHash: job.clusterHash,
    status: job.status,
    expiresAt: job.expiresAt,
    outputArchiveCount: (job.outputArchives ?? []).length,
    body: JSON.stringify({ ...job, updatedAt: Date.now() })
  }
}

const rowToServiceJob = (row: { body: string | Uint8Array }): ServiceJob =>
  parseBody(row.body)

// an owner matches in any letter case
function ownerIs(owner: string): [string, string] {
  return ['LOWER("owner") = ?', owner.toLowerCase()]
}

export class SqlCompute implements ComputeDatabaseProvider {
  constructor(private db: SqlClient) {}

  init(): Promise<void> {
    // "expireTimestamp" holds the maximum job duration
    return this.db.exec(`
      CREATE TABLE IF NOT EXISTS ${JOBS} (
        "jobId" TEXT PRIMARY KEY, "owner" TEXT, "did" TEXT, "dateCreated" TEXT,
        "dateFinished" TEXT, "status" BIGINT, "statusText" TEXT, "inputDID" TEXT,
        "algoDID" TEXT, "agreementId" TEXT, "expireTimestamp" BIGINT, "environment" TEXT,
        "body" TEXT
      );
      CREATE TABLE IF NOT EXISTS ${IMAGES} (
        "image" TEXT PRIMARY KEY, "lastUsedTimestamp" BIGINT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS ${SERVICE_JOBS} (
        "serviceId" TEXT PRIMARY KEY, "owner" TEXT, "clusterHash" TEXT, "status" BIGINT,
        "expiresAt" BIGINT, "dateCreated" TEXT, "outputArchiveCount" BIGINT, "body" TEXT
      );
      CREATE TABLE IF NOT EXISTS ${LOCKS} (
        "serviceId" TEXT PRIMARY KEY, "holder" TEXT NOT NULL, "acquiredAt" BIGINT NOT NULL
      );`)
  }

  // ── C2D jobs ────────────────────────────────────────────────────────

  async newJob(job: DBComputeJob): Promise<string> {
    await insertRow(this.db, JOBS, {
      jobId: job.jobId,
      owner: job.owner,
      did: job.did,
      dateCreated: seconds(job.dateCreated) ?? String(Date.now() / 1000),
      dateFinished: null,
      status: job.status || C2DStatusNumber.JobStarted,
      statusText: job.statusText || C2DStatusText.JobStarted,
      inputDID: job.inputDID?.join(DID_SEPARATOR) ?? null,
      algoDID: job.algoDID,
      agreementId: job.agreementId,
      expireTimestamp: job.maxJobDuration,
      environment: job.environment,
      body: JSON.stringify(jobToBody(job))
    })
    DATABASE_LOGGER.debug(
      `C2D job ${job.clusterHash}-${job.jobId} created (env ${job.environment})`
    )
    return job.jobId
  }

  async getJob(
    jobId?: string,
    agreementId?: string,
    owner?: string
  ): Promise<DBComputeJob[]> {
    const where = new Conditions()
    if (jobId) where.add('"jobId" = ?', jobId)
    if (agreementId) where.addIn('"agreementId"', agreementIdVariants(agreementId))
    if (owner) where.add(...ownerIs(owner))
    const jobs = await this.selectJobs(where)
    if (jobs.length === 0) {
      DATABASE_LOGGER.debug(
        `Could not find any job with jobId: ${jobId}, agreementId: ${agreementId}, or owner: ${owner} in database!`
      )
    }
    return jobs
  }

  async updateJob(job: DBComputeJob): Promise<number> {
    const { changes } = await this.db.run(
      `UPDATE ${JOBS}
       SET "owner" = ?, "status" = ?, "statusText" = ?, "expireTimestamp" = ?, "body" = ?,
           "dateFinished" = ?
       WHERE "jobId" = ?`,
      [
        job.owner,
        job.status,
        job.statusText,
        job.maxJobDuration,
        JSON.stringify(jobToBody(job)),
        seconds(job.dateFinished),
        job.jobId
      ]
    )
    return changes
  }

  async getRunningJobs(engine?: string, environment?: string): Promise<DBComputeJob[]> {
    const where = new Conditions().add('"dateFinished" IS NULL')
    if (environment) where.add('"environment" = ?', environment)
    const jobs = await this.selectJobs(where, ` ORDER BY ${asNumber('dateCreated')} ASC`)
    // the engine (clusterHash) is in the body, so it is filtered here
    return engine ? jobs.filter((job) => job.clusterHash === engine) : jobs
  }

  async deleteJob(jobId: string): Promise<boolean> {
    const { changes } = await this.db.run(`DELETE FROM ${JOBS} WHERE "jobId" = ?`, [
      jobId
    ])
    return changes === 1
  }

  getFinishedJobs(environments?: string[]): Promise<DBComputeJob[]> {
    return this.selectJobs(
      new Conditions()
        .add('"dateFinished" IS NOT NULL')
        .addIn('"environment"', environments),
      ` ORDER BY ${asNumber('dateFinished')} DESC`
    )
  }

  /** @param fromTimestamp lower bound in Unix seconds — see C2DDatabase.getJobs. */
  getJobs(
    environments?: string[],
    fromTimestamp?: number,
    consumerAddrs?: string[],
    status?: C2DStatusNumber,
    runningJobs?: boolean
  ): Promise<DBComputeJob[]> {
    const where = new Conditions().addIn('"environment"', environments)
    const hasFrom = fromTimestamp !== undefined && fromTimestamp !== null
    if (runningJobs) {
      where.add('"status" = ?', C2DStatusNumber.RunningAlgorithm)
      if (hasFrom) where.add(`${asNumber('dateCreated')} >= ?`, fromTimestamp)
    } else {
      if (hasFrom) where.add(`${asNumber('dateFinished')} >= ?`, fromTimestamp)
      // C2DStatusNumber.JobStarted is 0: a truthiness check would drop the filter
      if (status !== undefined && status !== null) where.add('"status" = ?', status)
    }
    where.addIn(
      'LOWER("owner")',
      consumerAddrs?.map((address) => address.toLowerCase())
    )
    return this.selectJobs(where, NEWEST_CREATED_FIRST)
  }

  getJobsByStatus(
    environments: string[],
    status: C2DStatusNumber[]
  ): Promise<DBComputeJob[]> {
    return this.selectJobs(
      new Conditions().addIn('"environment"', environments).addIn('"status"', status),
      NEWEST_CREATED_FIRST
    )
  }

  private async selectJobs(where: Conditions, orderBy = ''): Promise<DBComputeJob[]> {
    const rows = await this.db.all(
      `SELECT * FROM ${JOBS}${where}${orderBy}`,
      where.params
    )
    return rows.map(rowToJob)
  }

  // ── Docker images ───────────────────────────────────────────────────

  async updateImage(image: string): Promise<void> {
    await this.db.run(
      `INSERT INTO ${IMAGES} ("image", "lastUsedTimestamp") VALUES (?, ?)
       ON CONFLICT ("image") DO UPDATE SET "lastUsedTimestamp" = excluded."lastUsedTimestamp"`,
      [image, Math.floor(Date.now() / 1000)]
    )
    DATABASE_LOGGER.debug(`Updated image usage timestamp for ${image}`)
  }

  async deleteImage(image: string): Promise<void> {
    await this.db.run(`DELETE FROM ${IMAGES} WHERE "image" = ?`, [image])
    DATABASE_LOGGER.debug(`Deleted image ${image}`)
  }

  async getOldImages(retentionDays: number): Promise<string[]> {
    const cutoff = oldImageCutoff(retentionDays)
    const rows = await this.db.all<{ image: string }>(
      `SELECT "image" FROM ${IMAGES}
       WHERE "lastUsedTimestamp" < ? ORDER BY "lastUsedTimestamp" ASC`,
      [cutoff]
    )
    return rows.map((row) => row.image)
  }

  // ── Service-on-Demand jobs ──────────────────────────────────────────

  async newServiceJob(job: ServiceJob): Promise<void> {
    await insertRow(this.db, SERVICE_JOBS, {
      serviceId: job.serviceId,
      dateCreated: job.dateCreated,
      ...serviceJobColumns(job)
    })
  }

  getServiceJob(serviceId?: string, owner?: string): Promise<ServiceJob[]> {
    const where = new Conditions()
    if (serviceId) where.add('"serviceId" = ?', serviceId)
    if (owner) where.add(...ownerIs(owner))
    return this.selectServiceJobs(where)
  }

  async updateServiceJob(job: ServiceJob): Promise<number> {
    const columns = serviceJobColumns(job)
    const assignments = Object.keys(columns).map((column) => `"${column}" = ?`)
    const { changes } = await this.db.run(
      `UPDATE ${SERVICE_JOBS} SET ${assignments.join(', ')} WHERE "serviceId" = ?`,
      [...Object.values(columns), job.serviceId]
    )
    return changes
  }

  updateServiceJobMetrics(
    serviceId: string,
    expected: ServiceJobExpected,
    runtimeMetrics: ContainerMetricsSnapshot
  ): Promise<boolean> {
    return this.patchServiceJobBody(serviceId, expected, 'metrics', (body) => {
      body.runtimeMetrics = runtimeMetrics
    })
  }

  // `readiness` is undefined for a service that the node cannot probe
  updateServiceJobReadiness(
    serviceId: string,
    expected: ServiceJobExpected,
    readiness: ServiceReadiness | undefined,
    modelDownload?: ServiceModelDownload
  ): Promise<boolean> {
    return this.patchServiceJobBody(serviceId, expected, 'readiness', (body) => {
      if (readiness) body.readiness = readiness
      // changed only by a new sample: the last figures stay as the record of the download
      if (modelDownload) body.modelDownload = modelDownload
    })
  }

  // Every status before Expired holds the paid reservation; see ACTIVE_SERVICE_STATUSES.
  async getRunningServiceJobs(clusterHash?: string): Promise<ServiceJob[]> {
    const jobs = await this.selectServiceJobs(
      inCluster(clusterHash).addIn('"status"', ACTIVE_SERVICE_STATUSES)
    )
    // filtered here: the payment is in the body
    return jobs.filter(holdsReservation)
  }

  // The services that the sweep must release: past their end, in a status that still
  // holds the reservation.
  getExpiredServiceJobs(clusterHash?: string): Promise<ServiceJob[]> {
    return this.selectServiceJobs(
      inCluster(clusterHash)
        .addIn('"status"', EXPIRABLE_SERVICE_STATUSES)
        .add('"expiresAt" <= ?', Date.now())
    )
  }

  // Expired services that still have output archives. Expired rows stay forever, so the
  // archive filter is in SQL: a cleanup run must not read every service that ever expired.
  getExpiredServiceJobsBefore(
    expiresBefore: number,
    clusterHash?: string
  ): Promise<ServiceJob[]> {
    return this.selectServiceJobs(
      inCluster(clusterHash)
        .add('"status" = ?', ServiceStatusNumber.Expired)
        .add('"expiresAt" <= ?', expiresBefore)
        .add('"outputArchiveCount" > 0')
    )
  }

  // the services that are in the middle of a start and need the background loop
  getPendingServiceStarts(clusterHash?: string): Promise<ServiceJob[]> {
    return this.selectServiceJobs(
      inCluster(clusterHash).addIn('"status"', SERVICE_START_PENDING_STATUSES)
    )
  }

  private async selectServiceJobs(where: Conditions): Promise<ServiceJob[]> {
    const rows = await this.db.all(
      `SELECT "body" FROM ${SERVICE_JOBS}${where}`,
      where.params
    )
    return rows.map(rowToServiceJob)
  }

  // Writes ONE best-effort field (metrics, readiness) of a service job and no lifecycle
  // field. In one transaction it reads the row again, checks that owner, cluster, status
  // and container did not change, applies `patch` to the current body and writes the body
  // only. A mismatch or an error gives false: the caller samples again later.
  private async patchServiceJobBody(
    serviceId: string,
    expected: ServiceJobExpected,
    what: string,
    patch: (body: ServiceJob) => void
  ): Promise<boolean> {
    try {
      return await this.db.transaction(async (tx) => {
        const row = await tx.get(
          `SELECT "body" FROM ${SERVICE_JOBS} WHERE "serviceId" = ?${tx.rowLock}`,
          [serviceId]
        )
        const body = row && rowToServiceJob(row)
        if (!body || !matchesExpected(body, expected)) return false
        patch(body)
        const { changes } = await tx.run(
          `UPDATE ${SERVICE_JOBS} SET "body" = ? WHERE "serviceId" = ? AND "status" = ?`,
          [JSON.stringify({ ...body, updatedAt: Date.now() }), serviceId, expected.status]
        )
        return changes > 0
      })
    } catch (error) {
      DATABASE_LOGGER.error(
        `Error while updating ${what} of service job ${serviceId}: ${error.message}`
      )
      return false
    }
  }

  // ── Service locks ───────────────────────────────────────────────────
  // A row is an exclusive start, stop or restart of a service, held by `holder` (one id
  // per process). The holder refreshes "acquiredAt" while it works; a row older than the
  // stale limit is from a holder that crashed, and another holder can take it.

  // One statement inserts the row or takes a stale one, so two holders that race can
  // never both get the lock.
  async acquireServiceLock(
    serviceId: string,
    holder: string,
    staleMs: number
  ): Promise<boolean> {
    const now = Date.now()
    const { changes } = await this.db.run(
      `INSERT INTO ${LOCKS} ("serviceId", "holder", "acquiredAt") VALUES (?, ?, ?)
       ON CONFLICT ("serviceId") DO UPDATE
         SET "holder" = excluded."holder", "acquiredAt" = excluded."acquiredAt"
         WHERE ${LOCKS}."acquiredAt" <= ?`,
      [serviceId, holder, now, now - staleMs]
    )
    return changes === 1
  }

  // only the holder releases: a stale lock that another holder took stays
  async releaseServiceLock(serviceId: string, holder: string): Promise<void> {
    await this.db.run(`DELETE FROM ${LOCKS} WHERE "serviceId" = ? AND "holder" = ?`, [
      serviceId,
      holder
    ])
  }

  async refreshServiceLocks(holder: string): Promise<void> {
    await this.db.run(`UPDATE ${LOCKS} SET "acquiredAt" = ? WHERE "holder" = ?`, [
      Date.now(),
      holder
    ])
  }

  async isServiceLocked(serviceId: string, staleMs: number): Promise<boolean> {
    const row = await this.db.get<{ acquiredAt: number }>(
      `SELECT "acquiredAt" FROM ${LOCKS} WHERE "serviceId" = ?`,
      [serviceId]
    )
    return !!row && row.acquiredAt > Date.now() - staleMs
  }

  async deleteStaleServiceLocks(staleMs: number): Promise<number> {
    const { changes } = await this.db.run(
      `DELETE FROM ${LOCKS} WHERE "acquiredAt" <= ?`,
      [Date.now() - staleMs]
    )
    return changes
  }
}

function inCluster(clusterHash?: string): Conditions {
  const where = new Conditions()
  return clusterHash ? where.add('"clusterHash" = ?', clusterHash) : where
}
