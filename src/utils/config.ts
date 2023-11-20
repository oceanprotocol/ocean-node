import type { OceanNodeConfig, OceanNodeKeys } from '../@types/OceanNode'
import { createFromPrivKey } from '@libp2p/peer-id-factory'
import { keys } from '@libp2p/crypto'
import { hexStringToByteArray } from '../utils/index.js'
import type { PeerId } from '@libp2p/interface/peer-id'

import {
  CustomNodeLogger,
  LOGGER_MODULE_NAMES,
  LOG_LEVELS_STR,
  defaultConsoleTransport,
  getCustomLoggerForModule,
  GENERIC_EMOJIS
} from '../utils/logging/Logger.js'

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
  CONFIG_CONSOLE_LOGGER.logMessageWithEmoji(
    'Starting node with peerID: ' + id,
    true,
    GENERIC_EMOJIS.EMOJI_CHECK_MARK
  )

  return {
    peerId: id,
    publicKey: key.public.bytes,
    // Notes:
    // using 'key.public.bytes' gives extra 4 bytes: 08021221
    // using (key as any)._publicKey is stripping this same 4 bytes at the beginning: 08021221
    // when getting the peer details with 'peerIdFromString(peerName)' it returns the version with the 4 extra bytes
    // and we also need to send that to the client, so he can uncompress the public key correctly and perform the check and the encryption
    // so it would make more sense to use this value on the configuration
    privateKey: (key as any)._key
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

export async function getConfig(): Promise<OceanNodeConfig> {
  const privateKey = process.env.PRIVATE_KEY
  if (!privateKey || privateKey.length !== 66) {
    // invalid private key
    CONFIG_CONSOLE_LOGGER.logMessageWithEmoji(
      'Invalid PRIVATE_KEY env variable..',
      true,
      GENERIC_EMOJIS.EMOJI_CROSS_MARK,
      LOG_LEVELS_STR.LEVEl_ERROR
    )
    return null
  }

  if (!process.env.IPFS_GATEWAY) {
    CONFIG_CONSOLE_LOGGER.logMessageWithEmoji(
      'Invalid IPFS_GATEWAY env variable..',
      true,
      GENERIC_EMOJIS.EMOJI_CROSS_MARK,
      LOG_LEVELS_STR.LEVEl_ERROR
    )
    return null
  }

  if (!process.env.ARWEAVE_GATEWAY) {
    CONFIG_CONSOLE_LOGGER.logMessageWithEmoji(
      'Invalid ARWEAVE_GATEWAY env variable..',
      true,
      GENERIC_EMOJIS.EMOJI_CROSS_MARK,
      LOG_LEVELS_STR.LEVEl_ERROR
    )
    return null
  }
  const config: OceanNodeConfig = {
    keys: await getPeerIdFromPrivateKey(privateKey),
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
    }
  }
  return config
}
