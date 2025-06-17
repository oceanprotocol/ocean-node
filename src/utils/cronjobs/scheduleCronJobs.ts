// scheduleCronJobs.ts

import { Database } from '../../components/database/index.js'
import { OceanNode } from '../../OceanNode.js'
import { ENVIRONMENT_VARIABLES } from '../constants.js'
import { OCEAN_NODE_LOGGER } from '../logging/common.js'
import * as cron from 'node-cron'

export function scheduleCronJobs(node: OceanNode) {
  scheduleDeleteLogsJob(node.getDatabase())
  scheduleCleanExpiredC2DJobs(node.getDatabase())
}

function scheduleDeleteLogsJob(dbconn: Database | null) {
  // Schedule the cron job to run daily at midnight

  if (dbconn && dbconn.logs) {
    const expression =
      process.env[ENVIRONMENT_VARIABLES.CRON_DELETE_DB_LOGS.name] || '0 0 * * *'
    cron.schedule(expression, async () => {
      const deletedLogsNum = await dbconn.logs.deleteOldLogs()
      OCEAN_NODE_LOGGER.logMessage(
        `${deletedLogsNum} old logs deleted successfully.`,
        true
      )
    })
  } else {
    OCEAN_NODE_LOGGER.warn(
      'Logs CronJob: Database connection not established or logs instance not available (skipped).'
    )
  }
}

function scheduleCleanExpiredC2DJobs(dbconn: Database | null) {
  // Schedule the cron job to run every 5 minutes or whatever specified

  if (dbconn && dbconn.c2d) {
    const expression =
      process.env[ENVIRONMENT_VARIABLES.CRON_CLEANUP_C2D_STORAGE.name] || '*/5 * * * *'
    cron.schedule(expression, async () => {
      const deleted = await dbconn.c2d.cleanStorageExpiredJobs()
      OCEAN_NODE_LOGGER.info(`${deleted} old C2D jobs cleaned successfully.`)
    })
  } else {
    OCEAN_NODE_LOGGER.warn(
      'C2D CronJob: Database connection not established or C2D instance not available (skipped).'
    )
  }
}
