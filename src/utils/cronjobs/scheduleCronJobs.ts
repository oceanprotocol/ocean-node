// scheduleCronJobs.ts

import { Database } from '../../components/database/index.js'
import { OceanNode } from '../../OceanNode.js'
import { ENVIRONMENT_VARIABLES } from '../constants.js'
import { OCEAN_NODE_LOGGER } from '../logging/common.js'
import * as cron from 'node-cron'
import { p2pAnnounceDDOS } from './p2pAnnounceDDOS.js'
import { p2pAnnounceC2D } from './p2pAnnounceC2D.js'
import { sleep } from '../util.js'

// republish any ddos we are providing to the network every 4 hours
// (we can put smaller interval for testing purposes)
const REPUBLISH_INTERVAL_HOURS = 1000 * 60 * 60 * 4 // 4 hours

export async function scheduleCronJobs(node: OceanNode) {
  await sleep(2000) // wait for 2 seconds to ensure the node is fully initialized
  try {
    scheduleDeleteLogsJob(await node.getDatabase())
  } catch (e) {
    OCEAN_NODE_LOGGER.error(`Error when deleting old logs: ${e.message}`)
  }
  try {
    scheduleCleanExpiredC2DJobs(await node.getDatabase())
  } catch (e) {
    OCEAN_NODE_LOGGER.error(`Error when deleting expired c2d jobs: ${e.message}`)
  }
  // Both announce jobs are started fire-and-forget, so nothing awaits their promise: a
  // rejection would be an unhandled rejection, and this process installs an
  // `unhandledRejection` handler that calls `process.exit(1)`. A failed announce must never be
  // able to stop the node, so every call site attaches a handler of its own even though both
  // jobs already guard their own bodies.
  const runAnnounceJob = (
    name: string,
    job: (target: OceanNode) => Promise<void>
  ): void => {
    job(node).catch((err) => {
      OCEAN_NODE_LOGGER.error(
        `Error in ${name} cron job: ${err instanceof Error ? err.message : String(err)}`
      )
    })
  }

  // execute p2pAnnounceDDOS immediately on startup
  // and then every REPUBLISH_INTERVAL_HOURS
  runAnnounceJob('p2pAnnounceDDOS', p2pAnnounceDDOS)
  setInterval(
    () => runAnnounceJob('p2pAnnounceDDOS', p2pAnnounceDDOS),
    REPUBLISH_INTERVAL_HOURS
  )

  // execute p2pAnnounceC2D immediately on startup
  // and then every REPUBLISH_INTERVAL_HOURS
  runAnnounceJob('p2pAnnounceC2D', p2pAnnounceC2D)
  setInterval(
    () => runAnnounceJob('p2pAnnounceC2D', p2pAnnounceC2D),
    REPUBLISH_INTERVAL_HOURS
  )
}

function scheduleDeleteLogsJob(dbconn: Database | null) {
  // Schedule the cron job to run daily at midnight

  if (dbconn && dbconn.logs) {
    const expression =
      process.env[ENVIRONMENT_VARIABLES.CRON_DELETE_DB_LOGS.name] || '0 0 * * *'
    cron.schedule(expression, async () => {
      try {
        const deletedLogsNum = await dbconn.logs.deleteOldLogs()
        OCEAN_NODE_LOGGER.logMessage(
          `${deletedLogsNum} old logs deleted successfully.`,
          true
        )
      } catch (err) {
        OCEAN_NODE_LOGGER.error(`Error deleting old logs: ${err.message}`)
      }
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
      try {
        const deleted = await dbconn.c2d.cleanStorageExpiredJobs()
        OCEAN_NODE_LOGGER.info(`${deleted} expired C2D jobs cleaned successfully.`)
      } catch (err) {
        OCEAN_NODE_LOGGER.error(`Error deleting expired jobs: ${err.message}`)
      }
    })
  } else {
    OCEAN_NODE_LOGGER.warn(
      'C2D CronJob: Database connection not established or C2D instance not available (skipped).'
    )
  }
}
