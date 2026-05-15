import { ddoElasticMappings } from '@oceanprotocol/ddo-js'

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

export type ElasticsearchSchemas = {
  ddoSchemas: ElasticsearchSchema[]
  nonceSchemas: ElasticsearchSchema
  indexerSchemas: ElasticsearchSchema
  logSchemas: ElasticsearchSchema
  orderSchema: ElasticsearchSchema
  ddoStateSchema: ElasticsearchSchema
  accessListSchema: ElasticsearchSchema
}

// "op_ddo_short" is a node-side index for deprecated DDOs (state !== 0).
// Not part of the DDO spec, so it stays here rather than in @oceanprotocol/ddo-js.
const ddoShortSchema: ElasticsearchSchema = {
  index: 'op_ddo_short',
  body: {
    mappings: {
      properties: {
        id: { type: 'keyword' },
        version: { type: 'keyword' },
        chainId: { type: 'long' },
        nftAddress: { type: 'keyword' },
        indexedMetadata: {
          type: 'object',
          properties: {
            nft: {
              type: 'object',
              properties: {
                state: { type: 'integer' }
              }
            }
          }
        }
      }
    }
  }
}

export const elasticSchemas: ElasticsearchSchemas = {
  ddoSchemas: [...(ddoElasticMappings as ElasticsearchSchema[]), ddoShortSchema],
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
  },
  accessListSchema: {
    index: 'access_list',
    body: {
      mappings: {
        properties: {
          chainId: { type: 'integer' },
          contractAddress: { type: 'keyword' },
          name: { type: 'keyword' },
          symbol: { type: 'keyword' },
          transferable: { type: 'boolean' },
          users: {
            type: 'nested',
            properties: {
              wallet: { type: 'keyword' },
              tokenId: { type: 'long' },
              block: { type: 'long' },
              txId: { type: 'keyword' }
            }
          },
          deploymentBlock: { type: 'long' },
          deploymentTxId: { type: 'keyword' }
        }
      }
    }
  }
}
