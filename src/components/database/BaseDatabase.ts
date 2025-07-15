import { Schema } from '.'
import { OceanNodeDBConfig } from '../../@types'
import { GENERIC_EMOJIS, LOG_LEVELS_STR } from '../../utils/logging/Logger.js'
import { DATABASE_LOGGER } from '../../utils/logging/common.js'
import { ElasticsearchSchema } from './ElasticSchemas.js'
import { TypesenseSchema } from './TypesenseSchemas.js'

export abstract class AbstractDatabase {
  protected config: OceanNodeDBConfig
  protected schema: TypesenseSchema

  constructor(config: OceanNodeDBConfig, schema?: TypesenseSchema) {
    this.config = config
    this.schema = schema
  }
}
export abstract class AbstractNonceDatabase extends AbstractDatabase {
  abstract create(address: string, nonce: number): Promise<any>
  abstract retrieve(address: string): Promise<any>
  abstract update(address: string, nonce: number): Promise<any>
  abstract delete(address: string): Promise<any>

  protected logError(message: string, error: any) {
    const errorMsg = `${message}: ${error.message}`
    DATABASE_LOGGER.logMessageWithEmoji(
      errorMsg,
      true,
      GENERIC_EMOJIS.EMOJI_CROSS_MARK,
      LOG_LEVELS_STR.LEVEL_ERROR
    )
  }
}

export abstract class AbstractIndexerDatabase extends AbstractDatabase {
  abstract create(network: number, lastIndexedBlock: number): Promise<any>
  abstract retrieve(network: number): Promise<any>
  abstract update(network: number, lastIndexedBlock: number): Promise<any>
  abstract delete(network: number): Promise<any>
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

export abstract class AbstractOrderDatabase {
  protected config: OceanNodeDBConfig
  protected schema: Schema

  constructor(config: OceanNodeDBConfig, schema: Schema) {
    this.config = config
    this.schema = schema
  }

  abstract search(
    query: Record<string, any>,
    maxResultsPerPage?: number,
    pageNumber?: number
  ): Promise<Record<string, any>[] | null>

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

export abstract class AbstractDdoDatabase {
  protected config: OceanNodeDBConfig
  protected schemas: Schema[]

  constructor(config: OceanNodeDBConfig, schemas: Schema[]) {
    this.config = config
    this.schemas = schemas
  }

  abstract getSchemas(): Schema[]

  public isElasticsearchSchema(schema: Schema): schema is ElasticsearchSchema {
    return (schema as ElasticsearchSchema).index !== undefined
  }

  public isTypesenseSchema(schema: Schema): schema is TypesenseSchema {
    return (schema as TypesenseSchema).name !== undefined
  }

  abstract search(
    query: Record<string, any>,
    maxResultsPerPage?: number,
    pageNumber?: number
  ): Promise<any>

  abstract create(ddo: Record<string, any>): Promise<any>

  abstract retrieve(id: string): Promise<any>

  abstract update(ddo: Record<string, any>): Promise<any>

  abstract delete(id: string): Promise<any>

  abstract deleteAllAssetsFromChain(chainId: number, batchSize?: number): Promise<number>
}
