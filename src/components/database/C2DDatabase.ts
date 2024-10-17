import path from 'path'
import fs from 'fs'
import { DBComputeJob } from '../../@types/C2D/C2D.js'
import { SQLiteCompute } from './sqliteCompute.js'
import { DATABASE_LOGGER } from '../../utils/logging/common.js'
import { GENERIC_EMOJIS, LOG_LEVELS_STR } from '../../utils/logging/Logger.js'
import { OceanNodeDBConfig } from '../../@types/OceanNode.js'
import { TypesenseSchema } from './TypesenseSchemas.js'

export class C2DDatabase {
  private provider: SQLiteCompute
  private tempMem: DBComputeJob[]
  constructor(
    private config: OceanNodeDBConfig,
    private schema: TypesenseSchema
  ) {
    this.tempMem = []
    return (async (): Promise<C2DDatabase> => {
      // Fall back to SQLite
      DATABASE_LOGGER.logMessageWithEmoji(
        'C2DDatabase:  Typesense not available, falling back to SQLite',
        true,
        GENERIC_EMOJIS.EMOJI_CROSS_MARK,
        LOG_LEVELS_STR.LEVEL_WARN
      )

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

  // eslint-disable-next-line require-await
  async newJob(job: DBComputeJob): Promise<string> {
    // TO DO C2D
    this.tempMem.push(job)
    return job.agreementId
  }

  // eslint-disable-next-line require-await
  async getJob(jobId: string): Promise<DBComputeJob | null> {
    console.log('GetJob jobId:' + jobId)
    console.log(this.tempMem)
    for (const i in this.tempMem) {
      if (this.tempMem[i].jobId === jobId) return this.tempMem[i]
    }
    return null
  }

  // eslint-disable-next-line require-await
  async updateJob(job: DBComputeJob) {
    // TO DO C2D
    for (const i in this.tempMem) {
      if (this.tempMem[i].jobId === job.jobId) this.tempMem[i] = job
    }
  }

  // eslint-disable-next-line require-await
  async getRunningJobs(engine?: string, environment?: string): Promise<DBComputeJob[]> {
    // TO DO C2D
    const runningJobs: DBComputeJob[] = []
    for (const i in this.tempMem) {
      if (this.tempMem[i].isRunning === true) {
        if (engine && this.tempMem[i].clusterHash !== engine) continue
        if (environment && this.tempMem[i].environment !== environment) continue
        runningJobs.push(this.tempMem[i])
      }
    }
    return runningJobs
  }
}
