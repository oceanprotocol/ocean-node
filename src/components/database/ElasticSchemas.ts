import fs from 'fs'
import path, { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'
import { DATABASE_LOGGER } from '../../utils/logging/common.js'
import { LOG_LEVELS_STR } from '../../utils/logging/Logger.js'

export type ElasticsearchSchema = {
  index: string
  body: {
    mappings: {
      properties: {
        [field: string]: {
          type: string
          [options: string]: any
        }
      }
    }
  }
}

export function readElasticsearchJsonSchemas(): ElasticsearchSchema[] {
  const jsonDocuments: ElasticsearchSchema[] = []
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
        const fileData = fs.readFileSync(path.join(schemaFilePath, file), 'utf-8')
        const jsonFile = JSON.parse(fileData.toString())

        const esSchema: ElasticsearchSchema = {
          index: jsonFile.name,
          body: {
            mappings: {
              properties: jsonFile.fields.reduce((acc: any, field: any) => {
                acc[field.name] = { type: convertToElasticsearchType(field.type) }
                if (field.sort) {
                  acc[field.name].index = true
                }
                if (field.optional) {
                  acc[field.name].null_value = null
                }
                if (field.enum) {
                  acc[field.name].enum = field.enum
                }
                return acc
              }, {})
            }
          }
        }

        jsonDocuments.push(esSchema)
      })
      return jsonDocuments
    }
  } catch (error) {
    DATABASE_LOGGER.log(
      LOG_LEVELS_STR.LEVEL_ERROR,
      `JSON mappings could not be loaded in Elasticsearch database.
      Error: ${error}`,
      true
    )
  }
  return []
}

function convertToElasticsearchType(typesenseType: string): string {
  const typeMapping: { [key: string]: string } = {
    int64: 'long',
    string: 'keyword',
    bool: 'boolean'
  }
  return typeMapping[typesenseType] || 'text'
}

export type ElasticsearchSchemas = {
  ddoSchemas: ElasticsearchSchema[]
  nonceSchemas: ElasticsearchSchema
  indexerSchemas: ElasticsearchSchema
  logSchemas: ElasticsearchSchema
  orderSchema: ElasticsearchSchema
  ddoStateSchema: ElasticsearchSchema
}

const ddoSchemas = readElasticsearchJsonSchemas()
export const elasticSchemas: ElasticsearchSchemas = {
  ddoSchemas,
  nonceSchemas: {
    index: 'nonce',
    body: {
      mappings: {
        properties: {
          nonce: { type: 'long' }
        }
      }
    }
  },
  indexerSchemas: {
    index: 'indexer',
    body: {
      mappings: {
        properties: {
          lastIndexedBlock: { type: 'long' }
        }
      }
    }
  },
  logSchemas: {
    index: 'logs',
    body: {
      mappings: {
        properties: {
          timestamp: { type: 'date' },
          level: { type: 'keyword' },
          message: { type: 'text' },
          moduleName: { type: 'keyword' },
          meta: { type: 'object', enabled: false }
        }
      }
    }
  },
  orderSchema: {
    index: 'order',
    body: {
      mappings: {
        properties: {
          type: { type: 'keyword' },
          timestamp: { type: 'date' },
          consumer: { type: 'keyword' },
          payer: { type: 'keyword' },
          datatokenAddress: { type: 'keyword' },
          nftAddress: { type: 'keyword' },
          did: { type: 'keyword' },
          startOrderId: { type: 'keyword' }
        }
      }
    }
  },
  ddoStateSchema: {
    index: 'state',
    body: {
      mappings: {
        properties: {
          chainId: { type: 'long' },
          did: { type: 'keyword' },
          nft: { type: 'keyword' },
          txId: { type: 'keyword' },
          valid: { type: 'boolean' },
          error: { type: 'text' }
        }
      }
    }
  }
}
