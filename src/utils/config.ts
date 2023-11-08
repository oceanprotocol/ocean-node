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
    'Starting node with peerID:' + id,
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

export async function getConfig(): Promise<OceanNodeConfig> {
  let port = parseInt(process.env.HTTP_API_PORT)
  if (isNaN(port)) port = 8000
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
  const config: OceanNodeConfig = {
    keys: await getPeerIdFromPrivateKey(privateKey),
    hasIndexer: true,
    hasHttp: true,
    hasP2P: true,
    hasProvider: true,
    httpPort: port,
    dbConfig: {
      // dbname: 'oceannode',
      // host: '127.0.0.1',
      // user: 'oceannode',
      // pwd: 'oceannode'
      typesense: {
        apiKey: 'xyz',
        nodes: [
          {
            host: 'localhost',
            port: 8108,
            protocol: 'http'
          }
        ]
      }
    }
  }
  return config
}
