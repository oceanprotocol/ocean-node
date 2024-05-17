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
import type { PeerId } from '@libp2p/interface/peer-id'

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
  const id: PeerId = await createFromPrivKey(key)

  return {
    peerId: id,
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

function getP2PAnnounceAddresses(isStartup?: boolean): string[] {
  return readListFromEnvVariable(ENVIRONMENT_VARIABLES.P2P_ANNOUNCE_ADDRESSES, isStartup)
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
function readListFromEnvVariable(envVariable: any, isStartup?: boolean): string[] {
  const { name } = envVariable
  try {
    if (!existsEnvironmentVariable(envVariable, isStartup)) {
      return []
    }
    const addressesRaw: string[] = JSON.parse(process.env[name])
    if (!Array.isArray(addressesRaw)) {
      CONFIG_LOGGER.logMessageWithEmoji(
        `Invalid ${name} env variable format`,
        true,
        GENERIC_EMOJIS.EMOJI_CROSS_MARK,
        LOG_LEVELS_STR.LEVEL_ERROR
      )
      return []
    }
    return addressesRaw
  } catch (error) {
    CONFIG_LOGGER.logMessageWithEmoji(
      `Missing or Invalid address(es) in ${name} env variable`,
      true,
      GENERIC_EMOJIS.EMOJI_CROSS_MARK,
      LOG_LEVELS_STR.LEVEL_ERROR
    )
    return []
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
    hasIndexer: !!(!!getEnvValue(process.env.DB_URL, '') && !!supportedNetworks),
    hasHttp: interfaces.includes('HTTP'),
    hasP2P: interfaces.includes('P2P'),
    p2pConfig: {
      bootstrapNodes: [
        // Public IPFS bootstraps
        // '/ip4/104.131.131.82/tcp/4001/ipfs/QmaCpDMGvV2BGHeYERUEnRQAwe3N8SzbUtfsmvsqQLuvuJ',
        // '/dnsaddr/bootstrap.libp2p.io/ipfs/QmNnooDu7bfjPFoTZYxMNLWUQJyrVwtbZg5gBMjTezGAJN',
        // '/dnsaddr/bootstrap.libp2p.io/ipfs/QmQCU2EcMqAqQPR2i9bChDtGNJchTbq5TbXJJ16u19uLTa',
        // OPF nodes
        // '/dns4/node1.oceanprotocol.com/tcp/9000/p2p/'
        '/dns4/node2.oceanprotocol.com/tcp/9000/p2p/16Uiu2HAm6u88XuC4Xke7J9NmT7qLNL4zMYEyLxqdVgAc7Rnr95o6'
        // '/dns4/node3.oceanprotocol.com/tcp/9000/p2p/'
        // OPF developer nodes
        // '/ip4/35.198.125.13/tcp/8000/p2p/16Uiu2HAmKZuuY2Lx3JiY938rJWZrYQh6kjBZCNrh3ALkodtwFRdF', // paulo
        // '/ip4/35.209.77.64/tcp/8000/p2p/16Uiu2HAmFxPwhW5dmoLZnbqXFyUvr6j1PzCB1mBxRUZHGsoqQoSQ',
        // '/ip4/34.107.3.14/tcp/8000/p2p/16Uiu2HAm4DWmX56ZX2bKjvARJQZPMUZ9xsdtAfrMmd7P8czcN4UT', // maria
        // '/dnsaddr/ocean-node3.oceanprotocol.io/tcp/8000/p2p/16Uiu2HAm96Sx6o8XCEifPL9MtJiZCSzKqiBQApnZ6JWd7be4zwNK' // bogdan
      ],
      ipV4BindAddress: getEnvValue(process.env.P2P_ipV4BindAddress, '0.0.0.0'),
      ipV4BindTcpPort: getIntEnvValue(process.env.P2P_ipV4BindTcpPort, 0),
      ipV4BindWsPort: getIntEnvValue(process.env.P2P_ipV4BindWsPort, 0),
      ipV6BindAddress: getEnvValue(process.env.P2P_ipV6BindAddress, '::1'),
      ipV6BindTcpPort: getIntEnvValue(process.env.P2P_ipV6BindTcpPort, 0),
      ipV6BindWsPort: getIntEnvValue(process.env.P2P_ipV6BindWsPort, 0),
      announceAddresses: getP2PAnnounceAddresses(isStartup),
      pubsubPeerDiscoveryInterval: getIntEnvValue(
        process.env.P2P_pubsubPeerDiscoveryInterval,
        1000
      ),
      dhtMaxInboundStreams: getIntEnvValue(process.env.P2P_dhtMaxInboundStreams, 500),
      dhtMaxOutboundStreams: getIntEnvValue(process.env.P2P_dhtMaxOutboundStreams, 500),
      mDNSInterval: getIntEnvValue(process.env.P2P_mDNSInterval, 20e3), // 20 seconds
      connectionsMaxParallelDials: getIntEnvValue(
        process.env.P2P_connectionsMaxParallelDials,
        150
      ),
      connectionsDialTimeout: getIntEnvValue(
        process.env.P2P_connectionsDialTimeout,
        30e3
      ), // 10 seconds
      upnp: true,
      autoNat: true,
      enableCircuitRelayServer: true
    },
    // Only enable provider if we have a DB_URL
    hasProvider: !!getEnvValue(process.env.DB_URL, ''),
    hasDashboard: process.env.DASHBOARD !== 'false',
    httpPort: getIntEnvValue(process.env.HTTP_API_PORT, 8000),
    dbConfig: {
      url: getEnvValue(process.env.DB_URL, '')
    },
    supportedNetworks,
    feeStrategy: getOceanNodeFees(supportedNetworks, isStartup),
    c2dClusters: getC2DClusterEnvironment(isStartup),
    accountPurgatoryUrl: getEnvValue(process.env.ACCOUNT_PURGATORY_URL, ''),
    assetPurgatoryUrl: getEnvValue(process.env.ASSET_PURGATORY_URL, ''),
    allowedAdmins: getAllowedAdmins(isStartup),
    rateLimit: getRateLimit(isStartup),
    denyList: getDenyList(isStartup)
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
