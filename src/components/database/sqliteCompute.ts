import { typesenseSchemas, TypesenseSchema } from './TypesenseSchemas.js'
import {
  C2DStatusNumber,
  C2DStatusText,
  type DBComputeJob
} from '../../@types/C2D/C2D.js'
import { ServiceStatusNumber, type ServiceJob } from '../../@types/C2D/ServiceOnDemand.js'
import { SqliteClient } from './sqliteClient.js'
import { DATABASE_LOGGER } from '../../utils/logging/common.js'
import { create256Hash } from '../../utils/crypt.js'

interface ComputeDatabaseProvider {
  newJob(job: DBComputeJob): Promise<string>
  getJob(jobId?: string, agreementId?: string, owner?: string): Promise<DBComputeJob[]>
  updateJob(job: DBComputeJob): Promise<number>
  getRunningJobs(engine?: string, environment?: string): Promise<DBComputeJob[]>
  deleteJob(jobId: string): Promise<boolean>
  getFinishedJobs(environments?: string[]): Promise<DBComputeJob[]>
  getJobs(
    environments?: string[],
    fromTimestamp?: string,
    consumerAddrs?: string[]
  ): Promise<DBComputeJob[]>
  updateImage(image: string): Promise<void>
  getOldImages(retentionDays: number): Promise<string[]>
}

function getInternalStructure(job: DBComputeJob): any {
  const internalBlob = {
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
    buildStopTimestamp: job.buildStopTimestamp
  }
  return internalBlob
}
export function generateBlobFromJSON(job: DBComputeJob): Buffer {
  return Buffer.from(JSON.stringify(getInternalStructure(job)))
}

export function generateJSONFromBlob(blob: any): Promise<any> {
  // node:sqlite returns BLOB columns as Uint8Array (the old sqlite3 addon returned Buffer).
  // Buffer.from() handles both, so decode through it before parsing.
  return JSON.parse(Buffer.from(blob).toString())
}

// we cannot store array of strings, so we use string separators instead
export const STRING_SEPARATOR = '__,__'

export function convertArrayToString(array: string[]) {
  let str: string = ''
  for (let i = 0; i < array.length; i++) {
    str = str + array[i]
    // Do not append comma at the end of last element
    if (i < array.length - 1) {
      str = str + STRING_SEPARATOR
    }
  }
  return str
}
export function convertStringToArray(str: string) {
  const arr: string[] = str.split(STRING_SEPARATOR)
  return arr
}

export class SQLiteCompute implements ComputeDatabaseProvider {
  private db: SqliteClient
  private schema: TypesenseSchema

  constructor(dbFilePath: string) {
    this.db = new SqliteClient(dbFilePath)
    this.schema = typesenseSchemas.c2dSchemas
  }

  // eslint-disable-next-line require-await
  async deleteJob(jobId: string): Promise<boolean> {
    const deleteSQL = `
      DELETE FROM ${this.schema.name} WHERE jobId = ?
    `
    const { changes } = this.db.run(deleteSQL, [jobId])
    return changes === 1
  }

  // eslint-disable-next-line require-await
  async createTable() {
    /* although we have field called expiteTimestamp, we are actually storing maxJobDuration in it */
    const createTableSQL = `
      CREATE TABLE IF NOT EXISTS ${this.schema.name} (
        owner TEXT,
        did TEXT DEFAULT NULL,
        jobId TEXT PRIMARY KEY,
        dateCreated TEXT,
        dateFinished TEXT DEFAULT NULL,
        status INTEGER,
        statusText TEXT,
        results BLOB,
        inputDID TEXT DEFAULT NULL,
        algoDID TEXT DEFAULT NULL,
        agreementId TEXT DEFAULT NULL,
        expireTimestamp INTEGER,
        environment TEXT DEFAULT NULL,
        body BLOB
      );
    `
    this.db.exec(createTableSQL)
  }

  // eslint-disable-next-line require-await
  async createImageTable(): Promise<void> {
    const createTableSQL = `
      CREATE TABLE IF NOT EXISTS docker_images (
        image TEXT PRIMARY KEY,
        lastUsedTimestamp INTEGER NOT NULL
      );
    `
    try {
      this.db.exec(createTableSQL)
    } catch (err) {
      DATABASE_LOGGER.error('Could not create docker_images table: ' + err.message)
      throw err
    }
  }

  // ── Service-on-Demand jobs ──────────────────────────────────────────

  // eslint-disable-next-line require-await
  async createServiceTable(): Promise<void> {
    const createTableSQL = `
      CREATE TABLE IF NOT EXISTS service_jobs (
        serviceId TEXT PRIMARY KEY,
        owner TEXT,
        clusterHash TEXT,
        status INTEGER,
        expiresAt INTEGER,
        dateCreated TEXT,
        body BLOB
      );
    `
    try {
      this.db.exec(createTableSQL)
    } catch (err) {
      DATABASE_LOGGER.error('Could not create service_jobs table: ' + err.message)
      throw err
    }
  }

  // eslint-disable-next-line require-await
  async newServiceJob(job: ServiceJob): Promise<void> {
    const insertSQL = `
      INSERT INTO service_jobs
      (serviceId, owner, clusterHash, status, expiresAt, dateCreated, body)
      VALUES (?, ?, ?, ?, ?, ?, ?);
    `
    try {
      this.db.run(insertSQL, [
        job.serviceId,
        job.owner,
        job.clusterHash,
        job.status,
        job.expiresAt,
        job.dateCreated,
        Buffer.from(JSON.stringify(job))
      ])
    } catch (err) {
      DATABASE_LOGGER.error('Could not insert service job on DB: ' + err.message)
      throw err
    }
  }

  // eslint-disable-next-line require-await
  async updateServiceJob(job: ServiceJob): Promise<number> {
    const updateSQL = `
      UPDATE service_jobs
      SET owner = ?, clusterHash = ?, status = ?, expiresAt = ?, body = ?
      WHERE serviceId = ?;
    `
    try {
      const { changes } = this.db.run(updateSQL, [
        job.owner,
        job.clusterHash,
        job.status,
        job.expiresAt,
        Buffer.from(JSON.stringify(job)),
        job.serviceId
      ])
      return changes
    } catch (err) {
      DATABASE_LOGGER.error(`Error while updating service job: ${err.message}`)
      throw err
    }
  }

  private mapServiceRows(rows: any[] | undefined): ServiceJob[] {
    if (!rows || rows.length === 0) return []
    // BLOB comes back as Uint8Array from node:sqlite; decode through Buffer before parsing.
    return rows.map((row) => JSON.parse(Buffer.from(row.body).toString()) as ServiceJob)
  }

  // eslint-disable-next-line require-await
  async getServiceJob(serviceId?: string, owner?: string): Promise<ServiceJob[]> {
    const params: any[] = []
    let selectSQL = `SELECT * FROM service_jobs WHERE 1=1`
    if (serviceId) {
      selectSQL += ` AND serviceId = ?`
      params.push(serviceId)
    }
    if (owner) {
      selectSQL += ` AND owner = ?`
      params.push(owner)
    }
    try {
      const rows = this.db.all(selectSQL, params)
      return this.mapServiceRows(rows)
    } catch (err) {
      DATABASE_LOGGER.error(err.message)
      throw err
    }
  }

  // eslint-disable-next-line require-await
  async getRunningServiceJobs(clusterHash?: string): Promise<ServiceJob[]> {
    // All pre-terminal statuses are "active": a service reserves its resources from the moment
    // its record is created (Starting) through the whole start pipeline (Locking, image, Claiming)
    // until it is Running, and while Stopping. Error is included too: a service whose container
    // died on its own keeps its resources/ports reserved (consumer already paid for them) until
    // it is explicitly restarted/stopped, or swept by getExpiredServiceJobs once past expiresAt.
    const activeStatuses = [
      ServiceStatusNumber.Starting,
      ServiceStatusNumber.Locking,
      ServiceStatusNumber.PullImage,
      ServiceStatusNumber.BuildImage,
      ServiceStatusNumber.Claiming,
      ServiceStatusNumber.Running,
      ServiceStatusNumber.Stopping,
      ServiceStatusNumber.Error
    ]
    const placeholders = activeStatuses.map(() => '?').join(',')
    const params: Array<string | number> = [...activeStatuses]
    let selectSQL = `SELECT * FROM service_jobs WHERE status IN (${placeholders})`
    if (clusterHash) {
      selectSQL += ` AND clusterHash = ?`
      params.push(clusterHash)
    }
    try {
      const rows = this.db.all(selectSQL, params)
      return this.mapServiceRows(rows)
    } catch (err) {
      DATABASE_LOGGER.error(err.message)
      throw err
    }
  }

  // eslint-disable-next-line require-await
  async getExpiredServiceJobs(clusterHash?: string): Promise<ServiceJob[]> {
    // Running AND Error: an Error'd service (e.g. container died on its own) still holds its
    // resources/ports reserved for a possible restart, but once past expiresAt it must be
    // swept and released just like a normally-running one — otherwise an abandoned Error
    // service would leak its reservation forever.
    const expirableStatuses = [ServiceStatusNumber.Running, ServiceStatusNumber.Error]
    const placeholders = expirableStatuses.map(() => '?').join(',')
    const params: Array<string | number> = [...expirableStatuses, Date.now()]
    let selectSQL = `SELECT * FROM service_jobs WHERE status IN (${placeholders}) AND expiresAt <= ?`
    if (clusterHash) {
      selectSQL += ` AND clusterHash = ?`
      params.push(clusterHash)
    }
    try {
      const rows = this.db.all(selectSQL, params)
      return this.mapServiceRows(rows)
    } catch (err) {
      DATABASE_LOGGER.error(err.message)
      throw err
    }
  }

  // Service jobs that are mid-start and need the background loop to advance them.
  // Starting = fresh (handler just created it); the intermediate states are picked up too so
  // the loop can resume / orphan-recover them after a node restart.
  // eslint-disable-next-line require-await
  async getPendingServiceStarts(clusterHash?: string): Promise<ServiceJob[]> {
    const startStatuses = [
      ServiceStatusNumber.Starting,
      ServiceStatusNumber.Locking,
      ServiceStatusNumber.PullImage,
      ServiceStatusNumber.BuildImage,
      ServiceStatusNumber.Claiming
    ]
    const placeholders = startStatuses.map(() => '?').join(',')
    const params: Array<string | number> = [...startStatuses]
    let selectSQL = `SELECT * FROM service_jobs WHERE status IN (${placeholders})`
    if (clusterHash) {
      selectSQL += ` AND clusterHash = ?`
      params.push(clusterHash)
    }
    try {
      const rows = this.db.all(selectSQL, params)
      return this.mapServiceRows(rows)
    } catch (err) {
      DATABASE_LOGGER.error(err.message)
      throw err
    }
  }

  // eslint-disable-next-line require-await
  async updateImage(image: string): Promise<void> {
    const timestamp = Math.floor(Date.now() / 1000) // Unix timestamp in seconds
    const insertSQL = `
      INSERT OR REPLACE INTO docker_images (image, lastUsedTimestamp)
      VALUES (?, ?);
    `
    try {
      this.db.run(insertSQL, [image, timestamp])
      DATABASE_LOGGER.debug(`Updated image usage timestamp for ${image}`)
    } catch (err) {
      DATABASE_LOGGER.error(`Could not update image usage for ${image}: ${err.message}`)
      throw err
    }
  }

  // eslint-disable-next-line require-await
  async deleteImage(image: string): Promise<void> {
    const deleteSQL = `
      DELETE FROM docker_images WHERE image = ?;
    `
    try {
      this.db.run(deleteSQL, [image])
      DATABASE_LOGGER.debug(`Deleted image ${image}`)
    } catch (err) {
      DATABASE_LOGGER.error(`Could not delete image ${image}: ${err.message}`)
      throw err
    }
  }

  // eslint-disable-next-line require-await
  async getOldImages(retentionDays: number = 7): Promise<string[]> {
    const cutoffTimestamp = Math.floor(Date.now() / 1000) - retentionDays * 24 * 60 * 60
    const selectSQL = `
      SELECT image FROM docker_images
      WHERE lastUsedTimestamp < ?
      ORDER BY lastUsedTimestamp ASC;
    `
    try {
      const rows = this.db.all<{ image: string }>(selectSQL, [cutoffTimestamp])
      return rows.map((row) => row.image)
    } catch (err) {
      DATABASE_LOGGER.error(`Could not get old images: ${err.message}`)
      throw err
    }
  }

  // eslint-disable-next-line require-await
  async newJob(job: DBComputeJob): Promise<string> {
    // TO DO C2D
    const insertSQL = `
      INSERT INTO ${this.schema.name}
      (
      owner,
      did,
      jobId,
      dateCreated,
      status,
      statusText,
      inputDID,
      algoDID,
      agreementId,
      expireTimestamp,
      environment,
      body
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
    `

    try {
      this.db.run(insertSQL, [
        job.owner,
        job.did,
        job.jobId,
        job.dateCreated || String(Date.now() / 1000), // seconds from epoch,
        job.status || C2DStatusNumber.JobStarted,
        job.statusText || C2DStatusText.JobStarted,
        job.inputDID ? convertArrayToString(job.inputDID) : job.inputDID,
        job.algoDID,
        job.agreementId,
        job.maxJobDuration,
        job.environment,
        generateBlobFromJSON(job)
      ])
      DATABASE_LOGGER.info('Successfully inserted job with id:' + job.jobId)
      return job.jobId
    } catch (err) {
      DATABASE_LOGGER.error('Could not insert C2D job on DB: ' + err.message)
      throw err
    }
  }

  /**
   * on a get status for instance, all params are optional
   * but at least one is required... In case we don't have a jobId,
   * we have multiple results (by owner for instance)
   * So, it refines the query or we can have more than 1 result (same as current implementation)
   * @param jobId the job identifier
   * @param agreementId the agreement identifier (did ?)
   * @param owner the consumer address / job owner
   * @returns job(s)
   */
  // eslint-disable-next-line require-await
  async getJob(
    jobId?: string,
    agreementId?: string,
    owner?: string
  ): Promise<DBComputeJob[]> {
    const params: any = []
    let selectSQL = `SELECT * FROM ${this.schema.name} WHERE 1=1`
    if (jobId) {
      selectSQL += ` AND jobId = ?`
      params.push(jobId)
    }
    if (agreementId) {
      if (!agreementId.startsWith('0x')) {
        agreementId = '0x' + agreementId
      }
      selectSQL += ` AND agreementId = ?`
      params.push(agreementId)
    }
    if (owner) {
      selectSQL += ` AND owner = ?`
      params.push(owner)
    }

    let rows: any[]
    try {
      rows = this.db.all(selectSQL, params)
    } catch (err) {
      DATABASE_LOGGER.error(err.message)
      throw err
    }
    // also decode the internal data into job data
    if (rows && rows.length > 0) {
      const all: DBComputeJob[] = rows.map((row) => {
        const body = generateJSONFromBlob(row.body)
        delete row.body
        const maxJobDuration = row.expireTimestamp
        delete row.expireTimestamp
        const job: DBComputeJob = { ...row, ...body, maxJobDuration }
        return job
      })
      return all
    }
    DATABASE_LOGGER.error(
      `Could not find any job with jobId: ${jobId}, agreementId: ${agreementId}, or owner: ${owner} in database!`
    )
    return []
  }

  // eslint-disable-next-line require-await
  async updateJob(job: DBComputeJob): Promise<number> {
    // if (job.dateFinished && job.isRunning) {
    //  job.isRunning = false
    // }
    // TO DO C2D
    const data: any[] = [
      job.owner,
      job.status,
      job.statusText,
      job.maxJobDuration,
      generateBlobFromJSON(job),
      job.dateFinished,
      job.jobId
    ]
    const updateSQL = `
      UPDATE ${this.schema.name}
      SET
      owner = ?,
      status = ?,
      statusText = ?,
      expireTimestamp = ?,
      body = ?,
      dateFinished = ?
      WHERE jobId = ?;
    `

    try {
      // number of rows updated successfully
      const { changes } = this.db.run(updateSQL, data)
      return changes
    } catch (err) {
      DATABASE_LOGGER.error(`Error while updating job: ${err.message}`)
      throw err
    }
  }

  // eslint-disable-next-line require-await
  async getRunningJobs(engine?: string, environment?: string): Promise<DBComputeJob[]> {
    const selectSQL = `
      SELECT * FROM ${this.schema.name} WHERE dateFinished IS NULL ORDER by dateCreated
    `
    let rows: any[]
    try {
      rows = this.db.all(selectSQL)
    } catch (err) {
      DATABASE_LOGGER.error(err.message)
      throw err
    }
    // also decode the internal data into job data
    // get them all running
    if (rows && rows.length > 0) {
      const all: DBComputeJob[] = rows.map((row) => {
        const body = generateJSONFromBlob(row.body)
        delete row.body
        const maxJobDuration = row.expireTimestamp
        delete row.expireTimestamp
        const job: DBComputeJob = { ...row, ...body, maxJobDuration }
        return job
      })
      // filter them out
      const filtered = all.filter((job) => {
        let include = true
        if (engine && engine !== job.clusterHash) {
          include = false
        }
        if (environment && environment !== job.environment) {
          include = false
        }
        if (job.dateFinished) {
          include = false
        }
        return include
      })
      return filtered
    }
    // DATABASE_LOGGER.info('Could not find any running C2D jobs!')
    return []
  }

  // eslint-disable-next-line require-await
  async getFinishedJobs(environments?: string[]): Promise<DBComputeJob[]> {
    let selectSQL = `
    SELECT * FROM ${this.schema.name} WHERE (dateFinished IS NOT NULL OR results IS NOT NULL)
  `
    const params: string[] = []
    if (environments && environments.length > 0) {
      const placeholders = environments.map(() => '?').join(',')
      selectSQL += ` AND environment IN (${placeholders})`
      params.push(...environments)
    }

    selectSQL += ` ORDER BY dateFinished DESC`

    let rows: any[]
    try {
      rows = this.db.all(selectSQL, params)
    } catch (err) {
      DATABASE_LOGGER.error(err.message)
      throw err
    }
    // also decode the internal data into job data
    // get them all running
    if (rows && rows.length > 0) {
      const all: DBComputeJob[] = rows.map((row) => {
        const body = generateJSONFromBlob(row.body)
        delete row.body
        const maxJobDuration = row.expireTimestamp
        delete row.expireTimestamp
        const job: DBComputeJob = { ...row, ...body, maxJobDuration }
        return job
      })
      return all
    }
    environments
      ? DATABASE_LOGGER.info(
          'No jobs found for the specified enviroments: ' + environments.join(',')
        )
      : DATABASE_LOGGER.info('No jobs found')
    return []
  }

  async getJobs(
    environments?: string[],
    fromTimestamp?: string,
    consumerAddrs?: string[],
    status?: C2DStatusNumber,
    runningJobs?: boolean
  ): Promise<DBComputeJob[]> {
    let selectSQL = `SELECT * FROM ${this.schema.name}`

    const params: string[] = []
    const conditions: string[] = []

    if (environments && environments.length > 0) {
      const placeholders = environments.map(() => '?').join(',')
      conditions.push(`environment IN (${placeholders})`)
      params.push(...environments)
    }

    if (runningJobs) {
      conditions.push(`status = ?`)
      params.push(C2DStatusNumber.RunningAlgorithm.toString())
      if (fromTimestamp) {
        conditions.push(`dateCreated >= ?`)
        params.push(fromTimestamp)
      }
    } else {
      if (fromTimestamp) {
        conditions.push(`dateFinished >= ?`)
        params.push(fromTimestamp)
      }
      if (status) {
        conditions.push(`status = ?`)
        params.push(status.toString())
      }
    }

    if (consumerAddrs && consumerAddrs.length > 0) {
      const placeholders = consumerAddrs.map(() => '?').join(',')
      conditions.push(`owner IN (${placeholders})`)
      params.push(...consumerAddrs)
    }

    if (conditions.length > 0) {
      selectSQL += ` WHERE ${conditions.join(' AND ')}`
    }
    selectSQL += ` ORDER BY dateCreated DESC`
    return await this.doQuery(selectSQL, params, environments)
  }

  async getJobsByStatus(
    environments: string[],
    status: C2DStatusNumber[]
  ): Promise<DBComputeJob[]> {
    let selectSQL = `SELECT * FROM ${this.schema.name}`

    // node:sqlite bindings accept both strings and numbers; `status` is a numeric enum.
    const params: Array<string | number> = []
    const conditions: string[] = []

    if (environments && environments.length > 0) {
      const placeholders = environments.map(() => '?').join(',')
      conditions.push(`environment IN (${placeholders})`)
      params.push(...environments)
    }

    if (status && status.length > 0) {
      const placeholders = status.map(() => '?').join(',')
      conditions.push(`status IN (${placeholders})`)
      params.push(...status)
    }

    if (conditions.length > 0) {
      selectSQL += ` WHERE ${conditions.join(' AND ')}`
    }
    selectSQL += ` ORDER BY dateCreated DESC`

    return await this.doQuery(selectSQL, params, environments)
  }

  // eslint-disable-next-line require-await
  private async doQuery(
    selectSQL: string,
    params: Array<string | number>,
    environments: string[]
  ): Promise<DBComputeJob[]> {
    let rows: any[]
    try {
      rows = this.db.all(selectSQL, params)
    } catch (err) {
      DATABASE_LOGGER.error(err.message)
      throw err
    }
    // also decode the internal data into job data
    // get them all running
    if (rows && rows.length > 0) {
      const all: DBComputeJob[] = rows.map((row) => {
        const body = generateJSONFromBlob(row.body)
        delete row.body
        const maxJobDuration = row.expireTimestamp
        delete row.expireTimestamp
        const job: DBComputeJob = { ...row, ...body, maxJobDuration }
        if (!job.jobIdHash && job.jobId) {
          job.jobIdHash = create256Hash(job.jobId)
        }
        return job
      })
      return all
    }
    environments
      ? DATABASE_LOGGER.info(
          'No jobs found for the specified enviroments: ' + environments.join(',')
        )
      : DATABASE_LOGGER.info('No jobs found')
    return []
  }
}
