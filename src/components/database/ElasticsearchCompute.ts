import { Client, estypes } from '@elastic/elasticsearch'
import {
  C2DStatusNumber,
  C2DStatusText,
  type DBComputeJob,
  type ContainerMetricsSnapshot
} from '../../@types/C2D/C2D.js'
import {
  ServiceStatusNumber,
  SERVICE_START_PENDING_STATUSES,
  SERVICE_STOPPED_STATUSES,
  isStoppedLike,
  type ServiceJob,
  type ServiceModelDownload,
  type ServiceReadiness
} from '../../@types/C2D/ServiceOnDemand.js'
import { OceanNodeDBConfig } from '../../@types/OceanNode.js'
import { DATABASE_LOGGER } from '../../utils/logging/common.js'
import { create256Hash } from '../../utils/crypt.js'
import type { ComputeDatabaseProvider, ServiceJobExpected } from './C2DDatabase.js'
import {
  createElasticsearchClientWithRetry,
  ensureIndex,
  getOrNull
} from './ElasticsearchConfigHelper.js'
import { stateSchemas } from './ElasticSchemas.js'

const JOBS_INDEX = stateSchemas.c2dJobs.index
const SERVICE_INDEX = stateSchemas.serviceJobs.index
const IMAGES_INDEX = stateSchemas.dockerImages.index
const LOCKS_INDEX = stateSchemas.serviceLocks.index
// Elasticsearch's default result window
const MAX_RESULTS = 10000
const SECONDS_PER_DAY = 24 * 60 * 60
// replaces the listed top-level fields, like the SQL UPDATE ... SET did (a partial `doc`
// update would deep-merge the old body into the new one)
const SET_FIELDS_SCRIPT = 'ctx._source.putAll(params.fields)'
// lifecycle writes retry when they collide with a guarded body patch
const UPDATE_RETRIES = 3
const NEWEST_CREATED_FIRST: estypes.Sort = [{ dateCreated: { order: 'desc' } }]

// the jobId is the document id
type JobDoc = {
  owner: string
  did: string
  dateCreated: number | null
  dateFinished: number | null
  status: number
  statusText: string
  inputDID: string[]
  algoDID: string
  agreementId: string
  expireTimestamp: number
  environment: string
  body: any
}

// the serviceId is the document id; acquiredAt in Unix ms
type LockDoc = {
  holder: string
  acquiredAt: number
}

type ServiceJobDoc = {
  owner: string
  clusterHash: string
  status: number
  expiresAt: number
  dateCreated: string
  outputArchiveCount: number
  body: ServiceJob
}

// Every status before Expired is "active": the consumer paid for the resources for a TIME
// WINDOW, so the reservation holds from the moment the record is created (Starting) through
// the whole start pipeline, while Running/Restarting/Stopping, through Error (container died
// on its own) AND through an explicit Stopped — a stopped service can be restarted anytime on
// the same resources until expiresAt. Only expiry releases the reservation.
const ACTIVE_SERVICE_STATUSES = [
  ServiceStatusNumber.Starting,
  ServiceStatusNumber.Locking,
  ServiceStatusNumber.PullImage,
  ServiceStatusNumber.BuildImage,
  ServiceStatusNumber.Claiming,
  ServiceStatusNumber.Running,
  ServiceStatusNumber.Restarting,
  ServiceStatusNumber.Stopping,
  ...SERVICE_STOPPED_STATUSES,
  ServiceStatusNumber.Error
]

// Running, Error and Stopped all still hold their paid reservation, so all must be swept once
// past expiresAt: the sweep is the ONLY place the reservation is released. Stopping is swept
// too: a process crash mid-stop persists that status and nothing else recovers it.
const EXPIRABLE_SERVICE_STATUSES = [
  ServiceStatusNumber.Running,
  ServiceStatusNumber.Error,
  ...SERVICE_STOPPED_STATUSES,
  ServiceStatusNumber.Stopping
]

// The node-internal job fields that live in the unindexed body.
export function jobToBody(job: DBComputeJob): any {
  return {
    clusterHash: job.clusterHash,
    configlogURL: job.configlogURL,
    publishlogURL: job.publishlogURL,
    algologURL: job.algologURL,
    outputsURL: job.outputsURL,
    stopRequested: job.stopRequested,
    algorithm: job.algorithm,
    assets: job.assets,
    isRunning: job.isRunning,
    isStarted: job.isStarted,
    containerImage: job.containerImage,
    resources: job.resources,
    isFree: job.isFree,
    algoStartTimestamp: job.algoStartTimestamp,
    algoStopTimestamp: job.algoStopTimestamp,
    metadata: job.metadata,
    additionalViewers: job.additionalViewers,
    terminationDetails: job.terminationDetails,
    payment: job.payment,
    algoDuration: job.algoDuration,
    queueMaxWaitTime: job.queueMaxWaitTime,
    output: job.output,
    outputBucketId: job.outputBucketId,
    jobIdHash: job.jobIdHash,
    buildStartTimestamp: job.buildStartTimestamp,
    buildStopTimestamp: job.buildStopTimestamp,
    // Runtime metrics snapshot. It MUST round-trip through the body: it is what the owner
    // reads back on COMPUTE_GET_STATUS, and it is also the previous-sample accumulator every
    // next sample needs — without it persisted, every sample is a "first sample", so CPU %
    // can never be computed (no delta) and the memory peak never accumulates. Still
    // node-internal on the way out: omitDBComputeFieldsFromComputeJob strips it unless the
    // verified owner asked for it, so it stays out of the escrow claim proof.
    runtimeMetrics: job.runtimeMetrics
  }
}

// dates are stored as numbers so they compare and sort numerically, and read back as the
// decimal-seconds strings the callers use
function secondsToNumber(seconds: string | null | undefined): number | null {
  return seconds ? Number(seconds) : null
}

function numberToSeconds(seconds: number | null | undefined): string | null {
  return seconds === null || seconds === undefined ? null : String(seconds)
}

function docToJob(jobId: string, doc: JobDoc): DBComputeJob {
  const { body, expireTimestamp, dateCreated, dateFinished, ...columns } = doc
  const job: DBComputeJob = {
    ...columns,
    jobId,
    dateCreated: numberToSeconds(dateCreated),
    dateFinished: numberToSeconds(dateFinished),
    ...body,
    maxJobDuration: expireTimestamp
  }
  if (!job.jobIdHash && job.jobId) {
    job.jobIdHash = create256Hash(job.jobId)
  }
  return job
}

function serviceJobToDoc(job: ServiceJob): ServiceJobDoc {
  return {
    owner: job.owner,
    clusterHash: job.clusterHash,
    status: job.status,
    expiresAt: job.expiresAt,
    dateCreated: job.dateCreated,
    outputArchiveCount: (job.outputArchives ?? []).length,
    body: { ...job, updatedAt: Date.now() }
  }
}

function isStatus(error: any, statusCode: number): boolean {
  return error?.meta?.statusCode === statusCode
}

// agreementIds are stored as given; match both the 0x-prefixed and the bare form
function agreementIdVariants(agreementId: string): string[] {
  return agreementId.startsWith('0x')
    ? [agreementId, agreementId.slice(2)]
    : [agreementId, '0x' + agreementId]
}

function jobFilter(
  agreementId?: string,
  owner?: string
): estypes.QueryDslQueryContainer[] {
  const filter: estypes.QueryDslQueryContainer[] = []
  if (agreementId)
    filter.push({ terms: { agreementId: agreementIdVariants(agreementId) } })
  if (owner) filter.push({ term: { owner: owner.toLowerCase() } })
  return filter
}

// the owner columns match case-insensitively (lowercase normalizer); same rule for reads by id
function sameAddress(stored: string | undefined, given: string): boolean {
  return stored?.toLowerCase() === given.toLowerCase()
}

function clusterFilter(clusterHash?: string): estypes.QueryDslQueryContainer[] {
  return clusterHash ? [{ term: { clusterHash } }] : []
}

// jobs: id = jobId; service jobs and locks: id = serviceId; images: id = image name
export class ElasticsearchCompute implements ComputeDatabaseProvider {
  private constructor(private config: OceanNodeDBConfig) {}

  // resolved per call: the health monitor replaces the client after a reconnect
  private client(): Promise<Client> {
    return createElasticsearchClientWithRetry(this.config)
  }

  static async create(config: OceanNodeDBConfig): Promise<ElasticsearchCompute> {
    await ensureIndex(config, stateSchemas.c2dJobs)
    await ensureIndex(config, stateSchemas.serviceJobs)
    await ensureIndex(config, stateSchemas.dockerImages)
    await ensureIndex(config, stateSchemas.serviceLocks)
    return new ElasticsearchCompute(config)
  }

  // ── C2D jobs ────────────────────────────────────────────────────────

  async newJob(job: DBComputeJob): Promise<string> {
    const document: JobDoc = {
      owner: job.owner,
      did: job.did,
      dateCreated: secondsToNumber(job.dateCreated || String(Date.now() / 1000)),
      dateFinished: null,
      status: job.status || C2DStatusNumber.JobStarted,
      statusText: job.statusText || C2DStatusText.JobStarted,
      inputDID: job.inputDID,
      algoDID: job.algoDID,
      agreementId: job.agreementId,
      expireTimestamp: job.maxJobDuration,
      environment: job.environment,
      body: jobToBody(job)
    }
    const client = await this.client()
    await client.create({
      index: JOBS_INDEX,
      id: job.jobId,
      document,
      refresh: 'wait_for'
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
    const jobs = jobId
      ? await this.getJobById(jobId, agreementId, owner)
      : await this.searchJobs({ bool: { filter: jobFilter(agreementId, owner) } })
    if (jobs.length === 0) {
      DATABASE_LOGGER.debug(
        `Could not find any job with jobId: ${jobId}, agreementId: ${agreementId}, or owner: ${owner} in database!`
      )
    }
    return jobs
  }

  // real-time read by id; the other filters are applied to the document
  private async getJobById(
    jobId: string,
    agreementId?: string,
    owner?: string
  ): Promise<DBComputeJob[]> {
    const row = await getOrNull<JobDoc>(await this.client(), JOBS_INDEX, jobId)
    if (!row) return []
    const doc = row.source
    if (agreementId && !agreementIdVariants(agreementId).includes(doc.agreementId)) {
      return []
    }
    if (owner && !sameAddress(doc.owner, owner)) return []
    return [docToJob(jobId, doc)]
  }

  // like the SQL UPDATE: only owner, status, statusText, maxJobDuration, body and
  // dateFinished change; returns the number of updated jobs
  async updateJob(job: DBComputeJob): Promise<number> {
    const fields: Partial<JobDoc> = {
      owner: job.owner ?? null,
      status: job.status ?? null,
      statusText: job.statusText ?? null,
      expireTimestamp: job.maxJobDuration ?? null,
      body: jobToBody(job),
      dateFinished: secondsToNumber(job.dateFinished)
    }
    try {
      const client = await this.client()
      await client.update({
        index: JOBS_INDEX,
        id: job.jobId,
        script: { source: SET_FIELDS_SCRIPT, params: { fields } },
        // the script replaces the fields fully, so a retry keeps last-write-wins against a
        // concurrent guarded body patch
        retry_on_conflict: UPDATE_RETRIES,
        refresh: 'wait_for'
      })
      return 1
    } catch (error) {
      if (isStatus(error, 404)) return 0
      DATABASE_LOGGER.error(`Error while updating job ${job.jobId}: ${error.message}`)
      throw error
    }
  }

  async getRunningJobs(engine?: string, environment?: string): Promise<DBComputeJob[]> {
    const jobs = await this.searchJobs(
      { bool: { must_not: [{ exists: { field: 'dateFinished' } }] } },
      [{ dateCreated: { order: 'asc' } }]
    )
    return jobs.filter(
      (job) =>
        (!engine || engine === job.clusterHash) &&
        (!environment || environment === job.environment) &&
        !job.dateFinished
    )
  }

  async deleteJob(jobId: string): Promise<boolean> {
    try {
      const client = await this.client()
      await client.delete({ index: JOBS_INDEX, id: jobId, refresh: 'wait_for' })
      return true
    } catch (error) {
      if (isStatus(error, 404)) return false
      throw error
    }
  }

  async getFinishedJobs(environments?: string[]): Promise<DBComputeJob[]> {
    const filter: estypes.QueryDslQueryContainer[] = [
      { exists: { field: 'dateFinished' } },
      ...environmentFilter(environments)
    ]
    return await this.searchJobs({ bool: { filter } }, [
      { dateFinished: { order: 'desc' } }
    ])
  }

  /** @param fromTimestamp lower bound in Unix seconds — see C2DDatabase.getJobs. */
  async getJobs(
    environments?: string[],
    fromTimestamp?: number,
    consumerAddrs?: string[],
    status?: C2DStatusNumber,
    runningJobs?: boolean
  ): Promise<DBComputeJob[]> {
    const filter = environmentFilter(environments)
    const hasFrom = fromTimestamp !== undefined && fromTimestamp !== null
    if (runningJobs) {
      filter.push({ term: { status: C2DStatusNumber.RunningAlgorithm } })
      if (hasFrom) filter.push({ range: { dateCreated: { gte: fromTimestamp } } })
    } else {
      if (hasFrom) filter.push({ range: { dateFinished: { gte: fromTimestamp } } })
      // C2DStatusNumber.JobStarted is 0, so a truthiness check would silently drop the
      // filter and return every status instead.
      if (status !== undefined && status !== null) filter.push({ term: { status } })
    }
    if (consumerAddrs && consumerAddrs.length > 0) {
      filter.push({
        terms: { owner: consumerAddrs.map((address) => address.toLowerCase()) }
      })
    }
    return await this.searchJobs({ bool: { filter } }, NEWEST_CREATED_FIRST)
  }

  async getJobsByStatus(
    environments: string[],
    status: C2DStatusNumber[]
  ): Promise<DBComputeJob[]> {
    const filter = environmentFilter(environments)
    if (status && status.length > 0) filter.push({ terms: { status } })
    return await this.searchJobs({ bool: { filter } }, NEWEST_CREATED_FIRST)
  }

  private async searchJobs(
    query: estypes.QueryDslQueryContainer,
    sort?: estypes.Sort
  ): Promise<DBComputeJob[]> {
    const client = await this.client()
    const result = await client.search<JobDoc>({
      index: JOBS_INDEX,
      query,
      sort,
      size: MAX_RESULTS
    })
    return result.hits.hits.map((hit) => docToJob(hit._id, hit._source))
  }

  // ── Docker images ───────────────────────────────────────────────────

  async updateImage(image: string): Promise<void> {
    const client = await this.client()
    await client.index({
      index: IMAGES_INDEX,
      id: image,
      document: { lastUsedTimestamp: Math.floor(Date.now() / 1000) },
      refresh: 'wait_for'
    })
    DATABASE_LOGGER.debug(`Updated image usage timestamp for ${image}`)
  }

  async deleteImage(image: string): Promise<void> {
    try {
      const client = await this.client()
      await client.delete({ index: IMAGES_INDEX, id: image, refresh: 'wait_for' })
      DATABASE_LOGGER.debug(`Deleted image ${image}`)
    } catch (error) {
      if (!isStatus(error, 404)) throw error
    }
  }

  async getOldImages(retentionDays: number = 7): Promise<string[]> {
    const cutoff = Math.floor(Date.now() / 1000) - retentionDays * SECONDS_PER_DAY
    const client = await this.client()
    const result = await client.search({
      index: IMAGES_INDEX,
      query: { range: { lastUsedTimestamp: { lt: cutoff } } },
      sort: [{ lastUsedTimestamp: { order: 'asc' } }],
      _source: false,
      size: MAX_RESULTS
    })
    return result.hits.hits.map((hit) => hit._id)
  }

  // ── Service-on-Demand jobs ──────────────────────────────────────────

  async newServiceJob(job: ServiceJob): Promise<void> {
    const client = await this.client()
    await client.create({
      index: SERVICE_INDEX,
      id: job.serviceId,
      document: serviceJobToDoc(job),
      refresh: 'wait_for'
    })
  }

  async getServiceJob(serviceId?: string, owner?: string): Promise<ServiceJob[]> {
    // callers are checksum-normalized on ingress, but older rows may hold another casing
    if (!serviceId) {
      return await this.searchServiceJobs(
        owner ? [{ term: { owner: owner.toLowerCase() } }] : []
      )
    }
    const row = await getOrNull<ServiceJobDoc>(
      await this.client(),
      SERVICE_INDEX,
      serviceId
    )
    if (!row || (owner && !sameAddress(row.source.owner, owner))) return []
    return [row.source.body]
  }

  // like the SQL UPDATE: every column but dateCreated; returns the number of updated jobs
  async updateServiceJob(job: ServiceJob): Promise<number> {
    const { dateCreated, ...fields } = serviceJobToDoc(job)
    try {
      const client = await this.client()
      await client.update({
        index: SERVICE_INDEX,
        id: job.serviceId,
        script: { source: SET_FIELDS_SCRIPT, params: { fields } },
        // the script replaces the fields fully, so a retry keeps last-write-wins against a
        // concurrent guarded body patch
        retry_on_conflict: UPDATE_RETRIES,
        refresh: 'wait_for'
      })
      return 1
    } catch (error) {
      if (isStatus(error, 404)) return 0
      DATABASE_LOGGER.error(
        `Error while updating service job ${job.serviceId}: ${error.message}`
      )
      throw error
    }
  }

  async updateServiceJobMetrics(
    serviceId: string,
    expected: ServiceJobExpected,
    runtimeMetrics: ContainerMetricsSnapshot
  ): Promise<boolean> {
    return await this.patchServiceJobBody(serviceId, expected, 'metrics', (body) => {
      body.runtimeMetrics = runtimeMetrics
    })
  }

  // Same guarantees as updateServiceJobMetrics, for the readiness probe result: it is sampled
  // from the same lease-free background loop, so it must never overwrite a lifecycle
  // transition either. `readiness` is undefined for a service the node cannot probe.
  async updateServiceJobReadiness(
    serviceId: string,
    expected: ServiceJobExpected,
    readiness: ServiceReadiness | undefined,
    modelDownload?: ServiceModelDownload
  ): Promise<boolean> {
    return await this.patchServiceJobBody(serviceId, expected, 'readiness', (body) => {
      if (readiness) body.readiness = readiness
      // Only overwritten when a fresh sample was taken: once the engine is ready the walk
      // stops, and the last figures stay as the record of what was downloaded.
      if (modelDownload) body.modelDownload = modelDownload
    })
  }

  // Persists ONE best-effort, non-lifecycle field onto a service job without clobbering
  // lifecycle fields another process may have changed: reads the current document, checks
  // owner/clusterHash/status/containerId, applies `patch` to the current body and writes it
  // back only if the document is unchanged since the read (if_seq_no/if_primary_term). A
  // lifecycle write in between makes the write fail with 409. Returns true when written.
  private async patchServiceJobBody(
    serviceId: string,
    expected: ServiceJobExpected,
    what: string,
    patch: (body: ServiceJob) => void
  ): Promise<boolean> {
    try {
      const client = await this.client()
      const current = await getOrNull<ServiceJobDoc>(client, SERVICE_INDEX, serviceId)
      if (!current) return false
      const { body } = current.source
      if (
        body.owner !== expected.owner ||
        body.clusterHash !== expected.clusterHash ||
        body.status !== expected.status ||
        body.containerId !== expected.containerId
      ) {
        return false
      }
      patch(body)
      await client.index({
        index: SERVICE_INDEX,
        id: serviceId,
        document: {
          ...current.source,
          outputArchiveCount: (body.outputArchives ?? []).length,
          body: { ...body, updatedAt: Date.now() }
        },
        if_seq_no: current.seqNo,
        if_primary_term: current.primaryTerm,
        refresh: 'wait_for'
      })
      return true
    } catch (error) {
      if (isStatus(error, 409)) return false
      DATABASE_LOGGER.error(
        `Error while updating ${what} of service job ${serviceId}: ${error.message}`
      )
      return false
    }
  }

  async getRunningServiceJobs(clusterHash?: string): Promise<ServiceJob[]> {
    const jobs = await this.searchServiceJobs([
      { terms: { status: ACTIVE_SERVICE_STATUSES } },
      ...clusterFilter(clusterHash)
    ])
    // The reservation is tied to PAYMENT: an Error/Stopped job whose payment was never
    // claimed (escrow lock failed or refunded) must not hold resources, or anyone could
    // squat a node's GPU for free. Mid-pipeline statuses keep reserving even without
    // claimTx — they are en route to payment. Filtered here: payment lives in the body.
    return jobs.filter(
      (j) =>
        (j.status !== ServiceStatusNumber.Error && !isStoppedLike(j.status)) ||
        !!j.payment?.claimTx
    )
  }

  async getExpiredServiceJobs(clusterHash?: string): Promise<ServiceJob[]> {
    return await this.searchServiceJobs([
      { terms: { status: EXPIRABLE_SERVICE_STATUSES } },
      { range: { expiresAt: { lte: Date.now() } } },
      ...clusterFilter(clusterHash)
    ])
  }

  // Expired (terminal) services whose paid window ended at or before `expiresBefore` (Unix
  // ms) and that still hold output archives — candidates for deleting them once storage
  // expiry has elapsed. Expired jobs are kept forever (with outputArchives: [] once
  // cleaned), so the archive count is filtered in the query.
  async getExpiredServiceJobsBefore(
    expiresBefore: number,
    clusterHash?: string
  ): Promise<ServiceJob[]> {
    return await this.searchServiceJobs([
      { term: { status: ServiceStatusNumber.Expired } },
      { range: { expiresAt: { lte: expiresBefore } } },
      { range: { outputArchiveCount: { gt: 0 } } },
      ...clusterFilter(clusterHash)
    ])
  }

  // Service jobs that are mid-start and need the background loop to advance them, including
  // the intermediate states so the loop can resume them after a node restart.
  async getPendingServiceStarts(clusterHash?: string): Promise<ServiceJob[]> {
    return await this.searchServiceJobs([
      { terms: { status: [...SERVICE_START_PENDING_STATUSES] } },
      ...clusterFilter(clusterHash)
    ])
  }

  private async searchServiceJobs(
    filter: estypes.QueryDslQueryContainer[]
  ): Promise<ServiceJob[]> {
    const client = await this.client()
    const result = await client.search<ServiceJobDoc>({
      index: SERVICE_INDEX,
      query: { bool: { filter } },
      size: MAX_RESULTS
    })
    return result.hits.hits.map((hit) => hit._source.body)
  }

  // ── Service lifecycle locks ─────────────────────────────────────────

  // Takes the lock for serviceId: creates the lock document, or takes over a lock whose
  // acquiredAt is at least staleMs old (crashed holder). The takeover writes only if the
  // document is unchanged since the read (if_seq_no/if_primary_term), so two instances
  // racing for one stale lock can never both win. The lock now works across hosts that
  // share the Elasticsearch cluster; claims of queued C2D jobs stay in issue #1553.
  // A lock released between the create and the read returns false: the callers retry.
  async acquireServiceLock(
    serviceId: string,
    holder: string,
    staleMs: number
  ): Promise<boolean> {
    // refresh: true, not wait_for: refreshServiceLocks searches, so it must see the new
    // lock; lock writes are rare and tiny, and this skips the up-to-1 s refresh wait
    const write = { index: LOCKS_INDEX, id: serviceId, refresh: true }
    const client = await this.client()
    try {
      await client.index({
        ...write,
        document: { holder, acquiredAt: Date.now() },
        op_type: 'create'
      })
      return true
    } catch (error) {
      if (!isStatus(error, 409)) throw error
    }
    const current = await getOrNull<LockDoc>(client, LOCKS_INDEX, serviceId)
    if (!current || current.source.acquiredAt > Date.now() - staleMs) return false
    try {
      await client.index({
        ...write,
        document: { holder, acquiredAt: Date.now() },
        if_seq_no: current.seqNo,
        if_primary_term: current.primaryTerm
      })
      return true
    } catch (error) {
      if (isStatus(error, 409)) return false
      throw error
    }
  }

  // Releases only a lock this holder still holds: a stale lock taken over by another
  // instance must not be deleted out from under its new holder.
  async releaseServiceLock(serviceId: string, holder: string): Promise<void> {
    const client = await this.client()
    const current = await getOrNull<LockDoc>(client, LOCKS_INDEX, serviceId)
    if (!current || current.source.holder !== holder) return
    try {
      await client.delete({
        index: LOCKS_INDEX,
        id: serviceId,
        if_seq_no: current.seqNo,
        if_primary_term: current.primaryTerm
      })
    } catch (error) {
      // someone else took the lock in between, or it is already gone
      if (!isStatus(error, 409) && !isStatus(error, 404)) throw error
    }
  }

  // Heartbeat: re-stamps every lock this holder owns, so long operations (multi-minute
  // image pulls and builds) are not taken over as stale.
  async refreshServiceLocks(holder: string): Promise<void> {
    const client = await this.client()
    await client.updateByQuery({
      index: LOCKS_INDEX,
      query: { term: { holder } },
      script: {
        source: 'ctx._source.acquiredAt = params.now',
        params: { now: Date.now() }
      },
      refresh: true,
      conflicts: 'proceed'
    })
  }

  // True while any instance holds a fresh lock on serviceId; read-only observers (the
  // container health check) use it to skip a service another instance is restarting.
  async isServiceLocked(serviceId: string, staleMs: number): Promise<boolean> {
    const current = await getOrNull<LockDoc>(await this.client(), LOCKS_INDEX, serviceId)
    return !!current && current.source.acquiredAt > Date.now() - staleMs
  }
}

function environmentFilter(environments?: string[]): estypes.QueryDslQueryContainer[] {
  return environments && environments.length > 0
    ? [{ terms: { environment: environments } }]
    : []
}
