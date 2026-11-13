import { isDefined } from './util.js'

export * from './config/index.js'

export function isPolicyServerConfigured(): boolean {
  return isDefined(process.env.POLICY_SERVER_URL)
}

// Free-form owner/legal info (imprint, terms, privacy policy, ...) from NODE_OWNER_INFO.
// Returns null when unset or not a JSON object.
export function getNodeOwnerInfo(): Record<string, any> | null {
  const raw = process.env.NODE_OWNER_INFO
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? parsed
      : null
  } catch {
    return null
  }
}
