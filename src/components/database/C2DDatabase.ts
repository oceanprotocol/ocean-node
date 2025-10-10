import path from 'path'
import fs from 'fs'
import { ComputeEnvironment, DBComputeJob } from '../../@types/C2D/C2D.js'
import { SQLiteCompute } from './sqliteCompute.js'
import { DATABASE_LOGGER } from '../../utils/logging/common.js'
import { OceanNodeDBConfig } from '../../@types/OceanNode.js'
import { TypesenseSchema } from './TypesenseSchemas.js'
import { AbstractDatabase } from './BaseDatabase.js'
import { OceanNode } from '../../OceanNode.js'
import { getDatabase } from '../../utils/database.js'
import { getConfiguration } from '../../utils/index.js'
import { generateUniqueID } from '../core/compute/utils.js'
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
    if (!job.jobId) job.jobId = generateUniqueID(job)
    const jobId = await this.provider.newJob(job)
    return jobId
  }

  async getJob(
    jobId?: string,
    agreementId?: string,
    owner?: string
  ): Promise<DBComputeJob[]> {
    const jobs = await this.provider.getJob(jobId, agreementId, owner)
    return jobs
  }

  async updateJob(job: DBComputeJob): Promise<number> {
    let updated = 0
    const previouslySaved: DBComputeJob[] = await this.getJob(job.jobId)
    if (previouslySaved.length === 1) {
      previouslySaved[0] = job
      updated = await this.provider.updateJob(previouslySaved[0])
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

  async getAllFinishedJobs(): Promise<DBComputeJob[]> {
    return await this.provider.getAllFinishedJobs()
  }

  async deleteJob(jobId: string): Promise<boolean> {
    return await this.provider.deleteJob(jobId)
  }

  async getJobs(fromTimestamp?: string): Promise<DBComputeJob[]> {
    return await this.provider.getAllJobs(fromTimestamp)
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
    const config = await getConfiguration(true)
    const allEngines = await OceanNode.getInstance(
      config,
      await getDatabase()
    ).getC2DEngines().engines

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
            if (await engine.cleanupExpiredStorage(job)) {
              cleaned++
            }
          }
        }
      }
      cleaned += await this.cleanOrphanJobs(allEnvironments)
    }
    return cleaned
  }

  /**
   * Clean orphan jobs. Stuff left on DB without existing environments associated
   * @param existingEnvironments
   * @returns number of orphans
   */
  async cleanOrphanJobs(existingEnvironments: ComputeEnvironment[]) {
    const c2dDatabase = await (await getDatabase()).c2d
    let cleaned = 0

    const envIds: string[] = existingEnvironments
      .filter((env: any) => env && typeof env.id === 'string')
      .map((env: any) => env.id)

    // Get all finished jobs from DB, not just from known environments
    const allJobs: DBComputeJob[] = await c2dDatabase.getAllFinishedJobs()

    for (const job of allJobs) {
      if (!job.environment || !envIds.includes(job.environment)) {
        if (await c2dDatabase.deleteJob(job.jobId)) {
          cleaned++
        }
      }
    }

    DATABASE_LOGGER.info('Cleaned ' + cleaned + ' orphan C2D jobs')
    return cleaned
  }
}
