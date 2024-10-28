// scheduleCronJobs.ts

import { Database } from '../../components/database/index.js'
import { OCEAN_NODE_LOGGER } from '../logging/common.js'
import * as cron from 'node-cron'

export function scheduleCronJobs(dbconn: Database | null) {
  scheduleDeleteLogsJob(dbconn)
  scheduleCleanExpiredC2DJobs(dbconn)
}

function scheduleDeleteLogsJob(dbconn: Database | null) {
  // Schedule the cron job to run daily at midnight

  if (dbconn && dbconn.logs) {
    cron.schedule('0 0 * * *', async () => {
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
  // Schedule the cron job to run daily at 5 minutes past midnight

  if (dbconn && dbconn.c2d) {
    cron.schedule('5 0 * * *', async () => {
      await dbconn.c2d.cleanExpiredJobs()
      OCEAN_NODE_LOGGER.info('old C2D jobs cleaned successfully.')
    })
  } else {
    OCEAN_NODE_LOGGER.warn(
      'C2D CronJob: Database connection not established or C2D instance not available (skipped).'
    )
  }
}
