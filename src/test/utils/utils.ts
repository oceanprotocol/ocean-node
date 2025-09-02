import path from 'path'
import dotenv from 'dotenv'
import { fileURLToPath } from 'url'
import { DB_TYPES, ENVIRONMENT_VARIABLES, EnvVariable } from '../../utils/constants.js'
import { CONFIG_LOGGER } from '../../utils/logging/common.js'
import { RPCS } from '../../@types/blockchain.js'
import { getConfiguration } from '../../utils/config.js'

export const DEFAULT_TEST_TIMEOUT = 20000 // 20 secs MAX
// __dirname and __filename are not defined in ES module scope
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// relative to test/utils (default value, but can use other paths)
export const TEST_ENV_CONFIG_FILE = '../.env.test'
export const TEST_ENV_CONFIG_PATH = '../.env.test2'
// use this if we need to override the default configuration while testing
export interface OverrideEnvConfig {
  name: string // name of the var
  newValue: any // new value of the var
  originalValue: any // original value of the var (could be undefined)
  override: boolean // override the default/existing value?
  required: boolean // is a required variable?
}

export function buildEnvOverrideConfig(
  envVars: EnvVariable[],
  envValues: any[]
): OverrideEnvConfig[] {
  if (envVars.length !== envValues.length) {
    throw new Error(
      'buildEnvOverrideConfig error: envVars and envValues must be the same length'
    )
  }
  const result: OverrideEnvConfig[] = []
  const existingKeys = Object.keys(ENVIRONMENT_VARIABLES)

  for (let i = 0; i < envVars.length; i++) {
    const variable = envVars[i]

    if (!existingKeys.includes(variable.name)) continue
    // ignore unknown variables
    const overrideValue: any = envValues[i]
    result.push({
      name: variable.name,
      newValue: overrideValue,
      originalValue: process.env[variable.name],
      required: variable.required,
      override: true
    })
  }
  return result
}

export function getExistingEnvironment(): Map<string, OverrideEnvConfig> {
  const config: Map<string, OverrideEnvConfig> = new Map<string, OverrideEnvConfig>()

  Object.values(ENVIRONMENT_VARIABLES).map((key: EnvVariable) => {
    const env = {
      name: key.name,
      newValue: key.value, // new value same as original value here
      originalValue: key.value,
      required: key.required,
      override: false
    } as OverrideEnvConfig
    config.set(key.name, env)
    return env
  })

  return config
}
// set env vars first
// envFilePath should be relative to current directory
// Optionally we can choose to override a few variables (default is NOT override)
// if we override we can use the override array to later restore them on tearDownEnvironment()
// NOTE: process.env variables are only overrided IF explicitly set, OR IF they are NOT set, but are required
export async function setupEnvironment(
  envFilePath?: string,
  overrideVars?: OverrideEnvConfig[]
): Promise<OverrideEnvConfig[] | undefined> {
  // configure some env variables
  if (envFilePath) {
    const pathEnv = path.resolve(__dirname, envFilePath)
    CONFIG_LOGGER.debug('Setting up environment with variables from: ' + pathEnv)
    dotenv.config({ path: pathEnv, encoding: 'utf8', debug: true }) // override is false by default
  }

  let forceReload = false

  if (overrideVars && overrideVars.length > 0) {
    overrideVars.forEach((element: OverrideEnvConfig) => {
      if (
        element.override ||
        (element.required && process.env[element.name] === undefined) // if override OR not set but required to run
      ) {
        CONFIG_LOGGER.debug(
          `Overriding environment variable: ${element.name}\ncurrent:\n ${
            process.env[element.name]
          }\nnew:\n ${element.newValue}`
        )
        element.originalValue = process.env[element.name] // save original value
        process.env[element.name] = element.newValue
        ENVIRONMENT_VARIABLES[element.name].value = element.newValue
        forceReload = true
      }
    })
  }
  if (forceReload) {
    await getConfiguration(true)
  }
  return overrideVars
}
/**
 * Restore any overrided environment variables
 * @param overrideVars any variables we overrided for testing purposes
 */
export async function tearDownEnvironment(overrideVars?: OverrideEnvConfig[]) {
  let forceReload = false
  // restore the environment
  if (overrideVars && overrideVars.length > 0) {
    overrideVars.forEach((element: OverrideEnvConfig) => {
      if (element.override && element.newValue !== element.originalValue) {
        // only restore what we have explicilty touched
        CONFIG_LOGGER.debug(
          `Restoring environment variable: ${element.name} \ncurrent:\n ${element.newValue} \noriginal:\n ${element.originalValue}`
        )
        if (element.originalValue) {
          process.env[element.name] = element.originalValue
        } else {
          delete process.env[element.name]
        }
        forceReload = true
      }
    })
  }
  if (forceReload) {
    await getConfiguration(true)
  }
}

export function getMockSupportedNetworks(): RPCS {
  const mockSupportedNetworks: RPCS = {
    '8996': {
      chainId: 8996,
      network: 'development',
      rpc: 'http://127.0.0.1:8545',
      chunkSize: 100
    }
  }
  return mockSupportedNetworks
}

// need to find a better way, but for now does the trick
// these vars are only set on CI
export function isRunningContinousIntegrationEnv(): boolean {
  return (
    process.env.NODE1_PRIVATE_KEY !== undefined &&
    process.env.NODE2_PRIVATE_KEY !== undefined &&
    process.env.NODE3_PRIVATE_KEY !== undefined
  )
}

// does a random run; sometimes elastic, others typesense
export const SELECTED_RUN_DATABASE =
  new Date().getTime() % 2 === 0 ? DB_TYPES.ELASTIC_SEARCH : DB_TYPES.TYPESENSE
CONFIG_LOGGER.debug(`SELECTED_RUN_DATABASE: ${SELECTED_RUN_DATABASE}`)
