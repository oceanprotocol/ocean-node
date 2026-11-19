import { OceanNodeDBConfig } from '../../@types'
import { AccessListUser } from '../../@types/AccessList.js'
import { EscrowEvent } from '../../@types/Escrow.js'
import { DATABASE_LOGGER } from '../../utils/logging/common.js'

// a group of DDOs of one version (see ddoSchemas.ts); `index` is its name
export interface DdoSchema {
  index: string
}

// A query that the node cannot run: the caller gets the message (HTTP 400).
export class QueryError extends Error {}

export const DEFAULT_PAGE_SIZE = 100
// the last document that one search can reach, as on Elasticsearch (its default window)
export const MAX_RESULT_WINDOW = 10000

export type Scalar = string | number | boolean

// A condition on a stored document. `paths` are the places of one field, one for each
// document version (a DDO v4 path and its v5 `credentialSubject.` path); the condition
// holds when one of them holds. Each backend writes its own fixed query for each kind.
export type Condition =
  // a value of the field is one of these
  | { paths: string[]; anyOf: Scalar[] }
  // no value of the field is one of these (a document without the field passes)
  | { paths: string[]; noneOf: Scalar[] }
  // a value of the field is in the range
  | { paths: string[]; range: { gt?: Scalar; gte?: Scalar; lt?: Scalar; lte?: Scalar } }
  // the field, or an object with fields below it, is in the document
  | { paths: string[]; exists: true }
  // each word is in a value of one of the fields
  | { paths: string[]; words: string[] }
  // one of these conditions holds
  | { either: Condition[] }

export interface SortSpec {
  paths: string[]
  order: 'asc' | 'desc'
  // a backend with a text score sorts by it first, then by `paths`; the others by `paths`
  relevance?: boolean
}

// `offset` counts documents
export interface Page {
  offset: number
  limit: number
}

export interface Found<T = Record<string, any>> {
  results: T[]
  totalResults: number
}

export interface TagCount {
  tag: string
  count: number
}

// one of the three keys of a DDO state
export type DdoStateKey = { did: string } | { nft: string } | { txId: string }

// the orders of one account
export type OrderOwner = { consumer: string } | { payer: string }

export abstract class AbstractDatabase {
  protected config: OceanNodeDBConfig

  constructor(config: OceanNodeDBConfig) {
    this.config = config
  }
}
export abstract class AbstractNonceDatabase extends AbstractDatabase {
  abstract create(address: string, nonce: number): Promise<any>
  abstract retrieve(address: string): Promise<any>
  // Writes only a nonce above the stored one, and returns null when it did not: two
  // requests that check the same signed nonce at the same time cannot both pass.
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

const DEFAULT_LOG_RETENTION_MS = 30 * 24 * 60 * 60 * 1000

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

  // the time that a log stays (LOG_RETENTION_TIME, milliseconds). A value of 0 or less
  // would delete the new logs too: it gets the default.
  protected retentionMs(): number {
    const raw = process.env.LOG_RETENTION_TIME
    const retention = Number(raw)
    if (raw === undefined || raw === '') return DEFAULT_LOG_RETENTION_MS
    if (Number.isFinite(retention) && retention > 0) return retention
    DATABASE_LOGGER.warn(
      `Invalid LOG_RETENTION_TIME "${raw}", using ${DEFAULT_LOG_RETENTION_MS} ms`
    )
    return DEFAULT_LOG_RETENTION_MS
  }
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

  // ten states at most; null on a database error
  abstract find(key: DdoStateKey): Promise<Record<string, any>[] | null>

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
  // the newest orders first
  abstract find(owner: OrderOwner, page: Page): Promise<Found>

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

  // the DDOs of all versions, sorted by `sort` and then by id
  abstract find(conditions: Condition[], sort: SortSpec[], page: Page): Promise<Found>

  // the distinct tags of the DDOs that match, the most used first
  abstract tags(conditions: Condition[], limit: number): Promise<TagCount[]>

  abstract create(ddo: Record<string, any>): Promise<any>

  abstract retrieve(id: string): Promise<any>

  abstract update(ddo: Record<string, any>): Promise<any>

  abstract delete(id: string): Promise<any>

  abstract deleteAllAssetsFromChain(chainId: number): Promise<number>
}
