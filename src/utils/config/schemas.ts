import { z } from 'zod'
import { getAddress } from 'ethers'
import { dhtFilterMethod } from '../../@types/OceanNode.js'
import { C2DClusterType } from '../../@types/C2D/C2D.js'
import { CONFIG_LOGGER } from '../logging/common.js'
import { booleanFromString, jsonFromString } from './transforms.js'
import {
  DEFAULT_BOOTSTRAP_ADDRESSES,
  DEFAULT_RATE_LIMIT_PER_MINUTE,
  DEFAULT_UNSAFE_URLS,
  DEFAULT_FILTER_ANNOUNCED_ADDRESSES
} from './constants.js'

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

export const AccessListContractSchema = z.preprocess(
  (val) => {
    // If it's not a plain object, normalize to null
    if (val === null) return null
    if (typeof val !== 'object' || Array.isArray(val)) return null

    return val
  },
  z.record(z.string(), z.array(z.string())).nullable()
)

export const OceanNodeKeysSchema = z.object({
  peerId: z.any().optional(),
  publicKey: z.any().optional(),
  privateKey: z.any().optional(),
  ethAddress: z.string().optional()
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
  resources: z.array(ComputeResourceSchema).optional(),
  access: z
    .object({
      addresses: z.array(z.string()),
      accessLists: z.array(z.string())
    })
    .optional()
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
      minJobDuration: z.number().int().optional().default(60),
      access: z
        .object({
          addresses: z.array(z.string()),
          accessLists: z.array(z.string())
        })
        .optional(),
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
  bootstrapNodes: jsonFromString(z.array(z.string())).default([
    ...DEFAULT_BOOTSTRAP_ADDRESSES
  ]),
  bootstrapTimeout: z.coerce.number().optional().default(10000),
  bootstrapTagName: z.string().optional().default('bootstrap'),
  bootstrapTagValue: z.coerce.number().optional().default(50),
  bootstrapTTL: z.coerce.number().optional(),
  enableIPV4: booleanFromString.optional().default(true),
  enableIPV6: booleanFromString.optional().default(true),
  ipV4BindAddress: z.string().nullable().optional().default('0.0.0.0'),
  ipV4BindTcpPort: z.coerce.number().nullable().optional().default(9000),
  ipV4BindWsPort: z.coerce.number().nullable().optional().default(9001),
  ipV4BindWssPort: z.coerce.number().nullable().optional().default(9005),
  ipV6BindAddress: z.string().nullable().optional().default('::'),
  ipV6BindTcpPort: z.coerce.number().nullable().optional().default(9002),
  ipV6BindWsPort: z.coerce.number().nullable().optional().default(9003),
  pubsubPeerDiscoveryInterval: z.coerce.number().optional().default(1000),
  dhtMaxInboundStreams: z.coerce.number().optional().default(500),
  dhtMaxOutboundStreams: z.coerce.number().optional().default(500),
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
  mDNSInterval: z.coerce.number().optional().default(20e3),
  connectionsMaxParallelDials: z.coerce.number().optional().default(15),
  connectionsDialTimeout: z.coerce.number().optional().default(30e3),
  upnp: booleanFromString.optional().default(true),
  autoNat: booleanFromString.optional().default(true),
  enableCircuitRelayServer: booleanFromString.optional().default(false),
  enableCircuitRelayClient: booleanFromString.optional().default(false),
  circuitRelays: z.coerce.number().optional().default(0),
  announcePrivateIp: booleanFromString.optional().default(false),
  announceAddresses: jsonFromString(z.array(z.string())).optional().default([]),
  filterAnnouncedAddresses: jsonFromString(z.array(z.string()))
    .optional()
    .default([...DEFAULT_FILTER_ANNOUNCED_ADDRESSES]),
  minConnections: z.coerce.number().optional().default(1),
  maxConnections: z.coerce.number().optional().default(300),
  autoDialPeerRetryThreshold: z.coerce.number().optional().default(120000),
  autoDialConcurrency: z.coerce.number().optional().default(5),
  maxPeerAddrsToDial: z.coerce.number().optional().default(5),
  autoDialInterval: z.coerce.number().optional().default(5000),
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

    keys: OceanNodeKeysSchema.optional(),

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

    httpPort: z.coerce.number().optional().default(3000),
    rateLimit: z.coerce.number().optional().default(DEFAULT_RATE_LIMIT_PER_MINUTE),

    ipfsGateway: z.string().nullable().optional(),
    arweaveGateway: z.string().nullable().optional(),

    supportedNetworks: jsonFromString(RPCSSchema).optional(),

    claimDurationTimeout: z.coerce.number().default(3600),
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
    maxConnections: z.coerce.number().optional(),
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
