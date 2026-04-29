import { isDefined } from './util.js'

export * from './config/index.js'

export function isPolicyServerConfigured(): boolean {
  return isDefined(process.env.POLICY_SERVER_URL)
}
