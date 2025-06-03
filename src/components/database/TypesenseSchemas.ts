import { TypesenseCollectionCreateSchema } from '../../@types/index.js'
import fs from 'fs'
import path, { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'
import { DATABASE_LOGGER } from '../../utils/logging/common.js'
import { LOG_LEVELS_STR } from '../../utils/logging/Logger.js'

export function readJsonSchemas(): TypesenseCollectionCreateSchema[] {
  const jsonDocuments: TypesenseCollectionCreateSchema[] = []
  const pathToSchemaDir: string = '../../../schemas'
  const currentModulePath = fileURLToPath(import.meta.url)

  try {
    const currentDirectory = dirname(currentModulePath)
    const schemaFilePath = resolve(currentDirectory, pathToSchemaDir)
    const jsonFiles = fs
      .readdirSync(schemaFilePath)
      .filter((file) => path.extname(file) === '.json')

    if (jsonFiles.length === 0) {
      DATABASE_LOGGER.log(
        LOG_LEVELS_STR.LEVEL_ERROR,
        `No JSON files found in the schemas directory ${schemaFilePath}.`,
        true
      )
      return []
    } else {
      jsonFiles.forEach((file) => {
        // eslint-disable-next-line security/detect-non-literal-fs-filename
        const fileData = fs.readFileSync(path.join(schemaFilePath, file), 'utf-8')
        const jsonFile = JSON.parse(fileData.toString())
        jsonDocuments.push(jsonFile)
      })
      return jsonDocuments
    }
  } catch (error) {
    DATABASE_LOGGER.log(
      LOG_LEVELS_STR.LEVEL_ERROR,
      `JSON mappings could not be loaded in database.
      Error: ${error}`,
      true
    )
  }
  return []
}

export type TypesenseSchema = TypesenseCollectionCreateSchema
export type TypesenseSchemas = {
  ddoSchemas: TypesenseSchema[]
  nonceSchemas: TypesenseSchema
  c2dSchemas: TypesenseSchema
  indexerSchemas: TypesenseSchema
  logSchemas: TypesenseSchema
  orderSchema: TypesenseSchema
  ddoStateSchema: TypesenseSchema,
  authTokenSchemas: TypesenseSchema
}
const ddoSchemas = readJsonSchemas()
export const typesenseSchemas: TypesenseSchemas = {
  ddoSchemas,
  nonceSchemas: {
    name: 'nonce',
    enable_nested_fields: true,
    fields: [{ name: 'nonce', type: 'int64' }]
  },
  c2dSchemas: {
    name: 'c2djobs',
    enable_nested_fields: true,
    fields: [
      // not really needed because it will be SQL Lite
      { name: 'clusterHash', type: 'string', optional: false },
      { name: 'configlogURL', type: 'string', optional: false },
      { name: 'publishlogURL', type: 'string', optional: false },
      { name: 'algologURL', type: 'string', optional: false },
      { name: 'outputsURL', type: 'auto', optional: false },
      { name: 'stopRequested', type: 'bool', optional: false },
      { name: 'algorithm', type: 'auto', optional: false },
      { name: 'assets', type: 'auto', optional: false },
      { name: 'isRunning', type: 'bool', optional: false },
      { name: 'isStarted', type: 'bool', optional: false },
      { name: 'containerImage', type: 'string', optional: false }
    ]
  },
  indexerSchemas: {
    name: 'indexer',
    enable_nested_fields: true,
    fields: [{ name: 'lastIndexedBlock', type: 'int64' }]
  },
  logSchemas: {
    name: 'logs',
    enable_nested_fields: true,
    fields: [
      { name: 'timestamp', type: 'int64', sort: true },
      { name: 'level', type: 'string' },
      { name: 'message', type: 'string' },
      { name: 'moduleName', type: 'string', optional: true },
      { name: 'meta', type: 'string', optional: true }
    ]
  },
  orderSchema: {
    name: 'order',
    enable_nested_fields: true,
    fields: [
      { name: 'type', type: 'string', enum: ['startOrder', 'reuseOrder'] },
      { name: 'timestamp', type: 'int64' },
      { name: 'consumer', type: 'string' },
      { name: 'payer', type: 'string' },
      { name: 'datatokenAddress', type: 'string' },
      { name: 'nftAddress', type: 'string' },
      { name: 'did', type: 'string' },
      {
        name: 'startOrderId',
        type: 'string',
        optional: true,
        dependencies: { type: ['reuseOrder'] }
      }
    ]
  },
  ddoStateSchema: {
    name: 'state',
    enable_nested_fields: true,
    fields: [
      { name: 'chainId', type: 'int64' },
      { name: 'did', type: 'string' },
      { name: 'nft', type: 'string' },
      { name: 'txId', type: 'string' },
      { name: 'valid', type: 'bool' },
      { name: 'error', type: 'string' }
    ]
  },
  authTokenSchemas: {
    name: 'authTokens',
    enable_nested_fields: true,
    fields: [
      { name: 'token', type: 'string' },
      { name: 'address', type: 'string' },
      { name: 'createdAt', type: 'int64' },
    ]
  }
}
