import { TypesenseCollectionCreateSchema } from '../../@types/index.js'
import fs from 'fs'
import path, { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'
import { DATABASE_LOGGER } from '../../utils/logging/common.js'
import { LOG_LEVELS_STR } from '../../utils/logging/Logger.js'

export function readJsonSchemas(): any[] {
  const jsonDocuments: any[] = []
  const pathToSchemaDir: string = '../../../schemas'
  const currentModulePath = fileURLToPath(import.meta.url)

  // Use dirname to get the directory name
  const currentDirectory = dirname(currentModulePath)
  const schemaFilePath = resolve(currentDirectory, pathToSchemaDir)
  const jsonFiles = fs
    .readdirSync(schemaFilePath)
    .filter((file) => path.extname(file) === '.json')

  if (!jsonFiles || jsonFiles === undefined) {
    DATABASE_LOGGER.log(
      LOG_LEVELS_STR.LEVEL_ERROR,
      `JSON mappings could not be read. Possibly the JSON format mappings for Typesense DB are missing or invalid.`,
      true
    )
    return []
  }
  jsonFiles.forEach((file) => {
    try {
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      const fileData = fs.readFileSync(path.join(schemaFilePath, file), 'utf-8')
      const jsonFile = JSON.parse(fileData.toString())
      jsonDocuments.push(jsonFile)
    } catch (err) {
      DATABASE_LOGGER.log(
        LOG_LEVELS_STR.LEVEL_ERROR,
        `Error loading DDO schema from ${path.join(pathToSchemaDir, file)}: ${err}`,
        true
      )
    }
  })
  return jsonDocuments
}

export type Schema = TypesenseCollectionCreateSchema
export type Schemas = {
  ddoSchemas: Schema[]
  nonceSchemas: Schema
  indexerSchemas: Schema
  logSchemas: Schema
  orderSchema: Schema
}
const ddoSchemas = readJsonSchemas()
export const schemas: Schemas = {
  ddoSchemas,
  nonceSchemas: {
    name: 'nonce',
    enable_nested_fields: true,
    fields: [{ name: 'nonce', type: 'int64' }]
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
      {
        name: 'startOrderId',
        type: 'string',
        optional: true,
        dependencies: { type: ['reuseOrder'] }
      }
    ]
  }
}
