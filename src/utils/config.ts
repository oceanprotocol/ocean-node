import type { OceanNodeConfig, OceanNodeKeys } from '../@types/OceanNode'
import { createFromPrivKey } from '@libp2p/peer-id-factory'
import { keys } from '@libp2p/crypto'
import { ENVIRONMENT_VARIABLES, hexStringToByteArray } from '../utils/index.js'
import type { PeerId } from '@libp2p/interface/peer-id'

import {
  CustomNodeLogger,
  LOGGER_MODULE_NAMES,
  LOG_LEVELS_STR,
  defaultConsoleTransport,
  getCustomLoggerForModule,
  GENERIC_EMOJIS,
  getLoggerLevelEmoji
} from '../utils/logging/Logger.js'
import { RPCS } from '../@types/blockchain'
import { Wallet } from 'ethers'
import { FeeStrategy, FeeTokens, FeeAmount } from '../@types/Fees'
import {
  OCEAN_ARTIFACTS_ADDRESSES_PER_CHAIN,
  getOceanArtifactsAdresses
} from '../utils/address.js'

const CONFIG_CONSOLE_LOGGER: CustomNodeLogger = getCustomLoggerForModule(
  LOGGER_MODULE_NAMES.CONFIG,
  LOG_LEVELS_STR.LEVEL_INFO,
  defaultConsoleTransport
)

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

function getSupportedChains(): RPCS {
  if (!process.env.RPCS || !JSON.parse(process.env.RPCS)) {
    // missing or invalid RPC list
    CONFIG_CONSOLE_LOGGER.logMessageWithEmoji(
      'Missing or Invalid RPCS env variable format ..',
      true,
      GENERIC_EMOJIS.EMOJI_CROSS_MARK,
      LOG_LEVELS_STR.LEVEL_ERROR
    )
    return
  }
  const supportedNetworks: RPCS = JSON.parse(process.env.RPCS)
  return supportedNetworks
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
    CONFIG_CONSOLE_LOGGER.logMessageWithEmoji(
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
        CONFIG_CONSOLE_LOGGER.log(
          LOG_LEVELS_STR.LEVEL_WARN,
          `Missing "${ENVIRONMENT_VARIABLES.FEE_AMOUNT.name}" env variable. Will use defaults...`,
          true
        )
      }

      nodeFeesAmount = { amount: 0, unit: 'MB' }
    } else {
      nodeFeesAmount = JSON.parse(process.env.FEE_AMOUNT) as FeeAmount
    }
    if (!existsEnvironmentVariable(ENVIRONMENT_VARIABLES.FEE_TOKENS)) {
      // try to get first for artifacts address if available
      if (isStartup) {
        CONFIG_CONSOLE_LOGGER.log(
          LOG_LEVELS_STR.LEVEL_WARN,
          `Missing "${ENVIRONMENT_VARIABLES.FEE_TOKENS.name}" env variable. Will use defaults...`,
          true
        )
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

/**
 * checks if a var is defined on env
 * @param envVariable check utils/constants ENVIRONMENT_VARIABLES
 * @param hasDefault if true we ignore if not set
 * @returns boolean
 */
function existsEnvironmentVariable(envVariable: any, log = false): boolean {
  const { name, value, required } = envVariable
  if (!value) {
    if (log) {
      CONFIG_CONSOLE_LOGGER.logMessageWithEmoji(
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
export async function getConfig(isStartup?: boolean): Promise<OceanNodeConfig> {
  const privateKey = process.env.PRIVATE_KEY
  if (!privateKey || privateKey.length !== 66) {
    // invalid private key
    CONFIG_CONSOLE_LOGGER.logMessageWithEmoji(
      'Invalid PRIVATE_KEY env variable..',
      true,
      GENERIC_EMOJIS.EMOJI_CROSS_MARK,
      LOG_LEVELS_STR.LEVEL_ERROR
    )
    return null
  }

  if (
    // these will not be required in the future
    !existsEnvironmentVariable(ENVIRONMENT_VARIABLES.IPFS_GATEWAY, isStartup) ||
    !existsEnvironmentVariable(ENVIRONMENT_VARIABLES.ARWEAVE_GATEWAY, isStartup)
    // have some defaults for these ones:
    // ENVIRONMENT_VARIABLES.FEE_TOKENS
    // ENVIRONMENT_VARIABLES.FEE_AMOUNT
  ) {
    return null
  }

  const supportedNetworks = getSupportedChains()
  // Notes: we need to have this config on the class and use always that, otherwise we're processing
  // all this info every time we call getConfig(), and also loggin too much

  const keys = await getPeerIdFromPrivateKey(privateKey)
  // do not log this information everytime we call getConfig()
  if (isStartup) {
    CONFIG_CONSOLE_LOGGER.logMessageWithEmoji(
      'Starting node with peerID: ' + keys.peerId,
      true,
      GENERIC_EMOJIS.EMOJI_CHECK_MARK
    )
  }

  const config: OceanNodeConfig = {
    keys,
    hasIndexer: true,
    hasHttp: true,
    hasP2P: true,
    p2pConfig: {
      ipV4BindAddress: getEnvValue(process.env.P2P_ipV4BindAddress, '0.0.0.0'),
      ipV4BindTcpPort: getIntEnvValue(process.env.P2P_ipV4BindTcpPort, 0),
      ipV4BindWsPort: getIntEnvValue(process.env.P2P_ipV4BindWsPort, 0),
      ipV6BindAddress: getEnvValue(process.env.P2P_ipV6BindAddress, '::1'),
      ipV6BindTcpPort: getIntEnvValue(process.env.P2P_ipV6BindTcpPort, 0),
      ipV6BindWsPort: getIntEnvValue(process.env.P2P_ipV6BindWsPort, 0),
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
      connectionsDialTimeout: getIntEnvValue(process.env.P2P_connectionsDialTimeout, 10e3) // 10 seconds
    },
    hasProvider: true,
    httpPort: getIntEnvValue(process.env.HTTP_API_PORT, 8000),
    dbConfig: {
      url: getEnvValue(process.env.DB_URL, 'http://localhost:8108/?apiKey=xyz')
    },
    supportedNetworks,
    feeStrategy: getOceanNodeFees(supportedNetworks, isStartup)
  }
  return config
}
