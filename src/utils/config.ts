import type { DenyList, OceanNodeConfig, OceanNodeKeys } from '../@types/OceanNode'
import type { C2DClusterInfo } from '../@types/C2D.js'
import { C2DClusterType } from '../@types/C2D.js'
import { createFromPrivKey } from '@libp2p/peer-id-factory'
import { keys } from '@libp2p/crypto'
import {
  DEFAULT_RATE_LIMIT_PER_SECOND,
  ENVIRONMENT_VARIABLES,
  EnvVariable,
  hexStringToByteArray
} from '../utils/index.js'
import { defaultBootstrapAddresses, knownUnsafeURLs } from '../utils/constants.js'

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
  return env != null ? (env as string) : defaultValue
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
  if (!indexerNetworksEnv) {
    CONFIG_LOGGER.logMessageWithEmoji(
      'INDEXER_NETWORKS is not defined, running Indexer with all supported networks defined in RPCS env variable ...',
      true,
      GENERIC_EMOJIS.EMOJI_CROSS_MARK,
      LOG_LEVELS_STR.LEVEL_ERROR
    )
    return supportedNetworks
  }
  try {
    const indexerNetworks: number[] = JSON.parse(indexerNetworksEnv)

    if (indexerNetworks.length === 0) {
      CONFIG_LOGGER.logMessageWithEmoji(
        'INDEXER_NETWORKS is an empty array, Running node without the Indexer component...',
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

    return filteredNetworks
  } catch (e) {
    CONFIG_LOGGER.logMessageWithEmoji(
      'Missing or Invalid INDEXER_NETWORKS env variable format,running Indexer with all supported networks defined in RPCS env variable ...',
      true,
      GENERIC_EMOJIS.EMOJI_CROSS_MARK,
      LOG_LEVELS_STR.LEVEL_ERROR
    )
    return supportedNetworks
  }
}
// valid decrypthers
function getAuthorizedDecrypters(isStartup?: boolean): string[] {
  return readAddressListFromEnvVariable(
    ENVIRONMENT_VARIABLES.AUTHORIZED_DECRYPTERS,
    isStartup
  )
}
// allowed validators
export function getAllowedValidators(isStartup?: boolean): string[] {
  return readAddressListFromEnvVariable(
    ENVIRONMENT_VARIABLES.ALLOWED_VALIDATORS,
    isStartup
  )
}
// valid node admins
export function getAllowedAdmins(isStartup?: boolean): string[] {
  return readAddressListFromEnvVariable(ENVIRONMENT_VARIABLES.ALLOWED_ADMINS, isStartup)
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
          url: theURL,
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

  return clusters
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
// have a rate limit for handler calls
function getRateLimit(isStartup: boolean = false) {
  if (!existsEnvironmentVariable(ENVIRONMENT_VARIABLES.MAX_REQ_PER_SECOND)) {
    if (isStartup) {
      logMissingVariableWithDefault(ENVIRONMENT_VARIABLES.MAX_REQ_PER_SECOND)
    }
    return DEFAULT_RATE_LIMIT_PER_SECOND
  } else {
    try {
      return getIntEnvValue(process.env.MAX_REQ_PER_SECOND, DEFAULT_RATE_LIMIT_PER_SECOND)
    } catch (err) {
      CONFIG_LOGGER.error(
        `Invalid "${ENVIRONMENT_VARIABLES.MAX_REQ_PER_SECOND.name}" env variable...`
      )
      return DEFAULT_RATE_LIMIT_PER_SECOND
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
    previousConfiguration = await getEnvConfig(isStartup)
  }
  return previousConfiguration
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

  const config: OceanNodeConfig = {
    authorizedDecrypters: getAuthorizedDecrypters(isStartup),
    allowedValidators: getAllowedValidators(isStartup),
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
      enableDHTServer: getBoolEnvValue(process.env.P2P_ENABLE_DHT_SERVER, false),
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
        ['172.15.0.0/24']
      ),
      minConnections: getIntEnvValue(process.env.P2P_MIN_CONNECTIONS, 1),
      maxConnections: getIntEnvValue(process.env.P2P_MAX_CONNECTIONS, 300),
      autoDialPeerRetryThreshold: getIntEnvValue(
        process.env.P2P_AUTODIALPEERRETRYTHRESHOLD,
        1000 * 120
      ),
      autoDialConcurrency: getIntEnvValue(process.env.P2P_AUTODIALCONCURRENCY, 5),
      maxPeerAddrsToDial: getIntEnvValue(process.env.P2P_MAXPEERADDRSTODIAL, 5),
      autoDialInterval: getIntEnvValue(process.env.P2P_AUTODIALINTERVAL, 5000)
    },
    hasDashboard: process.env.DASHBOARD !== 'false',
    httpPort: getIntEnvValue(process.env.HTTP_API_PORT, 8000),
    dbConfig: {
      url: getEnvValue(process.env.DB_URL, '')
    },
    supportedNetworks,
    indexingNetworks,
    feeStrategy: getOceanNodeFees(supportedNetworks, isStartup),
    c2dClusters: getC2DClusterEnvironment(isStartup),
    c2dNodeUri: getEnvValue(process.env.C2D_NODE_URI, ''),
    accountPurgatoryUrl: getEnvValue(process.env.ACCOUNT_PURGATORY_URL, ''),
    assetPurgatoryUrl: getEnvValue(process.env.ASSET_PURGATORY_URL, ''),
    allowedAdmins: getAllowedAdmins(isStartup),
    rateLimit: getRateLimit(isStartup),
    denyList: getDenyList(isStartup),
    unsafeURLs: readListFromEnvVariable(
      ENVIRONMENT_VARIABLES.UNSAFE_URLS,
      isStartup,
      knownUnsafeURLs
    )
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
  console.log(JSON.stringify(conf, null, 4))
}
