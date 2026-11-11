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
    settings?: { [setting: string]: any }
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
  escrowSchema: ElasticsearchSchema
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
  },
  escrowSchema: {
    index: 'escrow',
    body: {
      mappings: {
        properties: {
          id: { type: 'keyword' },
          eventType: { type: 'keyword' },
          chainId: { type: 'long' },
          contract: { type: 'keyword' },
          block: { type: 'long' },
          txHash: { type: 'keyword' },
          payer: { type: 'keyword' },
          payee: { type: 'keyword' },
          token: { type: 'keyword' },
          jobId: { type: 'keyword' },
          amount: { type: 'text' },
          expiry: { type: 'text' },
          proof: { type: 'text' },
          maxLockedAmount: { type: 'text' },
          maxLockSeconds: { type: 'text' },
          maxLockCounts: { type: 'text' },
          oldAmount: { type: 'text' },
          newAmount: { type: 'text' },
          newExpiry: { type: 'text' },
          // Subsidy events (Subsidized / LockSponsored / SponsorRefunded) + Auth v2 expiry
          provider: { type: 'keyword' },
          subsidyAmount: { type: 'text' },
          bonusAmount: { type: 'text' },
          expiryTimestamp: { type: 'text' },
          reclaimable: { type: 'boolean' }
        }
      }
    }
  }
}

// numeric node metrics fields shared by the samples and hourly indices
const metricsNumericFields = Object.fromEntries(
  [
    'cpuUsagePercent',
    'coresAllocated',
    'hostCores',
    'throttledCount',
    'memUsedBytes',
    'memLimitBytes',
    'hostFreeBytes',
    'hostTotalBytes',
    'diskUsedBytes',
    'rxBytes',
    'txBytes',
    'jobsRunning',
    'jobsRunningFree',
    'jobsQueued',
    'jobsQueuedFree',
    'sampledContainers'
  ].map((field) => [field, { type: 'double' }])
)

// owner addresses match whatever casing they were written with
const lowercaseNormalizerSettings = {
  analysis: {
    normalizer: {
      lowercase: { type: 'custom', filter: ['lowercase'] }
    }
  }
}

// Node state: config, auth tokens, buckets, metrics, C2D jobs, service jobs and locks.
export const stateSchemas: {
  nodeConfig: ElasticsearchSchema
  authTokens: ElasticsearchSchema
  buckets: ElasticsearchSchema
  metricsSamples: ElasticsearchSchema
  metricsHourly: ElasticsearchSchema
  c2dJobs: ElasticsearchSchema
  serviceJobs: ElasticsearchSchema
  dockerImages: ElasticsearchSchema
  serviceLocks: ElasticsearchSchema
} = {
  nodeConfig: {
    index: 'node_config',
    body: {
      mappings: {
        properties: {
          value: { type: 'keyword' }
        }
      }
    }
  },
  // id = sha256 of the token; the token itself is never stored
  authTokens: {
    index: 'auth_tokens',
    body: {
      mappings: {
        properties: {
          address: { type: 'keyword' },
          createdAt: { type: 'long' },
          validUntil: { type: 'long' },
          isValid: { type: 'boolean' },
          chainId: { type: 'keyword' }
        }
      }
    }
  },
  // persistent-storage bucket registry: id = bucketId
  buckets: {
    index: 'buckets',
    body: {
      mappings: {
        properties: {
          owner: { type: 'keyword' },
          accessListJson: { type: 'text', index: false },
          createdAt: { type: 'long' },
          label: { type: 'keyword' }
        }
      }
    }
  },
  // raw minute samples per instance: auto id
  metricsSamples: {
    index: 'node_metrics_samples',
    body: {
      mappings: {
        properties: {
          instanceId: { type: 'keyword' },
          collectedAt: { type: 'long' },
          ...metricsNumericFields,
          gpu: { type: 'text', index: false },
          env: { type: 'text', index: false }
        }
      }
    }
  },
  // hourly averages per instance: id = `${instanceId}:${hourStart}`
  metricsHourly: {
    index: 'node_metrics_hourly',
    body: {
      mappings: {
        properties: {
          instanceId: { type: 'keyword' },
          hourStart: { type: 'long' },
          sampleCount: { type: 'integer' },
          ...metricsNumericFields,
          gpu: { type: 'text', index: false },
          env: { type: 'text', index: false }
        }
      }
    }
  },
  // C2D jobs: id = jobId; dates are decimal Unix seconds; expireTimestamp holds maxJobDuration
  c2dJobs: {
    index: 'c2d_jobs',
    body: {
      settings: lowercaseNormalizerSettings,
      mappings: {
        properties: {
          owner: { type: 'keyword', normalizer: 'lowercase' },
          did: { type: 'keyword' },
          agreementId: { type: 'keyword' },
          environment: { type: 'keyword' },
          statusText: { type: 'keyword' },
          inputDID: { type: 'keyword' },
          algoDID: { type: 'keyword' },
          status: { type: 'integer' },
          dateCreated: { type: 'double' },
          dateFinished: { type: 'double' },
          expireTimestamp: { type: 'long' },
          body: { type: 'object', enabled: false }
        }
      }
    }
  },
  // service-on-demand jobs: id = serviceId; body holds the whole job
  serviceJobs: {
    index: 'service_jobs',
    body: {
      settings: lowercaseNormalizerSettings,
      mappings: {
        properties: {
          owner: { type: 'keyword', normalizer: 'lowercase' },
          clusterHash: { type: 'keyword' },
          status: { type: 'integer' },
          expiresAt: { type: 'long' },
          dateCreated: { type: 'keyword' },
          outputArchiveCount: { type: 'integer' },
          body: { type: 'object', enabled: false }
        }
      }
    }
  },
  // docker image usage: id = image name; lastUsedTimestamp in Unix seconds
  dockerImages: {
    index: 'docker_images',
    body: {
      mappings: {
        properties: {
          lastUsedTimestamp: { type: 'long' }
        }
      }
    }
  },
  // service lifecycle locks: id = serviceId; acquiredAt in Unix ms
  serviceLocks: {
    index: 'service_locks',
    body: {
      mappings: {
        properties: {
          holder: { type: 'keyword' },
          acquiredAt: { type: 'long' }
        }
      }
    }
  }
}
