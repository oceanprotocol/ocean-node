import type {
  DenyList,
  OceanNodeConfig,
  OceanNodeKeys,
  AccessListContract
} from '../@types/OceanNode'
import { dhtFilterMethod } from '../@types/OceanNode.js'
import type { C2DClusterInfo, C2DDockerConfig } from '../@types/C2D/C2D.js'
import { C2DClusterType } from '../@types/C2D/C2D.js'
import { createFromPrivKey } from '@libp2p/peer-id-factory'
import { keys } from '@libp2p/crypto'
import {
  computeCodebaseHash,
  DEFAULT_RATE_LIMIT_PER_MINUTE,
  ENVIRONMENT_VARIABLES,
  EnvVariable,
  hexStringToByteArray
} from '../utils/index.js'
import {
  DEFAULT_MAX_CONNECTIONS_PER_MINUTE,
  defaultBootstrapAddresses
} from '../utils/constants.js'

import { LOG_LEVELS_STR, GENERIC_EMOJIS, getLoggerLevelEmoji } from './logging/Logger.js'
import { RPCS } from '../@types/blockchain'
import { getAddress, Wallet } from 'ethers'
import { FeeAmount, FeeStrategy, FeeTokens } from '../@types/Fees'
import {
  getOceanArtifactsAdresses,
  OCEAN_ARTIFACTS_ADDRESSES_PER_CHAIN
} from '../utils/address.js'
import { CONFIG_LOGGER } from './logging/common.js'
import { create256Hash } from './crypt.js'
import { isDefined } from './util.js'
import { fileURLToPath } from 'url'
import path from 'path'
import fs from 'fs'
import os from 'os'
import { z } from 'zod'

const AccessListContractSchema = z.any()
const OceanNodeKeysSchema = z.any()

const OceanNodeDBConfigSchema = z.any()
const FeeStrategySchema = z.any()
const RPCSSchema = z.any()
const C2DClusterInfoSchema = z.any()
const DenyListSchema = z.object({
  peers: z.array(z.string()).default([]),
  ips: z.array(z.string()).default([])
})
const C2DDockerConfigSchema = z.array(
  z.object({
    socketPath: z.string(),
    resources: z.array(
      z.object({
        id: z.string(),
        total: z.number()
      })
    ),
    storageExpiry: z.number().int().optional().default(604800),
    maxJobDuration: z.number().int().optional().default(3600),
    fees: z.record(
      z.string(),
      z.array(
        z.object({
          prices: z.array(
            z.object({
              id: z.string(),
              price: z.number()
            })
          )
        })
      )
    ),
    free: z.object({
      maxJobDuration: z.number().int().optional().default(3600),
      maxJobs: z.number().int().optional().default(3),
      resources: z.array(
        z.object({
          id: z.string(),
          max: z.number()
        })
      )
    })
  })
)

const OceanNodeP2PConfigSchema = z.object({
  bootstrapNodes: z.array(z.string()).optional().default(defaultBootstrapAddresses),
  bootstrapTimeout: z.number().int().optional().default(2000),
  bootstrapTagName: z.string().optional().default('bootstrap'),
  bootstrapTagValue: z.number().int().optional().default(50),
  enableIPV4: z.boolean().optional().default(true),
  enableIPV6: z.boolean().optional().default(true),
  ipV4BindAddress: z.string().optional().default('0.0.0.0'),
  ipV4BindTcpPort: z.number().int().optional().default(0),
  ipV4BindWsPort: z.number().int().optional().default(0),
  ipV6BindAddress: z.string().optional().default('::1'),
  ipV6BindTcpPort: z.number().int().optional().default(0),
  ipV6BindWsPort: z.number().int().optional().default(0),
  pubsubPeerDiscoveryInterval: z.number().int().optional().default(1000),
  dhtMaxInboundStreams: z.number().int().optional().default(500),
  dhtMaxOutboundStreams: z.number().int().optional().default(500),
  mDNSInterval: z.number().int().optional().default(20e3),
  connectionsMaxParallelDials: z.number().int().optional().default(15),
  connectionsDialTimeout: z.number().int().optional().default(30e3),
  upnp: z.boolean().optional().default(true),
  autoNat: z.boolean().optional().default(true),
  enableCircuitRelayServer: z.boolean().optional().default(false),
  enableCircuitRelayClient: z.boolean().optional().default(false),
  circuitRelays: z.number().int().optional().default(0),
  announcePrivateIp: z.boolean().optional().default(false),
  filterAnnouncedAddresses: z
    .array(z.string())
    .optional()
    .default([
      '127.0.0.0/8',
      '10.0.0.0/8',
      '172.16.0.0/12',
      '192.168.0.0/16',
      '100.64.0.0/10',
      '169.254.0.0/16',
      '192.0.0.0/24',
      '192.0.2.0/24',
      '198.51.100.0/24',
      '203.0.113.0/24',
      '224.0.0.0/4',
      '240.0.0.0/4'
    ]),
  minConnections: z.number().int().optional().default(1),
  maxConnections: z.number().int().optional().default(300),
  autoDialPeerRetryThreshold: z.number().int().optional().default(120000),
  autoDialConcurrency: z.number().int().optional().default(5),
  maxPeerAddrsToDial: z.number().int().optional().default(5),
  autoDialInterval: z.number().int().optional().default(5000),
  enableNetworkStats: z.boolean().optional().default(false)
})

export const OceanNodeConfigSchema = z.object({
  dockerComputeEnvironments: C2DDockerConfigSchema,
  authorizedDecrypters: z.array(z.string()),
  authorizedDecryptersList: AccessListContractSchema.nullable(),
  allowedValidators: z.array(z.string()),
  allowedValidatorsList: AccessListContractSchema.nullable(),
  authorizedPublishers: z.array(z.string()),
  authorizedPublishersList: AccessListContractSchema.nullable(),

  keys: OceanNodeKeysSchema,

  hasP2P: z.boolean(),
  p2pConfig: OceanNodeP2PConfigSchema.nullable(),
  hasIndexer: z.boolean(),
  hasHttp: z.boolean(),
  hasControlPanel: z.boolean(),

  dbConfig: OceanNodeDBConfigSchema.optional(),

  httpPort: z.number().int(),
  rateLimit: z.union([z.number(), z.object({})]).optional(),
  feeStrategy: FeeStrategySchema,

  supportedNetworks: RPCSSchema.optional(),

  claimDurationTimeout: z.number().int().default(600),
  indexingNetworks: RPCSSchema.optional(),

  c2dClusters: z.array(C2DClusterInfoSchema),
  c2dNodeUri: z.string(),
  accountPurgatoryUrl: z.string(),
  assetPurgatoryUrl: z.string(),

  allowedAdmins: z.array(z.string()).optional(),
  allowedAdminsList: AccessListContractSchema.nullable().optional(),

  codeHash: z.string().optional(),
  maxConnections: z.number().optional(),
  denyList: DenyListSchema.optional(),
  unsafeURLs: z.array(z.string()).optional().default([
    // AWS and GCP
    '^.*(169.254.169.254).*',
    // GCP
    '^.*(metadata.google.internal).*',
    '^.*(http://metadata).*',
    // Azure
    '^.*(http://169.254.169.254).*',
    // Oracle Cloud
    '^.*(http://192.0.0.192).*',
    // Alibaba Cloud
    '^.*(http://100.100.100.200).*',
    // k8s ETCD
    '^.*(127.0.0.1).*'
  ]),
  isBootstrap: z.boolean().optional().default(false),
  validateUnsignedDDO: z.boolean().optional().default(true),
  jwtSecret: z.string().optional()
})

export type OceanNodeConfigParsed = z.infer<typeof OceanNodeConfigSchema>
// usefull for lazy loading and avoid boilerplate on other places
let previousConfiguration: OceanNodeConfig = null

export async function getPeerIdFromPrivateKey(
  privateKey: string
): Promise<OceanNodeKeys> {
  const key = new keys.supportedKeys.secp256k1.Secp256k1PrivateKey(
    hexStringToByteArray(privateKey.slice(2))
  )

  return {
    peerId: await createFromPrivKey(key),
    publicKey: key.public.bytes,
    // Notes:
    // using 'key.public.bytes' gives extra 4 bytes: 08021221
    // using (key as any)._publicKey is stripping this same 4 bytes at the beginning: 08021221
    // when getting the peer details with 'peerIdFromString(peerName)' it returns the version with the 4 extra bytes
    // and we also need to send that to the client, so he can uncompress the public key correctly and perform the check and the encryption
    // so it would make more sense to use this value on the configuration
    privateKey: (key as any)._key,
    ethAddress: new Wallet(privateKey.substring(2)).address
  }
}

function getIntEnvValue(env: any, defaultValue: number) {
  /* Gets int value for an ENV var, returning defaultValue if not defined */
  const num = parseInt(env, 10)
  return isNaN(num) ? defaultValue : num
}

export function getBoolEnvValue(envName: string, defaultValue: boolean): boolean {
  if (!(envName in process.env)) {
    return defaultValue
  }
  if (
    process.env[envName] === 'true' ||
    process.env[envName] === '1' ||
    process.env[envName]?.toLowerCase() === 'yes'
  ) {
    return true
  }
  return false
}

function getSupportedChains(): RPCS | null {
  const logError = function (): null {
    // missing or invalid RPC list
    CONFIG_LOGGER.logMessageWithEmoji(
      'Missing or Invalid RPCS env variable format, Running node without the Indexer component...',
      true,
      GENERIC_EMOJIS.EMOJI_CROSS_MARK,
      LOG_LEVELS_STR.LEVEL_ERROR
    )
    return null
  }
  if (!existsEnvironmentVariable(ENVIRONMENT_VARIABLES.RPCS)) {
    return logError()
  }
  let supportedNetworks: RPCS = null
  try {
    supportedNetworks = JSON.parse(process.env.RPCS)
  } catch (e) {
    return logError()
  }

  return supportedNetworks
}

// valid publishers (what we will index)
function getAuthorizedPublishers(isStartup?: boolean): string[] {
  if (existsEnvironmentVariable(ENVIRONMENT_VARIABLES.AUTHORIZED_PUBLISHERS, isStartup)) {
    return readAddressListFromEnvVariable(
      ENVIRONMENT_VARIABLES.AUTHORIZED_PUBLISHERS,
      isStartup
    )
  }
  return []
}

function getAuthorizedPublishersList(isStartup?: boolean): AccessListContract | null {
  if (
    existsEnvironmentVariable(ENVIRONMENT_VARIABLES.AUTHORIZED_PUBLISHERS_LIST, isStartup)
  ) {
    try {
      const publisherAccessList = JSON.parse(
        ENVIRONMENT_VARIABLES.AUTHORIZED_PUBLISHERS_LIST.value
      ) as AccessListContract
      return publisherAccessList
    } catch (err) {
      CONFIG_LOGGER.error(err.message)
    }
  }
  return null
}

// valid decrypthers
function getAuthorizedDecrypters(isStartup?: boolean): string[] {
  return readAddressListFromEnvVariable(
    ENVIRONMENT_VARIABLES.AUTHORIZED_DECRYPTERS,
    isStartup
  )
}

function getAuthorizedDecryptersList(isStartup?: boolean): AccessListContract | null {
  if (
    existsEnvironmentVariable(ENVIRONMENT_VARIABLES.AUTHORIZED_DECRYPTERS_LIST, isStartup)
  ) {
    try {
      const decryptersAccessList = JSON.parse(
        ENVIRONMENT_VARIABLES.AUTHORIZED_DECRYPTERS_LIST.value
      ) as AccessListContract
      return decryptersAccessList
    } catch (err) {
      CONFIG_LOGGER.error(err.message)
    }
  }
  return null
}
// allowed validators
export function getAllowedValidators(isStartup?: boolean): string[] {
  return readAddressListFromEnvVariable(
    ENVIRONMENT_VARIABLES.ALLOWED_VALIDATORS,
    isStartup
  )
}

function getAllowedValidatorsList(isStartup?: boolean): AccessListContract | null {
  if (
    existsEnvironmentVariable(ENVIRONMENT_VARIABLES.ALLOWED_VALIDATORS_LIST, isStartup)
  ) {
    try {
      const publisherAccessList = JSON.parse(
        ENVIRONMENT_VARIABLES.ALLOWED_VALIDATORS_LIST.value
      ) as AccessListContract
      return publisherAccessList
    } catch (err) {
      CONFIG_LOGGER.error(err.message)
    }
  }
  return null
}
// valid node admins
function getAllowedAdmins(isStartup?: boolean): string[] {
  return readAddressListFromEnvVariable(ENVIRONMENT_VARIABLES.ALLOWED_ADMINS, isStartup)
}

function getAllowedAdminsList(isStartup?: boolean): AccessListContract | null {
  if (existsEnvironmentVariable(ENVIRONMENT_VARIABLES.ALLOWED_ADMINS_LIST, isStartup)) {
    try {
      const adminAccessList = JSON.parse(
        ENVIRONMENT_VARIABLES.ALLOWED_ADMINS_LIST.value
      ) as AccessListContract
      return adminAccessList
    } catch (err) {
      CONFIG_LOGGER.error(err.message)
    }
  }
  return null
}

// whenever we want to read an array of strings from an env variable, use this common function
function readListFromEnvVariable(
  envVariable: any,
  isStartup?: boolean,
  defaultValue: string[] = []
): string[] {
  const { name } = envVariable
  try {
    if (!existsEnvironmentVariable(envVariable, isStartup)) {
      return defaultValue
    }
    const addressesRaw: string[] = JSON.parse(process.env[name])
    if (!Array.isArray(addressesRaw)) {
      CONFIG_LOGGER.logMessageWithEmoji(
        `Invalid ${name} env variable format`,
        true,
        GENERIC_EMOJIS.EMOJI_CROSS_MARK,
        LOG_LEVELS_STR.LEVEL_ERROR
      )
      return defaultValue
    }
    return addressesRaw
  } catch (error) {
    CONFIG_LOGGER.logMessageWithEmoji(
      `Missing or Invalid address(es) in ${name} env variable`,
      true,
      GENERIC_EMOJIS.EMOJI_CROSS_MARK,
      LOG_LEVELS_STR.LEVEL_ERROR
    )
    return defaultValue
  }
}

// whenever we want to read an array of addresses from an env variable, use this common function
function readAddressListFromEnvVariable(envVariable: any, isStartup?: boolean): string[] {
  const addressesRaw: string[] = readListFromEnvVariable(envVariable, isStartup)
  return addressesRaw.map((address) => getAddress(address))
}
/**
 * get default values for provider fee tokens
 * @param supportedNetworks chains that we support
 * @returns ocean fees token
 */
function getDefaultFeeTokens(supportedNetworks: RPCS): FeeTokens[] {
  const nodeFeesTokens: FeeTokens[] = []
  let addressesData: any = getOceanArtifactsAdresses()
  if (!addressesData) {
    addressesData = OCEAN_ARTIFACTS_ADDRESSES_PER_CHAIN
  }
  // check if we have configured anything ourselves
  const hasSupportedNetworks =
    supportedNetworks && Object.keys(supportedNetworks).length > 0
  // check if we have it supported
  Object.keys(addressesData).forEach((chain: any) => {
    const chainName = chain as string
    const { chainId, Ocean } = addressesData[chainName]

    // if we have set the supported chains, we use those chains/tokens
    if (hasSupportedNetworks) {
      // check if exists the correct one to add
      const keyId: string = chainId as string
      const chainInfo: any = supportedNetworks[keyId]
      if (chainInfo) {
        nodeFeesTokens.push({
          chain: keyId,
          token: Ocean
        })
      }
    } else {
      // otherwise, we add all we know about
      nodeFeesTokens.push({
        chain: chainId as string,
        token: Ocean
      })
    }
  })
  return nodeFeesTokens
}

// parse fees structure from .env
/**
 *
 * @param supportedNetworks networks supported
 * @param isStartup boolean to avoid logging too much
 * @returns Fees structure
 */
function getOceanNodeFees(supportedNetworks: RPCS, isStartup?: boolean): FeeStrategy {
  const logError = () => {
    CONFIG_LOGGER.logMessageWithEmoji(
      'Error parsing Fee Strategy! Please check "FEE_TOKENS" and "FEE_AMOUNT" env variables. Will use defaults...',
      true,
      GENERIC_EMOJIS.EMOJI_CROSS_MARK,
      LOG_LEVELS_STR.LEVEL_ERROR
    )
  }
  let nodeFeesAmount: FeeAmount
  let nodeFeesTokens: FeeTokens[] = []
  try {
    // if not exists, just use defaults
    if (!existsEnvironmentVariable(ENVIRONMENT_VARIABLES.FEE_AMOUNT)) {
      if (isStartup) {
        logMissingVariableWithDefault(ENVIRONMENT_VARIABLES.FEE_AMOUNT)
      }

      nodeFeesAmount = { amount: 0, unit: 'MB' }
    } else {
      try {
        nodeFeesAmount = JSON.parse(process.env.FEE_AMOUNT) as FeeAmount
      } catch (error) {
        CONFIG_LOGGER.logMessageWithEmoji(
          `Invalid "${ENVIRONMENT_VARIABLES.FEE_AMOUNT.name}" env variable => ${process.env.FEE_AMOUNT}...`,
          true,
          GENERIC_EMOJIS.EMOJI_CROSS_MARK,
          LOG_LEVELS_STR.LEVEL_ERROR
        )
        nodeFeesAmount = { amount: 0, unit: 'MB' }
      }
    }
    if (!existsEnvironmentVariable(ENVIRONMENT_VARIABLES.FEE_TOKENS)) {
      // try to get first for artifacts address if available
      if (isStartup) {
        logMissingVariableWithDefault(ENVIRONMENT_VARIABLES.FEE_TOKENS)
      }

      nodeFeesTokens = getDefaultFeeTokens(supportedNetworks)
    } else {
      const tokens = JSON.parse(ENVIRONMENT_VARIABLES.FEE_TOKENS.value)
      Object.keys(tokens).forEach((key: any) => {
        nodeFeesTokens.push({
          chain: key as string,
          token: tokens[key]
        })
      })
    }

    return {
      feeTokens: nodeFeesTokens,
      feeAmount: nodeFeesAmount
    }
  } catch (error) {
    if (isStartup) {
      logError()
    }
    // make sure we always return something usable
    return {
      feeTokens: nodeFeesTokens.length
        ? nodeFeesTokens
        : getDefaultFeeTokens(supportedNetworks),
      feeAmount: nodeFeesAmount || { amount: 0, unit: 'MB' }
    }
  }
}

// get C2D environments
function getC2DClusterEnvironment(
  isStartup?: boolean,
  dockerComputeEnvironments?: C2DDockerConfig[]
): C2DClusterInfo[] {
  const clusters: C2DClusterInfo[] = []
  // avoid log too much (too much noise on tests as well), this is not even required
  if (existsEnvironmentVariable(ENVIRONMENT_VARIABLES.OPERATOR_SERVICE_URL, isStartup)) {
    const clustersURLS: string[] = JSON.parse(
      process.env.OPERATOR_SERVICE_URL
    ) as string[]

    for (const theURL of clustersURLS) {
      clusters.push({
        connection: theURL,
        hash: create256Hash(theURL),
        type: C2DClusterType.OPF_K8
      })
    }
  } else {
    // Use provided dockerComputeEnvironments or fall back to reading from env vars
    const dockerC2Ds =
      dockerComputeEnvironments || getDockerComputeEnvironments(isStartup)
    for (const dockerC2d of dockerC2Ds) {
      if (dockerC2d.socketPath || dockerC2d.host) {
        const hash = create256Hash(JSON.stringify(dockerC2d))
        // get env values
        clusters.push({
          connection: dockerC2d,
          hash,
          type: C2DClusterType.DOCKER,
          tempFolder: './c2d_storage/' + hash
        })
      }
    }
  }

  return clusters
}

function validateC2DDockerConfig(config: C2DDockerConfig): {
  isValid: boolean
  errors: string
} {
  let errors = ''

  if (!isDefined(config.fees)) {
    errors += ' There is no fees configuration!'
  }

  if (config.storageExpiry < config.maxJobDuration) {
    errors += ' "storageExpiry" should be greater than "maxJobDuration"! '
  }

  // Check for disk resource
  let foundDisk = false
  if ('resources' in config) {
    for (const resource of config.resources) {
      if (resource.id === 'disk' && resource.total) {
        foundDisk = true
        resource.type = 'disk'
      }
    }
  }
  if (!foundDisk) {
    errors += ' There is no "disk" resource configured. This is mandatory '
  }

  return {
    isValid: errors.length === 0,
    errors
  }
}

/**
 * Reads a partial ComputeEnvironment setting (array of)
 * @param isStartup for logging purposes
 * @returns 
 * 
 * example:
 * {
    "cpuNumber": 2,
    "ramGB": 4,
    "diskGB": 10,
    "desc": "2Cpu,2gbRam - price 1 OCEAN/minute, max 1 hour",
    "maxJobs": 10,
    "storageExpiry": 36000,
    "maxJobDuration": 3600,
    "chainId": 1,
    "feeToken": "0x967da4048cD07aB37855c090aAF366e4ce1b9F48",
    "priceMin": 1
  },
 */
function getDockerComputeEnvironments(isStartup?: boolean): C2DDockerConfig[] {
  const dockerC2Ds: C2DDockerConfig[] = []
  if (
    existsEnvironmentVariable(
      ENVIRONMENT_VARIABLES.DOCKER_COMPUTE_ENVIRONMENTS,
      isStartup
    )
  ) {
    try {
      const configs: C2DDockerConfig[] = JSON.parse(
        process.env.DOCKER_COMPUTE_ENVIRONMENTS
      ) as C2DDockerConfig[]

      for (const config of configs) {
        const validation = validateC2DDockerConfig(config)
        if (!validation.isValid) {
          CONFIG_LOGGER.error(
            'Please check your compute env settings: ' +
              validation.errors +
              'for env: ' +
              JSON.stringify(config)
          )
        } else {
          dockerC2Ds.push(config)
        }
      }
      return dockerC2Ds
    } catch (error) {
      CONFIG_LOGGER.logMessageWithEmoji(
        `Invalid "${ENVIRONMENT_VARIABLES.DOCKER_COMPUTE_ENVIRONMENTS.name}" env variable => ${process.env.DOCKER_COMPUTE_ENVIRONMENTS}...`,
        true,
        GENERIC_EMOJIS.EMOJI_CROSS_MARK,
        LOG_LEVELS_STR.LEVEL_ERROR
      )
      console.log(error)
    }
  } else if (isStartup) {
    CONFIG_LOGGER.warn(
      `No options for ${ENVIRONMENT_VARIABLES.DOCKER_COMPUTE_ENVIRONMENTS.name} were specified.`
    )
  }
  return []
}

/**
 * checks if a var is defined on env
 * @param envVariable check utils/constants ENVIRONMENT_VARIABLES
 * @param hasDefault if true we ignore if not set
 * @returns boolean
 */
export function existsEnvironmentVariable(envVariable: any, log = false): boolean {
  let { name, value, required } = envVariable
  // extra check in case we change environment with tests (get the latest)
  if (process.env[name] !== value) {
    value = process.env[name]
  }
  if (!value) {
    if (log) {
      CONFIG_LOGGER.logMessageWithEmoji(
        `Invalid or missing "${name}" env variable...`,
        true,
        required
          ? GENERIC_EMOJIS.EMOJI_CROSS_MARK
          : getLoggerLevelEmoji(LOG_LEVELS_STR.LEVEL_WARN),
        required ? LOG_LEVELS_STR.LEVEL_ERROR : LOG_LEVELS_STR.LEVEL_WARN
      )
    }

    return false
  }
  return true
}

function logMissingVariableWithDefault(envVariable: EnvVariable) {
  CONFIG_LOGGER.log(
    LOG_LEVELS_STR.LEVEL_WARN,
    `Missing "${envVariable.name}" env variable. Will use defaults...`,
    true
  )
}
// have a rate limit for handler calls (per IP address or peer id)
function getRateLimit(isStartup: boolean = false) {
  if (!existsEnvironmentVariable(ENVIRONMENT_VARIABLES.MAX_REQ_PER_MINUTE)) {
    if (isStartup) {
      logMissingVariableWithDefault(ENVIRONMENT_VARIABLES.MAX_REQ_PER_MINUTE)
    }
    return DEFAULT_RATE_LIMIT_PER_MINUTE
  } else {
    try {
      return getIntEnvValue(process.env.MAX_REQ_PER_MINUTE, DEFAULT_RATE_LIMIT_PER_MINUTE)
    } catch (err) {
      CONFIG_LOGGER.error(
        `Invalid "${ENVIRONMENT_VARIABLES.MAX_REQ_PER_MINUTE.name}" env variable...`
      )
      return DEFAULT_RATE_LIMIT_PER_MINUTE
    }
  }
}

// Global requests limit
function getConnectionsLimit(isStartup: boolean = false) {
  if (!existsEnvironmentVariable(ENVIRONMENT_VARIABLES.MAX_CONNECTIONS_PER_MINUTE)) {
    if (isStartup) {
      logMissingVariableWithDefault(ENVIRONMENT_VARIABLES.MAX_CONNECTIONS_PER_MINUTE)
    }
    return DEFAULT_RATE_LIMIT_PER_MINUTE
  } else {
    try {
      return getIntEnvValue(
        process.env.MAX_CONNECTIONS_PER_MINUTE,
        DEFAULT_MAX_CONNECTIONS_PER_MINUTE
      )
    } catch (err) {
      CONFIG_LOGGER.error(
        `Invalid "${ENVIRONMENT_VARIABLES.MAX_CONNECTIONS_PER_MINUTE.name}" env variable...`
      )
      return DEFAULT_MAX_CONNECTIONS_PER_MINUTE
    }
  }
}

// get blocked ips and peer ids
function getDenyList(isStartup: boolean = false): DenyList {
  const defaultDenyList: DenyList = {
    peers: [],
    ips: []
  }
  if (!existsEnvironmentVariable(ENVIRONMENT_VARIABLES.RATE_DENY_LIST, isStartup)) {
    return defaultDenyList
  } else {
    try {
      const list: DenyList = JSON.parse(process.env.RATE_DENY_LIST) as DenyList
      return list
    } catch (err) {
      CONFIG_LOGGER.error(
        `Invalid "${ENVIRONMENT_VARIABLES.RATE_DENY_LIST.name}" env variable...`
      )
      return defaultDenyList
    }
  }
}

// lazy access ocean node config, when we don't need updated values from process.env
// this only goes through .env processing once (more suitable for a running node instance)
export async function getConfiguration(
  forceReload: boolean = false,
  isStartup: boolean = false
): Promise<OceanNodeConfig> {
  if (!previousConfiguration || forceReload) {
    // Always use buildMergedConfig() which loads from config.json by default
    // and allows environment variables to override specific settings
    previousConfiguration = await buildMergedConfig()
  }
  if (!previousConfiguration.codeHash) {
    const __filename = fileURLToPath(import.meta.url)
    const __dirname = path.dirname(__filename.replace('utils/', ''))
    previousConfiguration.codeHash = await computeCodebaseHash(__dirname)
  }

  return previousConfiguration
}

export function loadConfigFromEnv(envVar: string = 'CONFIG_PATH'): OceanNodeConfig {
  let configPath = process.env[envVar]
  if (!configPath) {
    if (!fs.existsSync(path.join(process.cwd(), 'config.json'))) {
      throw new Error(
        `Config file not found. Neither environment variable "${envVar}" is set nor does ${configPath} exist.`
      )
    }
    configPath = path.join(process.cwd(), 'config.json')
  }
  // Expand $HOME if present
  if (configPath.startsWith('$HOME')) {
    const home = process.env.HOME || os.homedir()
    if (!home) {
      throw new Error(
        `"${envVar}" contains $HOME but HOME is not set in the environment.`
      )
    }
    configPath = path.join(home, configPath.slice('$HOME'.length))
  }

  if (!path.isAbsolute(configPath)) {
    throw new Error(
      `Environment variable "${envVar}" must be an absolute path. Got: ${configPath}`
    )
  }

  if (!fs.existsSync(configPath)) {
    throw new Error(`Config file not found at path: ${configPath}`)
  }

  const privateKey = process.env.PRIVATE_KEY
  if (!privateKey || privateKey.length !== 66) {
    // invalid private key
    CONFIG_LOGGER.logMessageWithEmoji(
      'Invalid PRIVATE_KEY env variable..',
      true,
      GENERIC_EMOJIS.EMOJI_CROSS_MARK,
      LOG_LEVELS_STR.LEVEL_ERROR
    )
    return null
  }

  const rawData = fs.readFileSync(configPath, 'utf-8')
  let config: OceanNodeConfig

  try {
    config = JSON.parse(rawData)
  } catch (err) {
    throw new Error(`Invalid JSON in config file: ${configPath}. Error: ${err.message}`)
  }
  if (!previousConfiguration) {
    previousConfiguration = config
  } else if (configChanged(previousConfiguration, config)) {
    CONFIG_LOGGER.warn(
      'Detected Ocean Node Configuration change... This might have unintended effects'
    )
  }
  return config
}

const parseJsonEnv = <T>(env: string | undefined, fallback: T): T => {
  try {
    return env ? JSON.parse(env) : fallback
  } catch {
    return fallback
  }
}

export async function buildMergedConfig(): Promise<OceanNodeConfig> {
  const baseConfig = loadConfigFromEnv()

  let dhtFilterOption
  switch (parseInt(process.env.P2P_DHT_FILTER, 0)) {
    case 1:
      dhtFilterOption = dhtFilterMethod.filterPrivate
      break
    case 2:
      dhtFilterOption = dhtFilterMethod.filterPublic
      break
    default:
      dhtFilterOption = dhtFilterMethod.filterNone
  }

  const privateKey = process.env.PRIVATE_KEY
  if (!privateKey || privateKey.length !== 66) {
    // invalid private key
    CONFIG_LOGGER.logMessageWithEmoji(
      'Invalid PRIVATE_KEY env variable..',
      true,
      GENERIC_EMOJIS.EMOJI_CROSS_MARK,
      LOG_LEVELS_STR.LEVEL_ERROR
    )
    return null
  }

  // Generate keys from private key
  const keys = await getPeerIdFromPrivateKey(privateKey)

  // Transform indexingNetworks from array to object if needed
  let { indexingNetworks } = baseConfig
  if (Array.isArray(indexingNetworks) && baseConfig.supportedNetworks) {
    // Convert array of chain IDs to object by filtering supportedNetworks
    const filteredNetworks: RPCS = {}
    for (const chainId of indexingNetworks) {
      const chainIdStr = String(chainId)
      if (baseConfig.supportedNetworks[chainIdStr]) {
        filteredNetworks[chainIdStr] = baseConfig.supportedNetworks[chainIdStr]
      }
    }
    indexingNetworks = filteredNetworks
  }

  // Process dockerComputeEnvironments
  let { dockerComputeEnvironments } = baseConfig
  if (process.env.DOCKER_COMPUTE_ENVIRONMENTS) {
    // Use environment variable if set
    dockerComputeEnvironments = getDockerComputeEnvironments(true)
  } else if (Array.isArray(dockerComputeEnvironments)) {
    // Validate and process dockerComputeEnvironments from config.json
    const validatedEnvs: C2DDockerConfig[] = []
    for (const config of dockerComputeEnvironments) {
      const validation = validateC2DDockerConfig(config)
      if (!validation.isValid) {
        CONFIG_LOGGER.error(
          'Please check your compute env settings: ' +
            validation.errors +
            'for env: ' +
            JSON.stringify(config)
        )
      } else {
        validatedEnvs.push(config)
      }
    }
    dockerComputeEnvironments = validatedEnvs
  }

  // Use existing function to get c2dClusters, passing the processed dockerComputeEnvironments
  const c2dClusters = getC2DClusterEnvironment(true, dockerComputeEnvironments)

  let interfaces
  if (existsEnvironmentVariable(ENVIRONMENT_VARIABLES.INTERFACES)) {
    try {
      interfaces = JSON.parse(process.env.INTERFACES)
      if (Array.isArray(interfaces) && interfaces.length === 0) {
        interfaces = []
        if (baseConfig.hasHttp) interfaces.push('HTTP')
        if (baseConfig.hasP2P) interfaces.push('P2P')
      }
    } catch (error) {
      CONFIG_LOGGER.logMessageWithEmoji(
        `Invalid "${ENVIRONMENT_VARIABLES.INTERFACES.name}" env variable => ${process.env.INTERFACES}...`,
        true,
        GENERIC_EMOJIS.EMOJI_CROSS_MARK,
        LOG_LEVELS_STR.LEVEL_ERROR
      )
      interfaces = []
      if (baseConfig.hasHttp) interfaces.push('HTTP')
      if (baseConfig.hasP2P) interfaces.push('P2P')
    }
  } else {
    interfaces = []
    if (baseConfig.hasHttp) interfaces.push('HTTP')
    if (baseConfig.hasP2P) interfaces.push('P2P')
  }

  const hasHttp = interfaces.includes('HTTP')
  const hasP2P = interfaces.includes('P2P')

  const supportedNetworks = process.env.RPCS
    ? getSupportedChains()
    : baseConfig.supportedNetworks

  const overrides: Partial<OceanNodeConfig> = {
    keys,
    supportedNetworks,
    indexingNetworks,
    dockerComputeEnvironments,
    c2dClusters,
    ...(process.env.JWT_SECRET && { jwtSecret: process.env.JWT_SECRET }),
    ...(process.env.DB_URL && {
      dbConfig: {
        url: process.env.DB_URL,
        username: process.env.DB_USERNAME ?? baseConfig.dbConfig?.username ?? '',
        password: process.env.DB_PASSWORD ?? baseConfig.dbConfig?.password ?? '',
        dbType: process.env.DB_TYPE ?? baseConfig.dbConfig?.dbType ?? 'elasticsearch'
      }
    }),
    hasHttp,
    hasP2P,
    authorizedDecrypters: process.env.AUTHORIZED_DECRYPTERS
      ? getAuthorizedDecrypters(true)
      : baseConfig.authorizedDecrypters,

    authorizedDecryptersList: process.env.AUTHORIZED_DECRYPTERS_LIST
      ? getAuthorizedDecryptersList(true)
      : baseConfig.authorizedDecryptersList,

    allowedValidators: process.env.ALLOWED_VALIDATORS
      ? getAllowedValidators(true)
      : baseConfig.allowedValidators,

    allowedValidatorsList: process.env.ALLOWED_VALIDATORS_LIST
      ? getAllowedValidatorsList(true)
      : baseConfig.allowedValidatorsList,

    allowedAdmins: process.env.ALLOWED_ADMINS
      ? getAllowedAdmins(true)
      : baseConfig.allowedAdmins,

    allowedAdminsList: process.env.ALLOWED_ADMINS_LIST
      ? getAllowedAdminsList(true)
      : baseConfig.allowedAdminsList,

    authorizedPublishers: process.env.ALLOWED_ADMINS
      ? getAuthorizedPublishers(true)
      : baseConfig.authorizedPublishers,

    authorizedPublishersList: process.env.ALLOWED_ADMINS_LIST
      ? getAuthorizedPublishersList(true)
      : baseConfig.authorizedPublishersList,

    denyList: process.env.RATE_DENY_LIST ? getDenyList(true) : baseConfig.denyList,

    maxConnections: process.env.MAX_CONNECTIONS_PER_MINUTE
      ? getConnectionsLimit(true)
      : baseConfig.maxConnections,

    feeStrategy:
      process.env.FEE_AMOUNT && process.env.FEE_TOKENS
        ? getOceanNodeFees(indexingNetworks, true)
        : baseConfig.feeStrategy,

    rateLimit: process.env.MAX_REQ_PER_MINUTE ? getRateLimit(true) : baseConfig.rateLimit,

    ...(process.env.HTTP_API_PORT && { httpPort: Number(process.env.HTTP_API_PORT) }),

    ...(hasP2P && {
      p2pConfig: {
        ...baseConfig.p2pConfig,

        bootstrapNodes: parseJsonEnv(
          process.env.P2P_BOOTSTRAP_NODES,
          baseConfig.p2pConfig?.bootstrapNodes ?? []
        ),
        bootstrapTimeout: process.env.P2P_BOOTSTRAP_TIMEOUT
          ? parseInt(process.env.P2P_BOOTSTRAP_TIMEOUT, 10)
          : baseConfig.p2pConfig?.bootstrapTimeout,
        bootstrapTagName:
          process.env.P2P_BOOTSTRAP_TAGNAME ?? baseConfig.p2pConfig?.bootstrapTagName,
        bootstrapTagValue: process.env.P2P_BOOTSTRAP_TAGVALUE
          ? parseInt(process.env.P2P_BOOTSTRAP_TAGVALUE, 10)
          : baseConfig.p2pConfig?.bootstrapTagValue,
        bootstrapTTL: process.env.P2P_BOOTSTRAP_TTL
          ? parseInt(process.env.P2P_BOOTSTRAP_TTL, 10)
          : baseConfig.p2pConfig?.bootstrapTTL,

        enableIPV4: process.env.P2P_ENABLE_IPV4
          ? process.env.P2P_ENABLE_IPV4 === 'true'
          : baseConfig.p2pConfig?.enableIPV4,
        enableIPV6: process.env.P2P_ENABLE_IPV6
          ? process.env.P2P_ENABLE_IPV6 === 'true'
          : baseConfig.p2pConfig?.enableIPV6,

        ipV4BindAddress:
          process.env.P2P_IP_V4_BIND_ADDRESS ?? baseConfig.p2pConfig?.ipV4BindAddress,
        ipV4BindTcpPort: process.env.P2P_IP_V4_BIND_TCP_PORT
          ? parseInt(process.env.P2P_IP_V4_BIND_TCP_PORT, 10)
          : baseConfig.p2pConfig?.ipV4BindTcpPort,
        ipV4BindWsPort: process.env.P2P_IP_V4_BIND_WS_PORT
          ? parseInt(process.env.P2P_IP_V4_BIND_WS_PORT, 10)
          : baseConfig.p2pConfig?.ipV4BindWsPort,

        ipV6BindAddress:
          process.env.P2P_IP_V6_BIND_ADDRESS ?? baseConfig.p2pConfig?.ipV6BindAddress,
        ipV6BindTcpPort: process.env.P2P_IP_V6_BIND_TCP_PORT
          ? parseInt(process.env.P2P_IP_V6_BIND_TCP_PORT, 10)
          : baseConfig.p2pConfig?.ipV6BindTcpPort,
        ipV6BindWsPort: process.env.P2P_IP_V6_BIND_WS_PORT
          ? parseInt(process.env.P2P_IP_V6_BIND_WS_PORT, 10)
          : baseConfig.p2pConfig?.ipV6BindWsPort,

        announceAddresses: parseJsonEnv(
          process.env.P2P_ANNOUNCE_ADDRESSES,
          baseConfig.p2pConfig?.announceAddresses ?? []
        ),
        pubsubPeerDiscoveryInterval: process.env.P2P_PUBSUB_PEER_DISCOVERY_INTERVAL
          ? parseInt(process.env.P2P_PUBSUB_PEER_DISCOVERY_INTERVAL, 10)
          : baseConfig.p2pConfig?.pubsubPeerDiscoveryInterval,

        dhtMaxInboundStreams: process.env.P2P_DHT_MAX_INBOUND_STREAMS
          ? parseInt(process.env.P2P_DHT_MAX_INBOUND_STREAMS, 10)
          : baseConfig.p2pConfig?.dhtMaxInboundStreams,
        dhtMaxOutboundStreams: process.env.P2P_DHT_MAX_OUTBOUND_STREAMS
          ? parseInt(process.env.P2P_DHT_MAX_OUTBOUND_STREAMS, 10)
          : baseConfig.p2pConfig?.dhtMaxOutboundStreams,
        dhtFilter: dhtFilterOption ?? baseConfig.p2pConfig?.dhtFilter,

        mDNSInterval: process.env.P2P_MDNS_INTERVAL
          ? parseInt(process.env.P2P_MDNS_INTERVAL, 10)
          : baseConfig.p2pConfig?.mDNSInterval,

        connectionsMaxParallelDials: process.env.P2P_CONNECTIONS_MAX_PARALLEL_DIALS
          ? parseInt(process.env.P2P_CONNECTIONS_MAX_PARALLEL_DIALS, 10)
          : baseConfig.p2pConfig?.connectionsMaxParallelDials,
        connectionsDialTimeout: process.env.P2P_CONNECTIONS_DIAL_TIMEOUT
          ? parseInt(process.env.P2P_CONNECTIONS_DIAL_TIMEOUT, 10)
          : baseConfig.p2pConfig?.connectionsDialTimeout,

        upnp: process.env.P2P_ENABLE_UPNP
          ? process.env.P2P_ENABLE_UPNP === 'true'
          : baseConfig.p2pConfig?.upnp,
        autoNat: process.env.P2P_ENABLE_AUTONAT
          ? process.env.P2P_ENABLE_AUTONAT === 'true'
          : baseConfig.p2pConfig?.autoNat,

        enableCircuitRelayServer: process.env.P2P_ENABLE_CIRCUIT_RELAY_SERVER
          ? process.env.P2P_ENABLE_CIRCUIT_RELAY_SERVER === 'true'
          : baseConfig.p2pConfig?.enableCircuitRelayServer,
        enableCircuitRelayClient: process.env.P2P_ENABLE_CIRCUIT_RELAY_CLIENT
          ? process.env.P2P_ENABLE_CIRCUIT_RELAY_CLIENT === 'true'
          : baseConfig.p2pConfig?.enableCircuitRelayClient,

        circuitRelays: process.env.P2P_CIRCUIT_RELAYS
          ? parseInt(process.env.P2P_CIRCUIT_RELAYS, 10)
          : baseConfig.p2pConfig?.circuitRelays,
        announcePrivateIp: process.env.P2P_ANNOUNCE_PRIVATE
          ? process.env.P2P_ANNOUNCE_PRIVATE === 'true'
          : baseConfig.p2pConfig?.announcePrivateIp,

        filterAnnouncedAddresses: parseJsonEnv(
          process.env.P2P_FILTER_ANNOUNCED_ADDRESSES,
          baseConfig.p2pConfig?.filterAnnouncedAddresses ?? []
        ),

        minConnections: process.env.P2P_MIN_CONNECTIONS
          ? parseInt(process.env.P2P_MIN_CONNECTIONS, 10)
          : baseConfig.p2pConfig?.minConnections,
        maxConnections: process.env.P2P_MAX_CONNECTIONS
          ? parseInt(process.env.P2P_MAX_CONNECTIONS, 10)
          : baseConfig.p2pConfig?.maxConnections,

        autoDialPeerRetryThreshold: process.env.P2P_AUTODIAL_PEER_RETRY_THRESHOLD
          ? parseInt(process.env.P2P_AUTODIAL_PEER_RETRY_THRESHOLD, 10)
          : baseConfig.p2pConfig?.autoDialPeerRetryThreshold,
        autoDialConcurrency: process.env.P2P_AUTODIAL_CONCURRENCY
          ? parseInt(process.env.P2P_AUTODIAL_CONCURRENCY, 10)
          : baseConfig.p2pConfig?.autoDialConcurrency,
        maxPeerAddrsToDial: process.env.P2P_MAX_PEER_ADDRS_TO_DIAL
          ? parseInt(process.env.P2P_MAX_PEER_ADDRS_TO_DIAL, 10)
          : baseConfig.p2pConfig?.maxPeerAddrsToDial,
        autoDialInterval: process.env.P2P_AUTODIAL_INTERVAL
          ? parseInt(process.env.P2P_AUTODIAL_INTERVAL, 10)
          : baseConfig.p2pConfig?.autoDialInterval,

        enableNetworkStats: process.env.P2P_ENABLE_NETWORK_STATS
          ? process.env.P2P_ENABLE_NETWORK_STATS === 'true'
          : baseConfig.p2pConfig?.enableNetworkStats
      }
    }),

    ...(process.env.CONTROL_PANEL && {
      hasControlPanel: process.env.CONTROL_PANEL !== 'false'
    }),
    ...(process.env.RPCS && {
      supportedNetworks: parseJsonEnv(
        process.env.RPCS,
        baseConfig.supportedNetworks ?? {}
      )
    }),
    ...(process.env.C2D_NODE_URI && { c2dNodeUri: process.env.C2D_NODE_URI }),
    ...(process.env.ACCOUNT_PURGATORY_URL && {
      accountPurgatoryUrl: process.env.ACCOUNT_PURGATORY_URL
    }),
    ...(process.env.ASSET_PURGATORY_URL && {
      assetPurgatoryUrl: process.env.ASSET_PURGATORY_URL
    }),
    ...(process.env.UNSAFE_URLS && {
      unsafeURLs: parseJsonEnv(process.env.UNSAFE_URLS, baseConfig.unsafeURLs ?? [])
    }),
    ...(process.env.IS_BOOTSTRAP && { isBootstrap: process.env.IS_BOOTSTRAP === 'true' }),
    ...(process.env.ESCROW_CLAIM_TIMEOUT && {
      claimDurationTimeout: parseInt(process.env.ESCROW_CLAIM_TIMEOUT, 10)
    }),
    ...(process.env.VALIDATE_UNSIGNED_DDO && {
      validateUnsignedDDO: process.env.VALIDATE_UNSIGNED_DDO === 'true'
    })
  }

  const merged = {
    ...baseConfig,
    ...overrides
  }

  return OceanNodeConfigSchema.parse(merged) as OceanNodeConfig
}

function configChanged(previous: OceanNodeConfig, current: OceanNodeConfig): boolean {
  return JSON.stringify(previous) !== JSON.stringify(current)
}

// useful for debugging purposes
export async function printCurrentConfig() {
  const conf = await getConfiguration(true)
  conf.keys.privateKey = '[*** HIDDEN CONTENT ***]' // hide private key
  console.log(JSON.stringify(conf, null, 4))
}

// P2P routes related
export const hasP2PInterface = (await (await getConfiguration())?.hasP2P) || false

// is there a policy server defined?
export function isPolicyServerConfigured(): boolean {
  return isDefined(process.env.POLICY_SERVER_URL)
}
