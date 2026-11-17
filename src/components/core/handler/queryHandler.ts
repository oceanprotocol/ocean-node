import { CommandHandler } from './handler.js'
import { QueryCommand } from '../../../@types/commands.js'
import { P2PCommandResponse } from '../../../@types/OceanNode.js'
import { Readable } from 'stream'
import {
  ValidateParams,
  buildInvalidParametersResponse,
  validateCommandParameters
} from '../../httpRoutes/validateCommands.js'
import { CORE_LOGGER } from '../../../utils/logging/common.js'
import { safeStringify } from '../../../utils/logging/redact.js'
import type { Database } from '../../database/index.js'
import { QueryError, queryPage } from '../../database/BaseDatabase.js'

// the `index` of a query that selects the orders
const ORDER_INDEX = 'order'
// the last document that a public query can reach, as on Elasticsearch
const MAX_RESULT_WINDOW = 10000

// The `index` field of a query selects the store: the orders, or the DDOs of one schema.
// All other values search all DDOs, so a query cannot read another store. The answer is
// one array of documents for each group that has hits.
async function searchStore(
  database: Database,
  { index, ...query }: Record<string, any>
): Promise<any[]> {
  const { size, offset } = queryPage(query)
  if (offset + size > MAX_RESULT_WINDOW) {
    throw new QueryError(`A query reads the first ${MAX_RESULT_WINDOW} documents at most`)
  }
  if (index === ORDER_INDEX) {
    const orders = await database.order.search(query)
    return orders?.length > 0 ? [orders] : []
  }
  const isDdoSchema = database.ddo.getSchemas().some((schema) => schema.index === index)
  return (await database.ddo.search(isDdoSchema ? { index, ...query } : query)) || []
}

export class QueryHandler extends CommandHandler {
  validate(command: QueryCommand): ValidateParams {
    return validateCommandParameters(command, ['query'])
  }

  async handle(task: QueryCommand): Promise<P2PCommandResponse> {
    const validationResponse = await this.verifyParamsAndRateLimits(task)
    if (this.shouldDenyTaskHandling(validationResponse)) {
      return validationResponse
    }
    try {
      const database = await this.getOceanNode().getDatabase()
      if (!database || !database.ddo) {
        CORE_LOGGER.debug('DDO database is not available')
        return {
          stream: null,
          status: { httpStatus: 503, error: 'DDO database is not available' }
        }
      }
      const result = await searchStore(database, task.query)
      return {
        stream: Readable.from(JSON.stringify(result)),
        status: { httpStatus: 200 }
      }
    } catch (error) {
      if (error instanceof QueryError) {
        return { stream: null, status: { httpStatus: 400, error: error.message } }
      }
      CORE_LOGGER.error(`Error in QueryHandler: ${error.message}`)
      return {
        stream: null,
        status: { httpStatus: 500, error: 'Unknown error: ' + error.message }
      }
    }
  }
}

export class QueryDdoStateHandler extends QueryHandler {
  async handle(task: QueryCommand): Promise<P2PCommandResponse> {
    const validation = this.validate(task)
    if (!validation.valid) {
      return buildInvalidParametersResponse(validation)
    }
    try {
      const database = await this.getOceanNode().getDatabase()
      if (!database || !database.ddoState) {
        CORE_LOGGER.debug('DDO State database is not available')
        return {
          stream: null,
          status: { httpStatus: 503, error: 'DDO State database is not available' }
        }
      }

      const result = await database.ddoState.search(task.query)

      CORE_LOGGER.debug(`DDO State search result: ${safeStringify(result)}`)

      if (result === null) {
        CORE_LOGGER.debug('Database search returned null')
        return {
          stream: null,
          status: { httpStatus: 500, error: 'Database search failed' }
        }
      }

      return {
        stream: Readable.from(JSON.stringify(result)),
        status: { httpStatus: 200 }
      }
    } catch (error) {
      if (error instanceof QueryError) {
        return { stream: null, status: { httpStatus: 400, error: error.message } }
      }
      CORE_LOGGER.error(`Error in QueryDdoStateHandler: ${error.message}`)
      return {
        stream: null,
        status: { httpStatus: 500, error: 'Unknown error: ' + error.message }
      }
    }
  }
}
