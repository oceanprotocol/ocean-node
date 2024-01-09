import path from 'path'
import dotenv from 'dotenv'
import { fileURLToPath } from 'url'

// __dirname and __filename are not defined in ES module scope
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// use this if we need to override the default configuration while testing
export interface OverrideEnvConfig {
  name: string // name of the var
  newValue: any // value of the var
  originalValue: any // original value
  override: boolean // override the default/existing value?
  required: boolean // is required variable?
}
// set env vars first
// envFilePath should be relative to current directory
// Optionally we can choose to override a few variables (default is NOT override)
// if we override we can use the override array to later restore them on tearDownEnvironment()
export async function setupEnvironment(
  envFilePath: string,
  overrideVars?: OverrideEnvConfig[]
): Promise<OverrideEnvConfig[] | undefined> {
  // configure some env variables
  const pathEnv = path.resolve(__dirname, envFilePath)
  console.log('Setting up environment with variables from:', pathEnv)
  dotenv.config({ path: pathEnv, encoding: 'utf8', debug: true })
  if (overrideVars && overrideVars.length > 0) {
    overrideVars.forEach((element: OverrideEnvConfig) => {
      if (
        element.override ||
        (element.required && process.env[element.name] === undefined) // if override OR not set but required
      ) {
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
      if (element.override) {
        process.env[element.name] = element.originalValue
      }
    })
  }
}
