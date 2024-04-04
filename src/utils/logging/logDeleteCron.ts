// scheduleCronJobs.ts

import { Database } from '../../components/database/index.js'
import { OCEAN_NODE_LOGGER } from './common.js'
import * as cron from 'node-cron'

export function scheduleCronJobs(dbconn: Database | null) {
  // Schedule the cron job to run daily at midnight
  cron.schedule('0 0 * * *', async () => {
    if (dbconn && dbconn.logs) {
      const deletedLogsNum = await dbconn.logs.deleteOldLogs()
      OCEAN_NODE_LOGGER.logMessage(
        `${deletedLogsNum} old logs deleted successfully.`,
        true
      )
    } else {
      OCEAN_NODE_LOGGER.logMessage(
        'Database connection not established or logs instance not available.',
        true
      )
    }
  })
}
