import { DATABASE_LOGGER } from '../../../utils/logging/common.js'
import { QueryError } from '../BaseDatabase.js'

// The callers of these stores expect null, not a throw, when the database fails. The
// failure is logged here. A query that the node cannot run is an error of the caller,
// not of the database: it is thrown.
export async function orNull<T>(what: string, work: () => Promise<T>): Promise<T | null> {
  try {
    return await work()
  } catch (error) {
    if (error instanceof QueryError) throw error
    DATABASE_LOGGER.error(`${what}: ${error.message}`)
    return null
  }
}
