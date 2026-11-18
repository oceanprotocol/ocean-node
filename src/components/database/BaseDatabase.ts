import { OceanNodeDBConfig } from '../../@types'
import { AccessListUser } from '../../@types/AccessList.js'
import { EscrowEvent } from '../../@types/Escrow.js'
import { DATABASE_LOGGER } from '../../utils/logging/common.js'

// a DDO version that the DDO store keeps apart; `index` is its name in a query
export interface DdoSchema {
  index: string
}

// The query of the node is the Elasticsearch query: `query`, `sort`, `from`, `size`.
// A query that the node cannot run: the caller gets the message (HTTP 400).
export class QueryError extends Error {}

// A backend that cannot run a clause of a query throws this; it never ignores the clause.
export class UnsupportedQueryError extends QueryError {
  constructor(clause: string, dbType: string) {
    super(`Query clause '${clause}' is not supported on the ${dbType} database`)
  }
}

export const DEFAULT_PAGE_SIZE = 100
// the last document that one search can reach, as on Elasticsearch (its default window)
export const MAX_RESULT_WINDOW = 10000

// `from` of a node query is a page number that starts at 1, not a document offset
export function queryPage(query: Record<string, any>): { size: number; offset: number } {
  for (const key of ['size', 'from']) {
    const value = query[key]
    if (value !== undefined && !(Number.isInteger(value) && value >= 0)) {
      throw new QueryError(`'${key}' of a query must be a whole number, 0 or more`)
    }
  }
  const size = query.size ?? DEFAULT_PAGE_SIZE
  return { size, offset: (query.from || 1) * size - size }
}

export abstract class AbstractDatabase {
  protected config: OceanNodeDBConfig

  constructor(config: OceanNodeDBConfig) {
    this.config = config
  }
}
export abstract class AbstractNonceDatabase extends AbstractDatabase {
  abstract create(address: string, nonce: number): Promise<any>
  abstract retrieve(address: string): Promise<any>
  abstract update(address: string, nonce: number): Promise<any>
  abstract delete(address: string): Promise<any>

  protected logError(message: string, error: any) {
    const errorMsg = `${message}: ${error.message}`
    DATABASE_LOGGER.error(errorMsg)
  }
}

export abstract class AbstractIndexerDatabase extends AbstractDatabase {
  abstract create(network: number, lastIndexedBlock: number): Promise<any>
  abstract retrieve(network: number): Promise<any>
  abstract update(network: number, lastIndexedBlock: number): Promise<any>
  abstract delete(network: number): Promise<any>
}

export abstract class AbstractAccessListDatabase extends AbstractDatabase {
  abstract create(
    chainId: number,
    contractAddress: string,
    transferable: boolean,
    block: number,
    txId: string,
    name?: string,
    symbol?: string
  ): Promise<any>

  abstract retrieve(chainId: number, contractAddress: string): Promise<any>
  abstract addUser(
    chainId: number,
    contractAddress: string,
    user: AccessListUser
  ): Promise<any>

  abstract removeUserByTokenId(
    chainId: number,
    contractAddress: string,
    tokenId: number
  ): Promise<any>

  abstract searchByWallet(wallet: string, chainId?: number): Promise<any[]>
  abstract delete(chainId: number, contractAddress: string): Promise<any>
}

export abstract class AbstractLogDatabase extends AbstractDatabase {
  abstract insertLog(logEntry: Record<string, any>): Promise<any>
  abstract retrieveLog(id: string): Promise<Record<string, any> | null>
  abstract retrieveMultipleLogs(
    startTime: Date,
    endTime: Date,
    maxLogs: number,
    moduleName?: string,
    level?: string,
    page?: number
  ): Promise<Record<string, any>[]>

  abstract delete(logId: string): Promise<void>
  abstract deleteOldLogs(): Promise<number>
  abstract getLogsCount(): Promise<number>
}

export abstract class AbstractDdoStateDatabase extends AbstractDatabase {
  abstract create(
    chainId: number,
    did: string,
    nftAddress: string,
    txId?: string,
    valid?: boolean,
    errorMsg?: string
  ): Promise<any>

  abstract retrieve(did: string): Promise<Record<string, any> | null>

  abstract search(query: Record<string, any>): Promise<any>

  abstract update(
    chainId: number,
    did: string,
    nftAddress: string,
    txId?: string,
    valid?: boolean,
    errorMsg?: string
  ): Promise<any>

  abstract delete(did: string): Promise<any>
}

export abstract class AbstractOrderDatabase extends AbstractDatabase {
  // takes a node query, as the DDO store does; null on a database error
  abstract search(query: Record<string, any>): Promise<Record<string, any>[] | null>

  abstract create(
    orderId: string,
    type: string,
    timestamp: number,
    consumer: string,
    payer: string,
    datatokenAddress: string,
    nftAddress: string,
    did: string,
    startOrderId?: string
  ): Promise<any>

  abstract retrieve(orderId: string): Promise<Record<string, any> | null>

  abstract update(
    orderId: string,
    type: string,
    timestamp: number,
    consumer: string,
    payer: string,
    startOrderId?: string,
    datatokenAddress?: string
  ): Promise<any>

  abstract delete(orderId: string): Promise<any>
}

export abstract class AbstractEscrowDatabase extends AbstractDatabase {
  abstract create(event: EscrowEvent): Promise<any>

  abstract retrieve(id: string): Promise<Record<string, any> | null>

  abstract search(
    filters: Record<string, any>,
    offset?: number,
    size?: number
  ): Promise<Record<string, any>[] | null>

  abstract delete(id: string): Promise<any>
}

export abstract class AbstractDdoDatabase extends AbstractDatabase {
  abstract getSchemas(): DdoSchema[]

  // `from` and `size` of the query select the page
  abstract search(query: Record<string, any>): Promise<any>

  abstract create(ddo: Record<string, any>): Promise<any>

  abstract retrieve(id: string): Promise<any>

  abstract update(ddo: Record<string, any>): Promise<any>

  abstract delete(id: string): Promise<any>

  abstract deleteAllAssetsFromChain(chainId: number): Promise<number>
}
