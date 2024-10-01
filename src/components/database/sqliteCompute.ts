import { schemas, Schema } from './schemas.js'
import type { DBComputeJob } from '../../@types/C2D/C2D.js'
import sqlite3 from 'sqlite3'

interface ComputeDatabaseProvider {
  newJob(job: DBComputeJob): Promise<string>
  getJob(jobId: string): Promise<DBComputeJob>
  updateJob(job: DBComputeJob): void
  getRunningJobs(engine?: string, environment?: string): Promise<DBComputeJob[]>
}

export class SQLiteCompute implements ComputeDatabaseProvider {
  private db: sqlite3.Database
  private schema: Schema

  constructor(private dbFilePath: string) {
    this.db = new sqlite3.Database(dbFilePath)
    this.schema = schemas.nonceSchemas
  }

  // eslint-disable-next-line require-await
  async createTable() {
    // TO DO C2D
  }

  // eslint-disable-next-line require-await
  async newJob(job: DBComputeJob): Promise<string> {
    // TO DO C2D
  }

  async getJob(jobId: string): Promise<DBComputeJob> {
    // TO DO C2D
  }

  async updateJob(job: DBComputeJob) {
    // TO DO C2D
  }

  async getRunningJobs(engine?: string, environment?: string): Promise<DBComputeJob[]> {
    // TO DO C2D
  }
}
