import { typesenseSchemas, TypesenseSchema } from './TypesenseSchemas.js'
import type { DBComputeJob } from '../../@types/C2D/C2D.js'
import sqlite3 from 'sqlite3'

interface ComputeDatabaseProvider {
  newJob(job: DBComputeJob): Promise<string>
  getJob(jobId: string): Promise<DBComputeJob | null>
  updateJob(job: DBComputeJob): void
  getRunningJobs(engine?: string, environment?: string): Promise<DBComputeJob[]>
  deleteJob(jobId: string): Promise<boolean>
}

/**
 * export interface ComputeJob {
  owner: string
  did?: string
  jobId: string
  dateCreated: string
  dateFinished: string
  status: number
  statusText: string
  results: ComputeResult[]
  inputDID?: string[]
  algoDID?: string
  agreementId?: string
  expireTimestamp: number
  environment?: string

  // internal structure
  clusterHash: string
  configlogURL: string
  publishlogURL: string
  algologURL: string
  outputsURL: string
  stopRequested: boolean
  algorithm: ComputeAlgorithm
  assets: ComputeAsset[]
  isRunning: boolean
  isStarted: boolean
  containerImage: string
}
 */

export function generateUniqueID(): string {
  return crypto.randomUUID().toString()
}

export function generateBlobFromJSON(obj: any): Buffer {
  return Buffer.from(JSON.stringify(obj))
}

export function generateJSONFromBlob(blob: any): Promise<any> {
  return JSON.parse(blob.toString())
}

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
      this.db.run(deleteSQL, [jobId], (err) => {
        if (err) reject(err)
        else resolve(true)
      })
    })
  }

  createTable() {
    const createTableSQL = `
      CREATE TABLE IF NOT EXISTS ${this.schema.name} (
        owner TEXT,
        did TEXT,
        jobId TEXT PRIMARY KEY,
        dateCreated TEXT,
        dateFinished TEXT,
        status INTEGER,
        statusText TEXT,
        results BLOB,
        inputDID TEXT,
        algoDID TEXT,
        agreementId TEXT,
        expireTimestamp INTEGER,
        environment TEXT,
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
    const jobId = generateUniqueID()
    job.jobId = jobId
    return new Promise<string>((resolve, reject) => {
      this.db.run(
        insertSQL,
        [
          job.owner,
          job.did,
          jobId,
          new Date().toISOString(),
          job.status || 1,
          job.statusText || 'Warming up',
          job.inputDID ? convertArrayToString(job.inputDID) : job.inputDID,
          job.algoDID,
          job.agreementId,
          job.expireTimestamp,
          job.environment,
          generateBlobFromJSON(job)
        ],
        (err) => {
          if (err) reject(err)
          else resolve(jobId)
        }
      )
    })
  }

  getJob(jobId: string): Promise<DBComputeJob | null> {
    // TO DO C2D
    const selectSQL = `
      SELECT * FROM ${this.schema.name} WHERE jobId = ?
    `
    return new Promise<DBComputeJob | null>((resolve, reject) => {
      this.db.get(selectSQL, [jobId], (err, row: any | undefined) => {
        if (err) {
          reject(err)
        } else {
          // also decode the internal data into job data
          if (row && row.body) {
            const body: any = generateJSONFromBlob(row.body)
            const job: DBComputeJob = { ...body }
            resolve(job)
          } else {
            resolve(null)
          }
        }
      })
    })
  }

  // eslint-disable-next-line require-await
  async updateJob(job: DBComputeJob) {
    // TO DO C2D
  }

  // eslint-disable-next-line require-await
  async getRunningJobs(engine?: string, environment?: string): Promise<DBComputeJob[]> {
    // TO DO C2D
    return []
  }
}
