import { typesenseSchemas, TypesenseSchema } from './TypesenseSchemas.js'
import {
  C2DStatusNumber,
  C2DStatusText,
  ComputeEnvironment,
  type DBComputeJob
} from '../../@types/C2D/C2D.js'
import sqlite3, { RunResult } from 'sqlite3'
import { DATABASE_LOGGER } from '../../utils/logging/common.js'

interface ComputeDatabaseProvider {
  newJob(job: DBComputeJob): Promise<string>
  getJob(jobId?: string, agreementId?: string, owner?: string): Promise<DBComputeJob[]>
  updateJob(job: DBComputeJob): Promise<number>
  getRunningJobs(engine?: string, environment?: string): Promise<DBComputeJob[]>
  deleteJob(jobId: string): Promise<boolean>
  getFinishedJobs(): Promise<DBComputeJob[]>
  getAllJobs(fromTimestamp?: string): Promise<DBComputeJob[]>
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
    terminationDetails: job.terminationDetails
  }
  return internalBlob
}
export function generateBlobFromJSON(job: DBComputeJob): Buffer {
  return Buffer.from(JSON.stringify(getInternalStructure(job)))
}

export function generateJSONFromBlob(blob: any): Promise<any> {
  return JSON.parse(blob.toString())
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
  private db: sqlite3.Database
  private schema: TypesenseSchema

  constructor(dbFilePath: string) {
    this.db = new sqlite3.Database(dbFilePath)
    this.schema = typesenseSchemas.c2dSchemas
  }

  deleteJob(jobId: string): Promise<boolean> {
    const deleteSQL = `
      DELETE FROM ${this.schema.name} WHERE jobId = ?
    `
    return new Promise<boolean>((resolve, reject) => {
      this.db.run(deleteSQL, [jobId], function (this: RunResult, err) {
        if (err) reject(err)
        else resolve(this.changes === 1)
      })
    })
  }

  createTable() {
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
    return new Promise<void>((resolve, reject) => {
      this.db.run(createTableSQL, (err) => {
        if (err) reject(err)
        else resolve()
      })
    })
  }

  newJob(job: DBComputeJob): Promise<string> {
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

    return new Promise<string>((resolve, reject) => {
      this.db.run(
        insertSQL,
        [
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
        ],
        (err) => {
          if (err) {
            DATABASE_LOGGER.error('Could not insert C2D job on DB: ' + err.message)
            reject(err)
          } else {
            DATABASE_LOGGER.info('Successfully inserted job with id:' + job.jobId)
            resolve(job.jobId)
          }
        }
      )
    })
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
  getJob(jobId?: string, agreementId?: string, owner?: string): Promise<DBComputeJob[]> {
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

    return new Promise<DBComputeJob[]>((resolve, reject) => {
      this.db.all(selectSQL, params, (err, rows: any[] | undefined) => {
        if (err) {
          DATABASE_LOGGER.error(err.message)
          reject(err)
        } else {
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
            resolve(all)
          } else {
            DATABASE_LOGGER.error(
              `Could not find any job with jobId: ${jobId}, agreementId: ${agreementId}, or owner: ${owner} in database!`
            )
            resolve([])
          }
        }
      })
    })
  }

  updateJob(job: DBComputeJob): Promise<number> {
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

    return new Promise((resolve, reject) => {
      this.db.run(updateSQL, data, function (this: RunResult, err: Error | null) {
        if (err) {
          DATABASE_LOGGER.error(`Error while updating job: ${err.message}`)
          reject(err)
        } else {
          // number of rows updated successfully
          resolve(this.changes)
        }
      })
    })
  }

  getRunningJobs(engine?: string, environment?: string): Promise<DBComputeJob[]> {
    const selectSQL = `
      SELECT * FROM ${this.schema.name} WHERE dateFinished IS NULL
    `
    return new Promise<DBComputeJob[]>((resolve, reject) => {
      this.db.all(selectSQL, (err, rows: any[] | undefined) => {
        if (err) {
          DATABASE_LOGGER.error(err.message)
          reject(err)
        } else {
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
            resolve(filtered)
          } else {
            DATABASE_LOGGER.info('Could not find any running C2D jobs!')
            resolve([])
          }
        }
      })
    })
  }

  getAllFinishedJobs(): Promise<DBComputeJob[]> {
    const selectSQL = `
      SELECT * FROM ${this.schema.name} WHERE dateFinished IS NOT NULL OR results IS NOT NULL
    `

    return new Promise<DBComputeJob[]>((resolve, reject) => {
      this.db.all(selectSQL, (err, rows: any[] | undefined) => {
        if (err) {
          DATABASE_LOGGER.error(err.message)
          reject(err)
        } else {
          if (rows && rows.length > 0) {
            const all: DBComputeJob[] = rows.map((row) => {
              const body = generateJSONFromBlob(row.body)
              delete row.body
              const maxJobDuration = row.expireTimestamp
              delete row.expireTimestamp
              const job: DBComputeJob = { ...row, ...body, maxJobDuration }
              return job
            })
            resolve(all)
          } else {
            DATABASE_LOGGER.info('Could not find any running C2D jobs!')
            resolve([])
          }
        }
      })
    })
  }

  getFinishedJobs(environment?: ComputeEnvironment): Promise<DBComputeJob[]> {
    // get jobs that already finished (have results), for this environment, and clear storage + job if expired
    let selectSQL = `
    SELECT * FROM ${this.schema.name} WHERE (dateFinished IS NOT NULL OR results IS NOT NULL)
  `
    const params: string[] = []
    if (environment) {
      selectSQL += 'AND environment = ?'
      params.push(environment.id)
    }

    return new Promise<DBComputeJob[]>((resolve, reject) => {
      this.db.all(selectSQL, params, (err, rows: any[] | undefined) => {
        if (err) {
          DATABASE_LOGGER.error(err.message)
          reject(err)
        } else {
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
            resolve(all)
          } else {
            environment
              ? DATABASE_LOGGER.info(
                  'No jobs found for the specified enviroment: ' +
                    environment?.id
                )
              : DATABASE_LOGGER.info('No jobs found')
            resolve([])
          }
        }
      })
    })
  }

  getAllJobs(fromTimestamp?: string): Promise<DBComputeJob[]> {
    let selectSQL = `SELECT * from ${this.schema.name}`

    if (fromTimestamp) {
      selectSQL += ` WHERE dateCreated >= ?`
    }

    selectSQL += ` ORDER BY dateCreated DESC`

    return new Promise<DBComputeJob[]>((resolve, reject) => {
      this.db.all(selectSQL, fromTimestamp, (err, rows: any[] | undefined) => {
        if (err) {
          DATABASE_LOGGER.error(err.message)
          reject(err)
        } else {
          if (rows && rows.length > 0) {
            const all: DBComputeJob[] = rows.map((row) => {
              const body = generateJSONFromBlob(row.body)
              delete row.body
              const maxJobDuration = row.expireTimestamp
              delete row.expireTimestamp
              const job: DBComputeJob = { ...row, ...body, maxJobDuration }
              return job
            })

            resolve(all)
          } else {
            DATABASE_LOGGER.info('No jobs found')
            resolve([])
          }
        }
      })
    })
  }
}
