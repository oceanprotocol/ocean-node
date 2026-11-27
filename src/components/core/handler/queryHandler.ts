import { CommandHandler } from './handler.js'
import { QueryCommand } from '../../../@types/commands.js'
import { P2PCommandResponse } from '../../../@types/OceanNode.js'
import { Readable } from 'stream'
import {
  ValidateParams,
  validateCommandParameters
} from '../../httpRoutes/validateCommands.js'
import { CORE_LOGGER } from '../../../utils/logging/common.js'
import { safeStringify } from '../../../utils/logging/redact.js'
import type { Database } from '../../database/index.js'
import { DdoStateKey, Found, QueryError } from '../../database/BaseDatabase.js'
import {
  QueryRequest,
  assetConditions,
  pageOf,
  parseQueryRequest,
  sortOf
} from '../../database/assetQuery.js'

// The answer is { results, totalResults } for each type of query.
async function runQuery(database: Database, request: QueryRequest): Promise<Found<any>> {
  switch (request.type) {
    case 'orders':
      return await database.order.find(request.filter, pageOf(request))
    case 'tags': {
      const tags = await database.ddo.tags(assetConditions(request.filter), request.size)
      return { results: tags, totalResults: tags.length }
    }
    default:
      return await database.ddo.find(
        assetConditions(request.filter),
        sortOf(request.sort),
        pageOf(request)
      )
  }
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
      const request = parseQueryRequest(task.query)
      const database = await this.getOceanNode().getDatabase()
      if (!database || !database.ddo) {
        CORE_LOGGER.debug('DDO database is not available')
        return {
          stream: null,
          status: { httpStatus: 503, error: 'DDO database is not available' }
        }
      }
      const result = await runQuery(database, request)
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

// `query` is the key of the state: { did }, { nft } or { txId }
export class QueryDdoStateHandler extends QueryHandler {
  async handle(task: QueryCommand): Promise<P2PCommandResponse> {
    const validationResponse = await this.verifyParamsAndRateLimits(task)
    if (this.shouldDenyTaskHandling(validationResponse)) {
      return validationResponse
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

      const result = await database.ddoState.find(task.query as DdoStateKey)

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
      CORE_LOGGER.error(`Error in QueryDdoStateHandler: ${error.message}`)
      return {
        stream: null,
        status: { httpStatus: 500, error: 'Unknown error: ' + error.message }
      }
    }
  }
}
