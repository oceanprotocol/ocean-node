import { CONFIG_LOGGER } from './logging/common.js'
import { isDefined } from './util.js'
import { getConfiguration, loadConfigFromFile } from './config/builder.js'
export * from './config/index.js'

export function existsEnvironmentVariable(envVariable: any, log = false): boolean {
  const { name, value, required } = envVariable
  const currentValue = process.env[name] || value

  if (!currentValue) {
    if (log) {
      const emoji = required ? '❌' : '⚠️'
      const level = required ? 'error' : 'warn'
      CONFIG_LOGGER[level](`${emoji} Invalid or missing "${name}" env variable...`)
    }
    return false
  }
  return true
}

export function loadConfigFromEnv(envVar: string = 'CONFIG_PATH') {
  return loadConfigFromFile(process.env[envVar])
}

export function isPolicyServerConfigured(): boolean {
  return isDefined(process.env.POLICY_SERVER_URL)
}
export const hasP2PInterface = (await (await getConfiguration())?.hasP2P) || false
