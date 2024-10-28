import path from 'path'
import fs from 'fs'
import { DBComputeJob } from '../../@types/C2D/C2D.js'
import { SQLiteCompute } from './sqliteCompute.js'
import { DATABASE_LOGGER } from '../../utils/logging/common.js'
import { OceanNodeDBConfig } from '../../@types/OceanNode.js'
import { TypesenseSchema } from './TypesenseSchemas.js'
import { AbstractDatabase } from './BaseDatabase.js'
import { OceanNode } from '../../OceanNode.js'
import { getDatabase } from '../../utils/database.js'

export class C2DDatabase extends AbstractDatabase {
  private provider: SQLiteCompute

  constructor(config: OceanNodeDBConfig, schema: TypesenseSchema) {
    super(config, schema)
    return (async (): Promise<C2DDatabase> => {
      // Fall back to SQLite
      DATABASE_LOGGER.info('Creating C2DDatabase with SQLite')

      // Ensure the directory exists before instantiating SQLiteProvider
      const dbDir = path.dirname('databases/c2dDatabase.sqlite')
      if (!fs.existsSync(dbDir)) {
        fs.mkdirSync(dbDir, { recursive: true })
      }
      this.provider = new SQLiteCompute('databases/c2dDatabase.sqlite')
      await this.provider.createTable()

      return this
    })() as unknown as C2DDatabase
  }

  async newJob(job: DBComputeJob): Promise<string> {
    const jobId = await this.provider.newJob(job)
    return jobId
  }

  async getJob(jobId: string): Promise<DBComputeJob | null> {
    const job = await this.provider.getJob(jobId)
    return job || null
  }

  async updateJob(job: DBComputeJob): Promise<number> {
    let updated = 0
    let previouslySaved: DBComputeJob = await this.getJob(job.jobId)
    if (previouslySaved) {
      previouslySaved = job
      updated = await this.provider.updateJob(previouslySaved)
      if (!updated) {
        DATABASE_LOGGER.error(`Unable to update job: ${job.jobId}. No rows affected!`)
      }
    } else {
      DATABASE_LOGGER.error(
        `Unable to update job: ${job.jobId}. It seems this jobID does not exist!`
      )
    }
    return updated
  }

  async getRunningJobs(engine?: string, environment?: string): Promise<DBComputeJob[]> {
    return await this.provider.getRunningJobs(engine, environment)
  }

  async deleteJob(jobId: string): Promise<boolean> {
    return await this.provider.deleteJob(jobId)
  }

  /**
   *
   * @param environment compute environment to check for
   *
   * All compute engines have compute environments,
   * and each compute environment specifies how long the output produced by
   * a job is held by the node, before being deleted.
   * When a job expiry is overdue, the node will delete all storage used by that job,
   * and also delete the job record from the database
   * @returns array of eexpired jobs
   */
  async cleanStorageExpiredJobs(): Promise<number> {
    const allEngines = await OceanNode.getInstance(await getDatabase()).getC2DEngines()
      .engines

    let cleaned = 0
    for (const engine of allEngines) {
      const allEnvironments = await engine.getComputeEnvironments()
      for (const computeEnvironment of allEnvironments) {
        const finishedOrExpired: DBComputeJob[] =
          await this.provider.getFinishedJobs(computeEnvironment)
        for (const job of finishedOrExpired) {
          if (
            computeEnvironment &&
            computeEnvironment.storageExpiry > Date.now() / 1000
          ) {
            // TODO

            if (await engine.cleanupExpiredStorage(job)) {
              cleaned++
            }
          }
        }
      }
    }
    return cleaned
  }
}
