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
  defaultBootstrapAddresses,
  knownUnsafeURLs
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

function getEnvValue(env: any, defaultValue: any) {
  /* Gets value for an ENV var, returning defaultValue if not defined */
  if (env === null || env === undefined || (env as string).length === 0) {
    return defaultValue
  }
  return env as string
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
  if (!process.env.RPCS) {
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

function getIndexingNetworks(supportedNetworks: RPCS): RPCS | null {
  const indexerNetworksEnv = process.env.INDEXER_NETWORKS

  const defaultErrorMsg =
    'Missing or invalid "INDEXER_NETWORKS" variable. Running Indexer with all supported networks defined in RPCS env variable...'
  if (!indexerNetworksEnv) {
    CONFIG_LOGGER.logMessageWithEmoji(
      defaultErrorMsg,
      true,
      GENERIC_EMOJIS.EMOJI_CHECK_MARK,
      LOG_LEVELS_STR.LEVEL_INFO
    )
    return supportedNetworks
  }
  try {
    const indexerNetworks: number[] = JSON.parse(indexerNetworksEnv)

    // env var exists but is wrong, so it does not index anything, but we still log the error
    if (indexerNetworks.length === 0) {
      CONFIG_LOGGER.logMessageWithEmoji(
        '"INDEXER_NETWORKS" is an empty array, Running node without the Indexer component...',
        true,
        GENERIC_EMOJIS.EMOJI_CROSS_MARK,
        LOG_LEVELS_STR.LEVEL_ERROR
      )
      return null
    }

    // Use reduce to filter supportedNetworks
    const filteredNetworks = indexerNetworks.reduce((acc: RPCS, chainId) => {
      if (supportedNetworks[chainId]) {
        acc[chainId] = supportedNetworks[chainId]
      }
      return acc
    }, {})

    // if variables are not aligned we might end up not running indexer at all, so at least we should log a warning
    if (Object.keys(filteredNetworks).length === 0) {
      CONFIG_LOGGER.logMessageWithEmoji(
        `"RPCS" chains: "${Object.keys(
          supportedNetworks
        )}" and "INDEXER_NETWORKS" chains: "${indexerNetworks}" mismatch! Running node without the Indexer component...`,
        true,
        GENERIC_EMOJIS.EMOJI_CROSS_MARK,
        LOG_LEVELS_STR.LEVEL_ERROR
      )
    }
    return filteredNetworks
  } catch (e) {
    CONFIG_LOGGER.logMessageWithEmoji(
      defaultErrorMsg,
      true,
      GENERIC_EMOJIS.EMOJI_CROSS_MARK,
      LOG_LEVELS_STR.LEVEL_ERROR
    )
    return supportedNetworks
  }
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
      nodeFeesAmount = JSON.parse(process.env.FEE_AMOUNT) as FeeAmount
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
function getC2DClusterEnvironment(isStartup?: boolean): C2DClusterInfo[] {
  const clusters: C2DClusterInfo[] = []
  // avoid log too much (too much noise on tests as well), this is not even required
  if (existsEnvironmentVariable(ENVIRONMENT_VARIABLES.OPERATOR_SERVICE_URL, isStartup)) {
    try {
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
    } catch (error) {
      CONFIG_LOGGER.logMessageWithEmoji(
        `Invalid or missing "${ENVIRONMENT_VARIABLES.OPERATOR_SERVICE_URL.name}" env variable => ${process.env.OPERATOR_SERVICE_URL}...`,
        true,
        GENERIC_EMOJIS.EMOJI_CROSS_MARK,
        LOG_LEVELS_STR.LEVEL_ERROR
      )
    }
  }
  const dockerC2Ds = getDockerComputeEnvironments(isStartup)
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

  return clusters
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
        let errors = ''
        if (!isDefined(config.fees)) {
          errors += ' There is no fees configuration!'
        }

        if (config.storageExpiry < config.maxJobDuration) {
          errors += ' "storageExpiry" should be greater than "maxJobDuration"! '
        }
        // for docker there is no way of getting storage space
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
          errors += ' There is no "disk" resource configured.This is mandatory '
        }
        if (errors.length > 1) {
          CONFIG_LOGGER.error(
            'Please check your compute env settings: ' +
              errors +
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

// connect interfaces (p2p or/and http)
function getNodeInterfaces(isStartup: boolean = false) {
  let interfaces: string[] = ['P2P', 'HTTP']
  if (!existsEnvironmentVariable(ENVIRONMENT_VARIABLES.INTERFACES)) {
    if (isStartup) {
      logMissingVariableWithDefault(ENVIRONMENT_VARIABLES.INTERFACES)
    }
  } else {
    try {
      interfaces = JSON.parse(process.env.INTERFACES) as string[]
      if (interfaces.length === 0) {
        return ['P2P', 'HTTP']
      }
    } catch (err) {
      CONFIG_LOGGER.logMessageWithEmoji(
        `Invalid "${ENVIRONMENT_VARIABLES.INTERFACES.name}" env variable => ${process.env.INTERFACES}. Will use defaults...`,
        true,
        GENERIC_EMOJIS.EMOJI_CROSS_MARK,
        LOG_LEVELS_STR.LEVEL_ERROR
      )
    }
  }
  // make it case insensitive
  return interfaces.map((iface: string) => {
    return iface.toUpperCase()
  })
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
    if (!process.env.CONFIG_PATH) {
      previousConfiguration = await getEnvConfig(isStartup)
    } else {
      CONFIG_LOGGER.logMessage(`entered here`)
      previousConfiguration = loadConfigFromEnv()
    }
  }
  if (!previousConfiguration.codeHash) {
    const __filename = fileURLToPath(import.meta.url)
    const __dirname = path.dirname(__filename.replace('utils/', ''))
    previousConfiguration.codeHash = await computeCodebaseHash(__dirname)
  }

  return previousConfiguration
}

export function loadConfigFromEnv(envVar: string = 'CONFIG_PATH'): OceanNodeConfig {
  CONFIG_LOGGER.logMessage(`entered here 2`)
  const configPath = process.env[envVar]
  if (!configPath) {
    throw new Error(`Environment variable "${envVar}" is not set.`)
  }
  const __filename = fileURLToPath(import.meta.url)
  const __dirname = path.dirname(__filename)

  // If the path is absolute, keep it; otherwise resolve relative to project root
  const absolutePath = path.isAbsolute(configPath)
    ? configPath
    : path.resolve(__dirname, configPath)

  if (!fs.existsSync(absolutePath)) {
    throw new Error(`Config file not found at path: ${absolutePath}`)
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

  const rawData = fs.readFileSync(absolutePath, 'utf-8')
  let config: OceanNodeConfig

  try {
    config = JSON.parse(rawData)
  } catch (err) {
    throw new Error(`Invalid JSON in config file: ${absolutePath}. Error: ${err.message}`)
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

// we can just use the lazy version above "getConfiguration()" and specify if we want to reload from .env variables
async function getEnvConfig(isStartup?: boolean): Promise<OceanNodeConfig> {
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

  const supportedNetworks = getSupportedChains()
  const indexingNetworks = supportedNetworks
    ? getIndexingNetworks(supportedNetworks)
    : null
  // Notes: we need to have this config on the class and use always that, otherwise we're processing
  // all this info every time we call getConfig(), and also loggin too much

  const keys = await getPeerIdFromPrivateKey(privateKey)
  // do not log this information everytime we call getConfig()
  if (isStartup) {
    CONFIG_LOGGER.logMessageWithEmoji(
      'Starting node with peerID: ' + keys.peerId,
      true,
      GENERIC_EMOJIS.EMOJI_CHECK_MARK
    )
  }

  // http and/or p2p connections
  const interfaces = getNodeInterfaces(isStartup)
  let bootstrapTtl = getIntEnvValue(process.env.P2P_BOOTSTRAP_TTL, 120000)
  if (bootstrapTtl === 0) bootstrapTtl = Infinity
  let dhtFilterOption
  switch (getIntEnvValue(process.env.P2P_DHT_FILTER, 0)) {
    case 1:
      dhtFilterOption = dhtFilterMethod.filterPrivate
      break
    case 2:
      dhtFilterOption = dhtFilterMethod.filterPublic
      break
    default:
      dhtFilterOption = dhtFilterMethod.filterNone
  }

  const config: OceanNodeConfig = {
    authorizedDecrypters: getAuthorizedDecrypters(isStartup),
    authorizedDecryptersList: getAuthorizedDecryptersList(isStartup),
    allowedValidators: getAllowedValidators(isStartup),
    allowedValidatorsList: getAllowedValidatorsList(isStartup),
    authorizedPublishers: getAuthorizedPublishers(isStartup),
    authorizedPublishersList: getAuthorizedPublishersList(isStartup),
    keys,
    // Only enable indexer if we have a DB_URL and supportedNetworks
    hasIndexer: !!(!!getEnvValue(process.env.DB_URL, '') && !!indexingNetworks),
    hasHttp: interfaces.includes('HTTP'),
    hasP2P: interfaces.includes('P2P'),
    p2pConfig: {
      bootstrapNodes: readListFromEnvVariable(
        ENVIRONMENT_VARIABLES.P2P_BOOTSTRAP_NODES,
        isStartup,
        defaultBootstrapAddresses
      ),
      bootstrapTimeout: getIntEnvValue(process.env.P2P_BOOTSTRAP_TIMEOUT, 20000),
      bootstrapTagName: getEnvValue(process.env.P2P_BOOTSTRAP_TAGNAME, 'bootstrap'),
      bootstrapTagValue: getIntEnvValue(process.env.P2P_BOOTSTRAP_TAGVALUE, 50),
      bootstrapTTL: bootstrapTtl,
      enableIPV4: getBoolEnvValue('P2P_ENABLE_IPV4', true),
      enableIPV6: getBoolEnvValue('P2P_ENABLE_IPV6', true),
      ipV4BindAddress: getEnvValue(process.env.P2P_ipV4BindAddress, '0.0.0.0'),
      ipV4BindTcpPort: getIntEnvValue(process.env.P2P_ipV4BindTcpPort, 0),
      ipV4BindWsPort: getIntEnvValue(process.env.P2P_ipV4BindWsPort, 0),
      ipV6BindAddress: getEnvValue(process.env.P2P_ipV6BindAddress, '::1'),
      ipV6BindTcpPort: getIntEnvValue(process.env.P2P_ipV6BindTcpPort, 0),
      ipV6BindWsPort: getIntEnvValue(process.env.P2P_ipV6BindWsPort, 0),
      announceAddresses: readListFromEnvVariable(
        ENVIRONMENT_VARIABLES.P2P_ANNOUNCE_ADDRESSES,
        isStartup
      ),
      pubsubPeerDiscoveryInterval: getIntEnvValue(
        process.env.P2P_pubsubPeerDiscoveryInterval,
        10000 // every 10 seconds
      ),
      dhtMaxInboundStreams: getIntEnvValue(process.env.P2P_dhtMaxInboundStreams, 500),
      dhtMaxOutboundStreams: getIntEnvValue(process.env.P2P_dhtMaxOutboundStreams, 500),
      dhtFilter: dhtFilterOption,
      mDNSInterval: getIntEnvValue(process.env.P2P_mDNSInterval, 20e3), // 20 seconds
      connectionsMaxParallelDials: getIntEnvValue(
        process.env.P2P_connectionsMaxParallelDials,
        15
      ),
      connectionsDialTimeout: getIntEnvValue(
        process.env.P2P_connectionsDialTimeout,
        30e3
      ), // 10 seconds,
      upnp: getBoolEnvValue('P2P_ENABLE_UPNP', true),
      autoNat: getBoolEnvValue('P2P_ENABLE_AUTONAT', true),
      enableCircuitRelayServer: getBoolEnvValue('P2P_ENABLE_CIRCUIT_RELAY_SERVER', false),
      enableCircuitRelayClient: getBoolEnvValue('P2P_ENABLE_CIRCUIT_RELAY_CLIENT', false),
      circuitRelays: getIntEnvValue(process.env.P2P_CIRCUIT_RELAYS, 0),
      announcePrivateIp: getBoolEnvValue('P2P_ANNOUNCE_PRIVATE', false),
      filterAnnouncedAddresses: readListFromEnvVariable(
        ENVIRONMENT_VARIABLES.P2P_FILTER_ANNOUNCED_ADDRESSES,
        isStartup,
        [
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
        ] // list of all non-routable IP addresses, not availabe from public internet, private networks or specific reserved use
      ),
      minConnections: getIntEnvValue(process.env.P2P_MIN_CONNECTIONS, 1),
      maxConnections: getIntEnvValue(process.env.P2P_MAX_CONNECTIONS, 300),
      autoDialPeerRetryThreshold: getIntEnvValue(
        process.env.P2P_AUTODIALPEERRETRYTHRESHOLD,
        1000 * 120
      ),
      autoDialConcurrency: getIntEnvValue(process.env.P2P_AUTODIALCONCURRENCY, 5),
      maxPeerAddrsToDial: getIntEnvValue(process.env.P2P_MAXPEERADDRSTODIAL, 5),
      autoDialInterval: getIntEnvValue(process.env.P2P_AUTODIALINTERVAL, 5000),
      enableNetworkStats: getBoolEnvValue('P2P_ENABLE_NETWORK_STATS', false)
    },
    // keep this for backwards compatibility for now
    hasControlPanel:
      process.env.CONTROL_PANEL !== 'false' || process.env.DASHBOARD !== 'false',
    httpPort: getIntEnvValue(process.env.HTTP_API_PORT, 8000),
    dbConfig: {
      url: getEnvValue(process.env.DB_URL, ''),
      username: getEnvValue(process.env.DB_USERNAME, ''),
      password: getEnvValue(process.env.DB_PASSWORD, ''),
      dbType: getEnvValue(process.env.DB_TYPE, null)
    },
    supportedNetworks,
    indexingNetworks,
    feeStrategy: getOceanNodeFees(supportedNetworks, isStartup),
    c2dClusters: getC2DClusterEnvironment(isStartup),
    c2dNodeUri: getEnvValue(process.env.C2D_NODE_URI, ''),
    accountPurgatoryUrl: getEnvValue(process.env.ACCOUNT_PURGATORY_URL, ''),
    assetPurgatoryUrl: getEnvValue(process.env.ASSET_PURGATORY_URL, ''),
    allowedAdmins: getAllowedAdmins(isStartup),
    allowedAdminsList: getAllowedAdminsList(isStartup),
    rateLimit: getRateLimit(isStartup),
    maxConnections: getConnectionsLimit(isStartup),
    denyList: getDenyList(isStartup),
    unsafeURLs: readListFromEnvVariable(
      ENVIRONMENT_VARIABLES.UNSAFE_URLS,
      isStartup,
      knownUnsafeURLs
    ),
    isBootstrap: getBoolEnvValue('IS_BOOTSTRAP', false),
    claimDurationTimeout: getIntEnvValue(process.env.ESCROW_CLAIM_TIMEOUT, 600),
    validateUnsignedDDO: getBoolEnvValue('VALIDATE_UNSIGNED_DDO', true),
    jwtSecret: getEnvValue(process.env.JWT_SECRET, 'ocean-node-secret')
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
