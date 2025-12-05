import type { OceanNodeConfig, OceanNodeKeys } from '../../@types/OceanNode.js'
import type { C2DClusterInfo, C2DDockerConfig } from '../../@types/C2D/C2D.js'
import type { RPCS } from '../../@types/blockchain.js'
import type { FeeTokens } from '../../@types/Fees.js'
import { C2DClusterType } from '../../@types/C2D/C2D.js'
import { keys } from '@libp2p/crypto'
import { createFromPrivKey } from '@libp2p/peer-id-factory'
import { Wallet } from 'ethers'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { hexStringToByteArray, computeCodebaseHash } from '../index.js'
import {
  getOceanArtifactsAdresses,
  OCEAN_ARTIFACTS_ADDRESSES_PER_CHAIN
} from '../address.js'
import { create256Hash } from '../crypt.js'
import { CONFIG_LOGGER } from '../logging/common.js'
import { LOG_LEVELS_STR, GENERIC_EMOJIS } from '../logging/Logger.js'
import { OceanNodeConfigSchema } from './schemas.js'
import { ENV_TO_CONFIG_MAPPING } from './constants.js'
import { fileURLToPath } from 'url'
import _ from 'lodash'

let previousConfiguration: OceanNodeConfig = null

function mapEnvToConfig(
  env: NodeJS.ProcessEnv,
  mapping: Record<string, string>
): Record<string, any> {
  const result: Record<string, any> = {}
  for (const [envKey, configKey] of Object.entries(mapping)) {
    const value = env[envKey]
    if (value !== undefined && value !== 'undefined') {
      _.set(result, configKey, value)
    }
  }
  return result
}

function preprocessConfigData(data: any): void {
  if (data.INTERFACES) {
    try {
      const interfaces = JSON.parse(data.INTERFACES).map((i: string) => i.toUpperCase())
      if (interfaces.length > 0) {
        data.hasHttp = interfaces.includes('HTTP')
        data.hasP2P = interfaces.includes('P2P')
      }
    } catch (error) {
      CONFIG_LOGGER.warn(`Failed to parse INTERFACES: ${error.message}`)
    }
    delete data.INTERFACES
  }

  // Transform DB_* env vars to dbConfig
  if (data.DB_URL) {
    data.dbConfig = {
      url: data.DB_URL,
      username: data.DB_USERNAME,
      password: data.DB_PASSWORD,
      dbType: data.DB_TYPE || 'elasticsearch'
    }
    delete data.DB_URL
    delete data.DB_USERNAME
    delete data.DB_PASSWORD
    delete data.DB_TYPE
  }

  // Transform FEE_* env vars to feeStrategy
  if (data.FEE_AMOUNT && data.FEE_TOKENS) {
    try {
      const feeAmount = JSON.parse(data.FEE_AMOUNT)
      const tokens = JSON.parse(data.FEE_TOKENS)
      const feeTokens = Object.keys(tokens).map((key) => ({
        chain: key,
        token: tokens[key]
      }))
      data.feeStrategy = { feeAmount, feeTokens }
    } catch (error) {
      CONFIG_LOGGER.error(`Failed to parse fee strategy: ${error.message}`)
    }
    delete data.FEE_AMOUNT
    delete data.FEE_TOKENS
  }
}

export async function getPeerIdFromPrivateKey(
  privateKey: string
): Promise<OceanNodeKeys> {
  const key = new keys.supportedKeys.secp256k1.Secp256k1PrivateKey(
    hexStringToByteArray(privateKey.slice(2))
  )

  return {
    peerId: await createFromPrivKey(key),
    publicKey: key.public.bytes,
    privateKey: (key as any)._key,
    ethAddress: new Wallet(privateKey.substring(2)).address
  }
}

export function getDefaultFeeTokens(supportedNetworks?: RPCS): FeeTokens[] {
  const nodeFeesTokens: FeeTokens[] = []
  let addressesData: any = getOceanArtifactsAdresses()
  if (!addressesData) {
    addressesData = OCEAN_ARTIFACTS_ADDRESSES_PER_CHAIN
  }

  const hasSupportedNetworks =
    supportedNetworks && Object.keys(supportedNetworks).length > 0

  Object.keys(addressesData).forEach((chain: any) => {
    const chainName = chain as string
    const { chainId, Ocean } = addressesData[chainName]

    if (hasSupportedNetworks) {
      const keyId: string = chainId as string
      const chainInfo: any = supportedNetworks[keyId]
      if (chainInfo) {
        nodeFeesTokens.push({
          chain: keyId,
          token: Ocean
        })
      }
    } else {
      nodeFeesTokens.push({
        chain: chainId as string,
        token: Ocean
      })
    }
  })
  return nodeFeesTokens
}

export function buildC2DClusters(
  dockerComputeEnvironments: C2DDockerConfig[]
): C2DClusterInfo[] {
  const clusters: C2DClusterInfo[] = []

  if (process.env.OPERATOR_SERVICE_URL) {
    try {
      const clustersURLS: string[] = JSON.parse(process.env.OPERATOR_SERVICE_URL)
      for (const theURL of clustersURLS) {
        clusters.push({
          connection: theURL,
          hash: create256Hash(theURL),
          type: C2DClusterType.OPF_K8
        })
      }
    } catch (error) {
      CONFIG_LOGGER.error(`Failed to parse OPERATOR_SERVICE_URL: ${error.message}`)
    }
  }

  if (dockerComputeEnvironments) {
    for (const dockerC2d of dockerComputeEnvironments) {
      if (dockerC2d.socketPath || dockerC2d.host) {
        const hash = create256Hash(JSON.stringify(dockerC2d))
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

export function getConfigFilePath(configPath?: string): string {
  if (!configPath) {
    configPath = process.env.CONFIG_PATH || path.join(process.cwd(), 'config.json')
  }
  return configPath
}

export function loadConfigFromFile(configPath?: string): OceanNodeConfig {
  configPath = getConfigFilePath(configPath)

  if (configPath.startsWith('$HOME')) {
    const home = process.env.HOME || os.homedir()
    if (!home) {
      throw new Error(
        'Config path contains $HOME but HOME is not set in the environment.'
      )
    }
    configPath = path.join(home, configPath.slice('$HOME'.length))
  }

  if (
    configPath !== path.join(process.cwd(), 'config.json') &&
    !path.isAbsolute(configPath)
  ) {
    throw new Error(`Config path must be absolute. Got: ${configPath}`)
  }

  if (!fs.existsSync(configPath)) {
    throw new Error(`Config file not found at path: ${configPath}`)
  }

  const rawData = fs.readFileSync(configPath, 'utf-8')
  let config: OceanNodeConfig

  try {
    config = JSON.parse(rawData)
  } catch (err) {
    throw new Error(`Invalid JSON in config file: ${configPath}. Error: ${err.message}`)
  }

  return config
}

export async function buildMergedConfig(): Promise<OceanNodeConfig> {
  const baseConfig = loadConfigFromFile()
  const privateKey = process.env.PRIVATE_KEY
  if (!privateKey || privateKey.length !== 66) {
    CONFIG_LOGGER.logMessageWithEmoji(
      'Invalid or missing PRIVATE_KEY env variable. Must be 66 characters (0x + 64 hex chars).',
      true,
      GENERIC_EMOJIS.EMOJI_CROSS_MARK,
      LOG_LEVELS_STR.LEVEL_ERROR
    )
    throw new Error('Invalid PRIVATE_KEY')
  }

  const keys = await getPeerIdFromPrivateKey(privateKey)

  const { env } = process
  const envOverrides: Record<string, any> = { keys }

  Object.assign(envOverrides, mapEnvToConfig(env, ENV_TO_CONFIG_MAPPING))

  const merged = _.merge({}, baseConfig, envOverrides)

  preprocessConfigData(merged)

  const parsed = OceanNodeConfigSchema.safeParse(merged)

  if (!parsed.success) {
    console.error('\n❌ Invalid Ocean Node configuration:')
    for (const issue of parsed.error.issues) {
      console.error(`  • ${issue.path.join('.')}: ${issue.message}`)
    }
    throw new Error('Configuration validation failed')
  }

  const config = parsed.data as any

  // Post-processing transformations
  if (!config.indexingNetworks) {
    config.indexingNetworks = config.supportedNetworks
  }

  if (Array.isArray(config.indexingNetworks) && config.supportedNetworks) {
    const filteredNetworks: RPCS = {}
    for (const chainId of config.indexingNetworks) {
      const chainIdStr = String(chainId)
      if (config.supportedNetworks[chainIdStr]) {
        filteredNetworks[chainIdStr] = config.supportedNetworks[chainIdStr]
      }
    }
    config.indexingNetworks = filteredNetworks
  }

  if (!config.feeStrategy) {
    config.feeStrategy = {
      feeAmount: { amount: 0, unit: 'MB' },
      feeTokens: getDefaultFeeTokens(config.supportedNetworks as RPCS)
    }
  }

  config.c2dClusters = buildC2DClusters(
    config.dockerComputeEnvironments as C2DDockerConfig[]
  )

  return config as OceanNodeConfig
}

export async function getConfiguration(
  forceReload: boolean = false,
  isStartup: boolean = false
): Promise<OceanNodeConfig> {
  if (!previousConfiguration || forceReload) {
    previousConfiguration = await buildMergedConfig()
  }

  if (!previousConfiguration.codeHash) {
    const __filename = fileURLToPath(import.meta.url)
    const __dirname = path.dirname(__filename.replace('utils/config', 'utils'))
    previousConfiguration.codeHash = await computeCodebaseHash(__dirname)
  }

  return previousConfiguration
}

export async function printCurrentConfig() {
  const conf = await getConfiguration(true)
  conf.keys.privateKey = '[*** HIDDEN CONTENT ***]'
  console.log(JSON.stringify(conf, null, 4))
}
