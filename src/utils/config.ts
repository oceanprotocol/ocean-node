import { isDefined } from './util.js'
import { getConfiguration } from './config/builder.js'

export * from './config/index.js'

export function isPolicyServerConfigured(): boolean {
  return isDefined(process.env.POLICY_SERVER_URL)
}

export const hasP2PInterface = (await (await getConfiguration())?.hasP2P) || false
