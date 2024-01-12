import path from 'path'
import dotenv from 'dotenv'
import { fileURLToPath } from 'url'
import { ENVIRONMENT_VARIABLES, EnvVariable } from '../../utils/constants.js'
import { CONFIG_CONSOLE_LOGGER } from '../../utils/logging/common.js'

// __dirname and __filename are not defined in ES module scope
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// relative to test/utils (default value, but can use other paths)
export const TEST_ENV_CONFIG_FILE = '../.env.test'
// use this if we need to override the default configuration while testing
export interface OverrideEnvConfig {
  name: string // name of the var
  newValue: any // new value of the var
  originalValue: any // original value of the var (could be udefined)
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
    CONFIG_CONSOLE_LOGGER.debug('Setting up environment with variables from: ' + pathEnv)
    dotenv.config({ path: pathEnv, encoding: 'utf8', debug: true }) // override is false by default
  }

  if (overrideVars && overrideVars.length > 0) {
    overrideVars.forEach((element: OverrideEnvConfig) => {
      if (
        element.override ||
        (element.required && process.env[element.name] === undefined) // if override OR not set but required to run
      ) {
        CONFIG_CONSOLE_LOGGER.debug('Overriding environment variable: ' + element.name)
        element.originalValue = process.env[element.name] // save original value
        process.env[element.name] = element.newValue
      }
    })
  }
  return overrideVars
}
/**
 * Restore any overrided environment variables
 * @param overrideVars any variables we overrided for testing purposes
 */
export async function tearDownEnvironment(overrideVars?: OverrideEnvConfig[]) {
  // restore the environment
  if (overrideVars && overrideVars.length > 0) {
    overrideVars.forEach((element: OverrideEnvConfig) => {
      if (element.override && element.newValue !== element.originalValue) {
        // only restore what we have explicilty touched
        CONFIG_CONSOLE_LOGGER.debug('Restoring environment variable: ' + element.name)
        process.env[element.name] = element.originalValue
      }
    })
  }
}
