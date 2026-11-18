import { expect } from 'chai'
import type { SqlClient } from '../../../components/database/sql/SqlClient.js'
import { SQL_DB_CONFIG, makeSqlClient } from '../../utils/sqlClient.js'
import { baseSnapshot } from '../../utils/utils.js'
import { SqlNonceDatabase } from '../../../components/database/sql/SqlNonce.js'
import { SqlConfigDatabase } from '../../../components/database/sql/SqlConfig.js'
import { SqlAuthToken } from '../../../components/database/sql/SqlAuthToken.js'
import { AuthTokenDatabase } from '../../../components/database/AuthTokenDatabase.js'
import { SqlBucketRegistry } from '../../../components/database/sql/SqlBucketRegistry.js'
import { SqlNodeMetrics } from '../../../components/database/sql/SqlNodeMetrics.js'
import { SqlCompute } from '../../../components/database/sql/SqlCompute.js'
import { HOUR_MS } from '../../../components/database/nodeMetricsAggregate.js'
import {
  C2DStatusNumber,
  C2DStatusText,
  type DBComputeJob
} from '../../../@types/C2D/C2D.js'
import {
  ServiceStatusNumber,
  type ServiceJob
} from '../../../@types/C2D/ServiceOnDemand.js'

// The contract of the state stores on a SQL database. Each test gets a new, empty database.

const OWNER = '0xe2DD09d719Da89e5a3D0F2549c7E24566e947260'
const OTHER_OWNER = '0x0000000000000000000000000000000000000001'

describe('SQL nonce store', () => {
  let db: SqlClient
  let nonces: SqlNonceDatabase

  beforeEach(async () => {
    db = await makeSqlClient()
    nonces = new SqlNonceDatabase(SQL_DB_CONFIG, db)
    await nonces.init()
  })
  afterEach(() => db.close())

  it('creates a nonce and reads it back under the checksummed address', async () => {
    await nonces.create(OWNER.toLowerCase(), 5)
    expect(await nonces.retrieve(OWNER)).to.deep.equal({ id: OWNER, nonce: 5 })
  })

  it('returns a null nonce for an unknown address', async () => {
    expect(await nonces.retrieve(OWNER)).to.deep.equal({ id: OWNER, nonce: null })
  })

  it('reads the highest nonce of all casings of the address', async () => {
    await nonces.create(OWNER, 5)
    // a row from before the addresses were normalized
    await db.run('INSERT INTO nonce ("id", "nonce") VALUES (?, ?)', [
      OWNER.toLowerCase(),
      9
    ])
    expect((await nonces.retrieve(OWNER)).nonce).to.equal(9)
  })

  it('updates and deletes a nonce', async () => {
    await nonces.create(OWNER, 5)
    await nonces.update(OWNER, 6)
    expect(await nonces.delete(OWNER)).to.deep.equal({ id: OWNER, nonce: 6 })
    expect(await nonces.delete(OWNER)).to.deep.equal({ id: OWNER, nonce: null })
  })
})

describe('SQL config store', () => {
  let db: SqlClient
  let config: SqlConfigDatabase

  beforeEach(async () => {
    db = await makeSqlClient()
    config = new SqlConfigDatabase(db)
    await config.init()
  })
  afterEach(() => db.close())

  it('returns a null value for an absent key', async () => {
    expect(await config.retrieveValue('version')).to.deep.equal({ value: null })
  })

  it('creates a value and replaces it', async () => {
    expect(await config.createOrUpdateConfig('version', '1')).to.deep.equal({
      key: 'version',
      value: '1'
    })
    await config.createOrUpdateConfig('version', '2')
    expect(await config.retrieveValue('version')).to.deep.equal({ value: '2' })
  })
})

describe('SQL auth token store', () => {
  let db: SqlClient
  let tokens: SqlAuthToken
  const now = Date.now()

  beforeEach(async () => {
    db = await makeSqlClient()
    tokens = new SqlAuthToken(db)
    await tokens.init()
  })
  afterEach(() => db.close())

  it('validates a token and returns its fields as numbers and a boolean', async () => {
    await tokens.createToken('id-1', OWNER, now, now + HOUR_MS, '8996')
    expect(await tokens.validateTokenEntry('id-1')).to.deep.equal({
      address: OWNER,
      createdAt: now,
      validUntil: now + HOUR_MS,
      isValid: true,
      chainId: '8996'
    })
  })

  it('keeps a chain id that comes as a number as its text', async () => {
    await tokens.createToken('id-1', OWNER, now, null, 8996 as any)
    expect((await tokens.validateTokenEntry('id-1')).chainId).to.equal('8996')
  })

  it('validates a token that has no end date', async () => {
    await tokens.createToken('id-1', OWNER, now, null)
    const entry = await tokens.validateTokenEntry('id-1')
    expect(entry.validUntil).to.equal(null)
    expect(entry.chainId).to.equal(null)
  })

  it('returns null for an unknown, an invalidated and an expired token', async () => {
    await tokens.createToken('invalidated', OWNER, now, null)
    await tokens.invalidateTokenEntry('invalidated')
    await tokens.createToken('expired', OWNER, now - 2 * HOUR_MS, now - HOUR_MS)
    expect(await tokens.validateTokenEntry('unknown')).to.equal(null)
    expect(await tokens.validateTokenEntry('invalidated')).to.equal(null)
    expect(await tokens.validateTokenEntry('expired')).to.equal(null)
  })

  it('takes the end of a token as a number or as a date, and refuses other values', async () => {
    const database = new AuthTokenDatabase(SQL_DB_CONFIG, tokens)
    const end = now + HOUR_MS
    await database.createToken('number', OWNER, end + 0.5, now)
    await database.createToken('text', OWNER, new Date(end).toISOString() as any, now)
    await database.createToken('past', OWNER, '2020-01-01T00:00:00Z' as any, now)
    expect((await database.validateToken('number')).validUntil).to.equal(end)
    expect((await database.validateToken('text')).validUntil).to.equal(end)
    expect(await database.validateToken('past')).to.equal(null)
    let error: Error
    await database.createToken('bad', OWNER, 'tomorrow' as any, now).catch((err) => {
      error = err
    })
    expect(error?.message).to.contain('validUntil')
  })

  it('deletes the expired and the invalidated tokens only', async () => {
    await tokens.createToken('valid', OWNER, now, now + HOUR_MS)
    await tokens.createToken('forever', OWNER, now, null)
    await tokens.createToken('expired', OWNER, now - 2 * HOUR_MS, now - HOUR_MS)
    await tokens.createToken('invalidated', OWNER, now, null)
    await tokens.invalidateTokenEntry('invalidated')
    expect(await tokens.deleteExpiredTokens(now)).to.equal(2)
    expect(await tokens.validateTokenEntry('valid')).to.not.equal(null)
    expect(await tokens.validateTokenEntry('forever')).to.not.equal(null)
  })
})

describe('SQL bucket registry', () => {
  let db: SqlClient
  let buckets: SqlBucketRegistry

  beforeEach(async () => {
    db = await makeSqlClient()
    buckets = new SqlBucketRegistry(db)
    await buckets.init()
  })
  afterEach(() => db.close())

  it('creates a bucket and reads it back', async () => {
    await buckets.upsertBucket('b1', OWNER, '[]', 100, null)
    expect(await buckets.getBucket('b1')).to.deep.equal({
      bucketId: 'b1',
      owner: OWNER,
      accessListJson: '[]',
      createdAt: 100,
      label: null
    })
    expect(await buckets.getBucket('none')).to.equal(null)
  })

  it('a second create changes the access list only', async () => {
    await buckets.upsertBucket('b1', OWNER, '[]', 100, 'first')
    await buckets.upsertBucket('b1', OTHER_OWNER, '[{"8996":["0x1"]}]', 200, 'second')
    expect(await buckets.getBucket('b1')).to.deep.equal({
      bucketId: 'b1',
      owner: OWNER,
      accessListJson: '[{"8996":["0x1"]}]',
      createdAt: 100,
      label: 'first'
    })
  })

  it('lists the buckets of an owner, oldest first', async () => {
    await buckets.upsertBucket('new', OWNER, '[]', 200, null)
    await buckets.upsertBucket('old', OWNER, '[]', 100, null)
    await buckets.upsertBucket('other', OTHER_OWNER, '[]', 150, null)
    const ids = (await buckets.listBucketsByOwner(OWNER)).map((b) => b.bucketId)
    expect(ids).to.deep.equal(['old', 'new'])
  })

  it('changes the label for the owner only, and deletes a bucket', async () => {
    await buckets.upsertBucket('b1', OWNER, '[]', 100, null)
    expect(await buckets.updateBucketLabel('b1', OTHER_OWNER, 'x')).to.equal(false)
    expect(await buckets.updateBucketLabel('b1', OWNER, 'mine')).to.equal(true)
    expect((await buckets.getBucket('b1')).label).to.equal('mine')
    expect(await buckets.deleteBucket('b1')).to.equal(true)
    expect(await buckets.deleteBucket('b1')).to.equal(false)
  })
})

describe('SQL node metrics store', () => {
  let db: SqlClient
  let metrics: SqlNodeMetrics
  const HOUR = 500 * HOUR_MS

  const snapshot = (collectedAt: number, usagePercent: number) =>
    baseSnapshot({ collectedAt, cpu: { ...baseSnapshot().cpu, usagePercent } })

  beforeEach(async () => {
    db = await makeSqlClient()
    metrics = new SqlNodeMetrics(db)
    await metrics.init()
    await metrics.insertSample('a', snapshot(HOUR + 1000, 10))
    await metrics.insertSample('a', snapshot(HOUR + 2000, 30))
    await metrics.insertSample('b', snapshot(HOUR + 3000, 50))
  })
  afterEach(() => db.close())

  it('lists the hours that have samples before a given hour', async () => {
    expect(await metrics.getPendingSampleHours('a', HOUR + HOUR_MS)).to.deep.equal([HOUR])
    expect(await metrics.getPendingSampleHours('a', HOUR)).to.deep.equal([])
  })

  it('gives the average of an hour that is not rolled up, marked partial', async () => {
    const partial = await metrics.getPartialHour('a', HOUR)
    expect(partial.partial).to.equal(true)
    expect(partial.sampleCount).to.equal(2)
    expect(partial.cpu.usagePercent).to.equal(20)
    expect(await metrics.getPartialHour('a', HOUR + HOUR_MS)).to.equal(null)
  })

  it('rolls an hour up into one hourly row and removes its samples', async () => {
    expect(await metrics.rollupHour('a', HOUR)).to.equal(true)
    expect(await metrics.rollupHour('a', HOUR)).to.equal(false)
    const hourly = await metrics.getHourly('a', HOUR, HOUR, 10)
    expect(hourly).to.have.length(1)
    expect(hourly[0].hourStart).to.equal(HOUR)
    expect(hourly[0].sampleCount).to.equal(2)
    expect(hourly[0].cpu.usagePercent).to.equal(20)
    // the samples and the hourly rows of another instance stay apart
    expect((await metrics.getPartialHour('b', HOUR)).sampleCount).to.equal(1)
    expect(await metrics.getHourly('b', HOUR, HOUR, 10)).to.deep.equal([])
  })

  it('a second roll-up of the same hour replaces the hourly row', async () => {
    await metrics.rollupHour('a', HOUR)
    await metrics.insertSample('a', snapshot(HOUR + 4000, 70))
    await metrics.rollupHour('a', HOUR)
    const hourly = await metrics.getHourly('a', HOUR, HOUR, 10)
    expect(hourly).to.have.length(1)
    expect(hourly[0].cpu.usagePercent).to.equal(70)
  })

  it('a roll-up counts the samples that it deletes, also when samples come at that time', async () => {
    const late = Array.from({ length: 10 }, (_, i) =>
      metrics.insertSample('a', snapshot(HOUR + 5000 + i, 10))
    )
    await Promise.all([metrics.rollupHour('a', HOUR), ...late])
    const [hourly] = await metrics.getHourly('a', HOUR, HOUR, 10)
    const left = (await metrics.getPartialHour('a', HOUR))?.sampleCount ?? 0
    // the two samples of the setup and the ten late ones: counted or still there
    expect(hourly.sampleCount + left).to.equal(12)
  })

  it('one of the roll-ups of an hour that run at the same time does the work', async () => {
    const done = await Promise.all(
      Array.from({ length: 6 }, () => metrics.rollupHour('a', HOUR))
    )
    expect(done.filter(Boolean)).to.have.length(1)
    expect((await metrics.getHourly('a', HOUR, HOUR, 10))[0].sampleCount).to.equal(2)
  })

  it('purges old samples and old hourly rows of one instance', async () => {
    await metrics.rollupHour('b', HOUR)
    expect(await metrics.purgeOldSamples('a', HOUR + 1500)).to.equal(1)
    expect(await metrics.purgeOldSamples('a', HOUR + HOUR_MS)).to.equal(1)
    expect(await metrics.deleteHourlyOlderThan('a', HOUR + HOUR_MS)).to.equal(0)
    expect(await metrics.deleteHourlyOlderThan('b', HOUR + HOUR_MS)).to.equal(1)
  })
})

describe('SQL compute store', () => {
  let db: SqlClient
  let compute: SqlCompute

  const job = (overrides: Partial<DBComputeJob>): DBComputeJob =>
    ({
      owner: OWNER,
      did: null,
      jobId: 'job-1',
      dateCreated: '1785760000.5',
      dateFinished: null,
      status: C2DStatusNumber.RunningAlgorithm,
      statusText: C2DStatusText.RunningAlgorithm,
      inputDID: ['did:op:1', 'did:op:2'],
      algoDID: 'did:op:algo',
      agreementId: '0xagreement',
      maxJobDuration: 3600,
      environment: 'env-1',
      clusterHash: 'cluster-1',
      algorithm: { documentId: 'did:op:algo', serviceId: '0xabc' },
      assets: [{ documentId: 'did:op:1', serviceId: '0xdef' }],
      resources: [{ id: 'cpu', amount: 2 }],
      isFree: false,
      ...overrides
    }) as unknown as DBComputeJob

  const service = (overrides: Partial<ServiceJob>): ServiceJob =>
    ({
      serviceId: 'svc-1',
      owner: OWNER,
      clusterHash: 'cluster-1',
      status: ServiceStatusNumber.Running,
      expiresAt: Date.now() + HOUR_MS,
      dateCreated: '2026-11-16T10:00:00.000Z',
      containerId: 'container-1',
      outputArchives: [],
      ...overrides
    }) as unknown as ServiceJob

  const expected = (job: ServiceJob) => ({
    owner: job.owner,
    clusterHash: job.clusterHash,
    status: job.status,
    containerId: job.containerId
  })

  const ids = (jobs: DBComputeJob[]) => jobs.map((j) => j.jobId)
  const serviceIds = (jobs: ServiceJob[]) => jobs.map((j) => j.serviceId).sort()

  beforeEach(async () => {
    db = await makeSqlClient()
    compute = new SqlCompute(db)
    await compute.init()
  })
  afterEach(() => db.close())

  describe('jobs', () => {
    it('creates a job and reads all its fields back', async () => {
      expect(await compute.newJob(job({}))).to.equal('job-1')
      const [read] = await compute.getJob('job-1')
      expect(read.owner).to.equal(OWNER)
      expect(read.dateCreated).to.equal('1785760000.5')
      expect(read.dateFinished).to.equal(null)
      expect(read.status).to.equal(C2DStatusNumber.RunningAlgorithm)
      expect(read.inputDID).to.deep.equal(['did:op:1', 'did:op:2'])
      expect(read.maxJobDuration).to.equal(3600)
      expect(read.clusterHash).to.equal('cluster-1')
      expect(read.resources).to.deep.equal([{ id: 'cpu', amount: 2 }])
      expect(read.jobIdHash).to.be.a('string')
      expect(read).to.not.have.property('body')
      expect(read).to.not.have.property('expireTimestamp')
    })

    it('finds a job by agreement id with and without 0x, and by owner in any case', async () => {
      await compute.newJob(job({}))
      expect(ids(await compute.getJob(undefined, 'agreement'))).to.deep.equal(['job-1'])
      expect(ids(await compute.getJob(undefined, '0xagreement'))).to.deep.equal(['job-1'])
      expect(
        ids(await compute.getJob(undefined, undefined, OWNER.toLowerCase()))
      ).to.deep.equal(['job-1'])
      expect(await compute.getJob('job-1', undefined, OTHER_OWNER)).to.deep.equal([])
      expect(await compute.getJob('none')).to.deep.equal([])
    })

    it('updates a job and returns the number of updated jobs', async () => {
      await compute.newJob(job({}))
      const finished = job({
        status: C2DStatusNumber.JobFinished,
        statusText: C2DStatusText.JobFinished,
        dateFinished: '1785760100',
        isRunning: false
      })
      expect(await compute.updateJob(finished)).to.equal(1)
      const [read] = await compute.getJob('job-1')
      expect(read.status).to.equal(C2DStatusNumber.JobFinished)
      expect(read.dateFinished).to.equal('1785760100')
      expect(await compute.updateJob(job({ jobId: 'none' }))).to.equal(0)
    })

    it('lists the running jobs, oldest first, by engine and environment', async () => {
      await compute.newJob(job({ jobId: 'new', dateCreated: '1785760002' }))
      await compute.newJob(job({ jobId: 'old', dateCreated: '999999999.5' }))
      await compute.newJob(job({ jobId: 'other-env', environment: 'env-2' }))
      await compute.newJob(job({ jobId: 'done' }))
      await compute.updateJob(job({ jobId: 'done', dateFinished: '1785760100' }))
      expect(ids(await compute.getRunningJobs('cluster-1', 'env-1'))).to.deep.equal([
        'old',
        'new'
      ])
      expect(await compute.getRunningJobs('cluster-2')).to.deep.equal([])
      expect(ids(await compute.getFinishedJobs(['env-1']))).to.deep.equal(['done'])
      expect(await compute.getFinishedJobs(['env-2'])).to.deep.equal([])
    })

    it('filters the job list by time as a number, by owner, status and environment', async () => {
      const finished = (jobId: string, dateFinished: string, owner = OWNER) =>
        compute
          .newJob(job({ jobId, owner, dateCreated: dateFinished }))
          .then(() =>
            compute.updateJob(
              job({ jobId, owner, dateFinished, status: C2DStatusNumber.JobFinished })
            )
          )
      // as text, '999999999.5' is above '1785760660'; as a number it is below
      await finished('nine-digit', '999999999.5')
      await finished('after', '1785760660.961')
      await finished('other-owner', '1785760700', OTHER_OWNER)
      await compute.newJob(job({ jobId: 'running', dateCreated: '1785760800' }))

      expect(ids(await compute.getJobs(undefined, 1785760660))).to.deep.equal([
        'other-owner',
        'after'
      ])
      expect(
        ids(await compute.getJobs(undefined, undefined, [OWNER.toLowerCase()]))
      ).to.deep.equal(['running', 'after', 'nine-digit'])
      expect(
        ids(
          await compute.getJobs(
            undefined,
            undefined,
            undefined,
            C2DStatusNumber.JobStarted
          )
        )
      ).to.deep.equal([])
      expect(
        ids(await compute.getJobs(['env-1'], 1785760000, undefined, undefined, true))
      ).to.deep.equal(['running'])
      expect(
        ids(await compute.getJobsByStatus(['env-1'], [C2DStatusNumber.RunningAlgorithm]))
      ).to.deep.equal(['running'])
    })

    it('refuses a date that is not a number: SQL compares the dates as numbers', async () => {
      let error: Error
      await compute.newJob(job({ dateCreated: 'yesterday' })).catch((err) => {
        error = err
      })
      expect(error?.message).to.contain('Unix seconds')
      await compute.newJob(job({ dateCreated: '' }))
      expect(Number((await compute.getJob('job-1'))[0].dateCreated)).to.be.closeTo(
        Date.now() / 1000,
        60
      )
    })

    it('deletes a job', async () => {
      await compute.newJob(job({}))
      expect(await compute.deleteJob('job-1')).to.equal(true)
      expect(await compute.deleteJob('job-1')).to.equal(false)
    })
  })

  describe('images', () => {
    it('records the use of an image and lists the images that are not used for some days', async () => {
      await compute.updateImage('image:1')
      await compute.updateImage('image:1')
      expect(await compute.getOldImages(7)).to.deep.equal([])
      // a negative retention puts the limit in the future
      expect(await compute.getOldImages(-1)).to.deep.equal(['image:1'])
      await compute.deleteImage('image:1')
      expect(await compute.getOldImages(-1)).to.deep.equal([])
    })
  })

  describe('service jobs', () => {
    it('creates a service job and finds it by id and by owner in any case', async () => {
      await compute.newServiceJob(service({}))
      const [read] = await compute.getServiceJob('svc-1')
      expect(read.serviceId).to.equal('svc-1')
      expect(read.containerId).to.equal('container-1')
      expect(
        serviceIds(await compute.getServiceJob(undefined, OWNER.toLowerCase()))
      ).to.deep.equal(['svc-1'])
      expect(await compute.getServiceJob('svc-1', OTHER_OWNER)).to.deep.equal([])
    })

    it('updates a service job and returns the number of updated jobs', async () => {
      await compute.newServiceJob(service({}))
      const stopped = service({ status: ServiceStatusNumber.Stopped })
      expect(await compute.updateServiceJob(stopped)).to.equal(1)
      expect((await compute.getServiceJob('svc-1'))[0].status).to.equal(
        ServiceStatusNumber.Stopped
      )
      expect(await compute.updateServiceJob(service({ serviceId: 'none' }))).to.equal(0)
    })

    it('adds metrics and readiness only when the job did not change', async () => {
      const running = service({})
      await compute.newServiceJob(running)
      const metrics: any = { cpuPercent: 12 }
      const readiness: any = { ready: true }
      expect(
        await compute.updateServiceJobMetrics('svc-1', expected(running), metrics)
      ).to.equal(true)
      expect(
        await compute.updateServiceJobReadiness('svc-1', expected(running), readiness)
      ).to.equal(true)
      const [read] = await compute.getServiceJob('svc-1')
      expect(read.runtimeMetrics).to.deep.equal(metrics)
      expect(read.readiness).to.deep.equal(readiness)

      await compute.updateServiceJob(service({ status: ServiceStatusNumber.Stopping }))
      expect(
        await compute.updateServiceJobMetrics('svc-1', expected(running), metrics)
      ).to.equal(false)
      expect(
        await compute.updateServiceJobMetrics('none', expected(running), metrics)
      ).to.equal(false)
    })

    it('lists the service jobs that hold a reservation', async () => {
      await compute.newServiceJob(service({ serviceId: 'running' }))
      await compute.newServiceJob(
        service({ serviceId: 'error-unpaid', status: ServiceStatusNumber.Error })
      )
      await compute.newServiceJob(
        service({
          serviceId: 'error-paid',
          status: ServiceStatusNumber.Error,
          payment: { claimTx: '0xclaim' } as any
        })
      )
      await compute.newServiceJob(
        service({ serviceId: 'expired', status: ServiceStatusNumber.Expired })
      )
      await compute.newServiceJob(
        service({ serviceId: 'other-cluster', clusterHash: 'cluster-2' })
      )
      expect(serviceIds(await compute.getRunningServiceJobs('cluster-1'))).to.deep.equal([
        'error-paid',
        'running'
      ])
      expect(serviceIds(await compute.getRunningServiceJobs())).to.deep.equal([
        'error-paid',
        'other-cluster',
        'running'
      ])
    })

    it('lists the service jobs to expire, to clean, and to start', async () => {
      const past = Date.now() - HOUR_MS
      await compute.newServiceJob(service({ serviceId: 'running-late', expiresAt: past }))
      await compute.newServiceJob(service({ serviceId: 'running-in-time' }))
      await compute.newServiceJob(
        service({
          serviceId: 'expired-with-archive',
          status: ServiceStatusNumber.Expired,
          expiresAt: past,
          outputArchives: [{ id: 'a' }] as any
        })
      )
      await compute.newServiceJob(
        service({
          serviceId: 'expired-clean',
          status: ServiceStatusNumber.Expired,
          expiresAt: past
        })
      )
      await compute.newServiceJob(
        service({ serviceId: 'starting', status: ServiceStatusNumber.Starting })
      )
      expect(serviceIds(await compute.getExpiredServiceJobs())).to.deep.equal([
        'running-late'
      ])
      expect(await compute.getExpiredServiceJobs('cluster-2')).to.deep.equal([])
      expect(
        serviceIds(await compute.getExpiredServiceJobsBefore(Date.now()))
      ).to.deep.equal(['expired-with-archive'])
      expect(await compute.getExpiredServiceJobsBefore(past - HOUR_MS)).to.deep.equal([])
      expect(serviceIds(await compute.getPendingServiceStarts())).to.deep.equal([
        'starting'
      ])
    })

    it('an update that removes the archives removes the job from the clean list', async () => {
      const past = Date.now() - HOUR_MS
      const expired = service({
        status: ServiceStatusNumber.Expired,
        expiresAt: past,
        outputArchives: [{ id: 'a' }] as any
      })
      await compute.newServiceJob(expired)
      await compute.updateServiceJob({ ...expired, outputArchives: [] })
      expect(await compute.getExpiredServiceJobsBefore(Date.now())).to.deep.equal([])
    })
  })

  describe('service locks', () => {
    const STALE_MS = 60_000

    it('gives the lock to one holder only', async () => {
      expect(await compute.acquireServiceLock('svc-1', 'a', STALE_MS)).to.equal(true)
      expect(await compute.acquireServiceLock('svc-1', 'b', STALE_MS)).to.equal(false)
      expect(await compute.isServiceLocked('svc-1', STALE_MS)).to.equal(true)
      expect(await compute.isServiceLocked('svc-2', STALE_MS)).to.equal(false)
    })

    it('gives the lock to one of the holders that ask at the same time', async () => {
      const holders = Array.from({ length: 10 }, (_, i) => `holder-${i}`)
      const results = await Promise.all(
        holders.map((holder) => compute.acquireServiceLock('svc-1', holder, STALE_MS))
      )
      expect(results.filter(Boolean)).to.have.length(1)
    })

    it('releases the lock of its holder only', async () => {
      await compute.acquireServiceLock('svc-1', 'a', STALE_MS)
      await compute.releaseServiceLock('svc-1', 'b')
      expect(await compute.isServiceLocked('svc-1', STALE_MS)).to.equal(true)
      await compute.releaseServiceLock('svc-1', 'a')
      expect(await compute.acquireServiceLock('svc-1', 'b', STALE_MS)).to.equal(true)
    })

    it('gives a stale lock to a new holder, and a refresh keeps a lock fresh', async () => {
      await compute.acquireServiceLock('svc-1', 'a', STALE_MS)
      await db.run('UPDATE service_locks SET "acquiredAt" = ?', [
        Date.now() - 2 * STALE_MS
      ])
      expect(await compute.isServiceLocked('svc-1', STALE_MS)).to.equal(false)
      await compute.refreshServiceLocks('a')
      expect(await compute.acquireServiceLock('svc-1', 'b', STALE_MS)).to.equal(false)
      await db.run('UPDATE service_locks SET "acquiredAt" = ?', [
        Date.now() - 2 * STALE_MS
      ])
      expect(await compute.acquireServiceLock('svc-1', 'b', STALE_MS)).to.equal(true)
    })
  })
})
