import { z } from 'zod'
import { getAddress } from 'ethers'
import { dhtFilterMethod } from '../../@types/OceanNode.js'
import { C2DClusterType } from '../../@types/C2D/C2D.js'
import { defaultBootstrapAddresses, DEFAULT_RATE_LIMIT_PER_MINUTE } from '../constants.js'
import { CONFIG_LOGGER } from '../logging/common.js'
import { numberFromString, booleanFromString, jsonFromString } from './transforms.js'
import { DEFAULT_UNSAFE_URLS, DEFAULT_FILTER_ANNOUNCED_ADDRESSES } from './constants.js'

function isValidUrl(urlString: string): boolean {
  try {
    // eslint-disable-next-line no-new
    new URL(urlString)
    return true
  } catch {
    return false
  }
}

export const SupportedNetworkSchema = z.object({
  chainId: z.number(),
  rpc: z.string(),
  network: z.string().optional(),
  chunkSize: z.number().optional(),
  startBlock: z.number().optional(),
  fallbackRPCs: z.array(z.string()).optional()
})

export const RPCSSchema = z.record(z.string(), SupportedNetworkSchema)

export const AccessListContractSchema = z
  .union([
    z.record(z.string(), z.array(z.string())),
    z.array(z.any()).transform(() => null),
    z.null()
  ])
  .nullable()

export const OceanNodeKeysSchema = z.object({
  peerId: z.any(),
  publicKey: z.any(),
  privateKey: z.any(),
  ethAddress: z.string()
})

export const DenyListSchema = z.object({
  peers: z.array(z.string()).default([]),
  ips: z.array(z.string()).default([])
})

export const FeeAmountSchema = z.object({
  amount: z.number(),
  unit: z.string()
})

export const FeeTokensSchema = z.object({
  chain: z.string(),
  token: z.string()
})

export const FeeStrategySchema = z.object({
  feeTokens: z.array(FeeTokensSchema).optional(),
  feeAmount: FeeAmountSchema.optional()
})

export const OceanNodeDBConfigSchema = z.object({
  url: z.string().nullable(),
  username: z.string().optional(),
  password: z.string().optional(),
  dbType: z.string().nullable()
})

export const ComputeResourceSchema = z.object({
  id: z.string(),
  total: z.number().optional(),
  description: z.string().optional(),
  type: z.string().optional(),
  kind: z.string().optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  inUse: z.number().optional(),
  init: z.any().optional()
})

export const ComputeResourcesPricingInfoSchema = z.object({
  id: z.string(),
  price: z.number()
})

export const ComputeEnvFeesSchema = z.object({
  feeToken: z.string().optional(),
  prices: z.array(ComputeResourcesPricingInfoSchema).optional()
})

export const ComputeEnvironmentFreeOptionsSchema = z.object({
  maxJobDuration: z.number().int().optional().default(3600),
  maxJobs: z.number().int().optional().default(3),
  resources: z.array(ComputeResourceSchema).optional()
})

export const C2DDockerConfigSchema = z.array(
  z
    .object({
      socketPath: z.string().optional(),
      protocol: z.string().optional(),
      host: z.string().optional(),
      port: z.number().optional(),
      caPath: z.string().optional(),
      certPath: z.string().optional(),
      keyPath: z.string().optional(),
      resources: z.array(ComputeResourceSchema).optional(),
      storageExpiry: z.number().int().optional().default(604800),
      maxJobDuration: z.number().int().optional().default(3600),
      fees: z.record(z.string(), z.array(ComputeEnvFeesSchema)),
      free: ComputeEnvironmentFreeOptionsSchema.optional()
    })
    .refine((data) => data.fees !== undefined && Object.keys(data.fees).length > 0, {
      message: 'There is no fees configuration!'
    })
    .refine((data) => data.storageExpiry >= data.maxJobDuration, {
      message: '"storageExpiry" should be greater than "maxJobDuration"'
    })
    .refine(
      (data) => {
        if (!data.resources) return false
        return data.resources.some((r) => r.id === 'disk' && r.total)
      },
      { message: 'There is no "disk" resource configured. This is mandatory' }
    )
    .transform((data) => {
      if (data.resources) {
        for (const resource of data.resources) {
          if (resource.id === 'disk' && resource.total) {
            resource.type = 'disk'
          }
        }
      }
      return data
    })
)

export const C2DClusterInfoSchema = z.object({
  type: z.nativeEnum(C2DClusterType),
  hash: z.string(),
  connection: z.any().optional(),
  tempFolder: z.string().optional()
})

export const OceanNodeP2PConfigSchema = z.object({
  bootstrapNodes: jsonFromString(z.array(z.string()))
    .optional()
    .default(defaultBootstrapAddresses),
  bootstrapTimeout: numberFromString.optional().default(2000),
  bootstrapTagName: z.string().optional().default('bootstrap'),
  bootstrapTagValue: numberFromString.optional().default(50),
  bootstrapTTL: numberFromString.optional(),
  enableIPV4: booleanFromString.optional().default(true),
  enableIPV6: booleanFromString.optional().default(true),
  ipV4BindAddress: z.string().nullable().optional().default('0.0.0.0'),
  ipV4BindTcpPort: numberFromString.nullable().optional().default(0),
  ipV4BindWsPort: numberFromString.nullable().optional().default(0),
  ipV6BindAddress: z.string().nullable().optional().default('::1'),
  ipV6BindTcpPort: numberFromString.nullable().optional().default(0),
  ipV6BindWsPort: numberFromString.nullable().optional().default(0),
  pubsubPeerDiscoveryInterval: numberFromString.optional().default(1000),
  dhtMaxInboundStreams: numberFromString.optional().default(500),
  dhtMaxOutboundStreams: numberFromString.optional().default(500),
  dhtFilter: z
    .union([z.nativeEnum(dhtFilterMethod), z.string(), z.number(), z.null()])
    .transform((v) => {
      if (v === null) {
        return dhtFilterMethod.filterNone
      }
      if (typeof v === 'number' || typeof v === 'string') {
        const filterValue = typeof v === 'string' ? parseInt(v, 10) : v
        switch (filterValue) {
          case 1:
            return dhtFilterMethod.filterPrivate
          case 2:
            return dhtFilterMethod.filterPublic
          default:
            return dhtFilterMethod.filterNone
        }
      }
      return v
    })
    .optional()
    .default(dhtFilterMethod.filterNone),
  mDNSInterval: numberFromString.optional().default(20e3),
  connectionsMaxParallelDials: numberFromString.optional().default(15),
  connectionsDialTimeout: numberFromString.optional().default(30e3),
  upnp: booleanFromString.optional().default(true),
  autoNat: booleanFromString.optional().default(true),
  enableCircuitRelayServer: booleanFromString.optional().default(false),
  enableCircuitRelayClient: booleanFromString.optional().default(false),
  circuitRelays: numberFromString.optional().default(0),
  announcePrivateIp: booleanFromString.optional().default(false),
  announceAddresses: jsonFromString(z.array(z.string())).optional().default([]),
  filterAnnouncedAddresses: jsonFromString(z.array(z.string()))
    .optional()
    .default([...DEFAULT_FILTER_ANNOUNCED_ADDRESSES]),
  minConnections: numberFromString.optional().default(1),
  maxConnections: numberFromString.optional().default(300),
  autoDialPeerRetryThreshold: numberFromString.optional().default(120000),
  autoDialConcurrency: numberFromString.optional().default(5),
  maxPeerAddrsToDial: numberFromString.optional().default(5),
  autoDialInterval: numberFromString.optional().default(5000),
  enableNetworkStats: booleanFromString.optional().default(false)
})

const addressArrayFromString = jsonFromString(z.array(z.string())).transform(
  (addresses) => {
    if (!Array.isArray(addresses)) return []
    try {
      return addresses.map((addr) => getAddress(addr))
    } catch (error) {
      CONFIG_LOGGER.error(`Invalid address in list: ${error.message}`)
      return []
    }
  }
)

export const OceanNodeConfigSchema = z
  .object({
    dockerComputeEnvironments: jsonFromString(C2DDockerConfigSchema)
      .optional()
      .default([]),

    authorizedDecrypters: addressArrayFromString.optional().default([]),
    authorizedDecryptersList: jsonFromString(AccessListContractSchema).optional(),

    allowedValidators: addressArrayFromString.optional().default([]),
    allowedValidatorsList: jsonFromString(AccessListContractSchema).optional(),

    authorizedPublishers: addressArrayFromString.optional().default([]),
    authorizedPublishersList: jsonFromString(AccessListContractSchema).optional(),

    keys: OceanNodeKeysSchema,

    INTERFACES: z.string().optional(),
    hasP2P: booleanFromString.optional().default(true),
    hasHttp: booleanFromString.optional().default(true),

    p2pConfig: OceanNodeP2PConfigSchema.nullable().optional(),
    hasIndexer: booleanFromString.default(true),
    hasControlPanel: booleanFromString.default(true),

    DB_URL: z.string().optional(),
    DB_USERNAME: z.string().optional(),
    DB_PASSWORD: z.string().optional(),
    DB_TYPE: z.string().optional(),
    dbConfig: OceanNodeDBConfigSchema.optional(),

    FEE_AMOUNT: z.string().optional(),
    FEE_TOKENS: z.string().optional(),
    feeStrategy: FeeStrategySchema.optional(),

    httpPort: numberFromString.refine((port) => port >= 1 && port <= 65535, {
      message: 'HTTP port must be between 1 and 65535'
    }),
    rateLimit: numberFromString.optional().default(DEFAULT_RATE_LIMIT_PER_MINUTE),

    supportedNetworks: jsonFromString(RPCSSchema).optional(),

    claimDurationTimeout: numberFromString.default(600),
    indexingNetworks: z
      .union([jsonFromString(RPCSSchema), z.array(z.union([z.string(), z.number()]))])
      .optional(),

    c2dClusters: z.array(C2DClusterInfoSchema).optional(),
    accountPurgatoryUrl: z
      .string()
      .nullable()
      .refine((url) => !url || isValidUrl(url), {
        message: 'accountPurgatoryUrl must be a valid URL'
      }),
    assetPurgatoryUrl: z
      .string()
      .nullable()
      .refine((url) => !url || isValidUrl(url), {
        message: 'assetPurgatoryUrl must be a valid URL'
      }),
    allowedAdmins: addressArrayFromString.optional(),
    allowedAdminsList: jsonFromString(AccessListContractSchema).optional(),

    codeHash: z.string().optional(),
    maxConnections: numberFromString.optional(),
    denyList: jsonFromString(DenyListSchema).optional().default({ peers: [], ips: [] }),
    unsafeURLs: jsonFromString(z.array(z.string()))
      .optional()
      .default([...DEFAULT_UNSAFE_URLS]),
    isBootstrap: booleanFromString.optional().default(false),
    validateUnsignedDDO: booleanFromString.optional().default(true),
    jwtSecret: z.string()
  })
  .passthrough()
  .superRefine((data, ctx) => {
    if (!data.hasHttp && !data.hasP2P) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'At least one interface (HTTP or P2P) must be enabled',
        path: ['hasHttp']
      })
    }

    if (data.hasP2P && !data.p2pConfig) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'P2P configuration is required when hasP2P is true',
        path: ['p2pConfig']
      })
    }
  })

export type OceanNodeConfigParsed = z.infer<typeof OceanNodeConfigSchema>
