// Helpers that keep credentials, decrypted URLs and oversized payloads out of the logs.
// Logs are persisted to disk (30 days by default), so anything logged must be safe to keep.
// This module must stay dependency-free (it is imported by Logger.ts).

// keys whose values never reach the logs, at any depth (matched case-insensitively).
// "token" is not listed: it is an ERC20 address on most commands and only a credential on
// the auth-token commands, so it is redacted on request (redactToken)
export const SENSITIVE_LOG_FIELDS: readonly string[] = Object.freeze([
  'authorization', // auth token (JWT), usually taken from the Authorization header
  'signature', // consumer / admin signature authorizing a command
  'nonce', // replay counter paired with the signature
  'aes_encrypted_key', // download: encrypted key material
  'encryptedDockerRegistryAuth', // compute: encrypted docker registry credentials
  'userData', // free-form consumer data (compute / download)
  'userdata',
  'files', // file objects carry URLs, headers and storage credentials
  // single file objects (fileInfo `file`, algorithm `fileObject`) keep their shape: their
  // credentials are caught by the keys here, and their URLs by redactUrls on every string
  'headers',
  'envs', // compute: algorithm environment variables
  'algocustomdata', // compute: free-form algorithm parameters
  'dockerRegistryAuth',
  'password',
  'secretAccessKey',
  'accessKeyId',
  'privateKey',
  'rawcode' // algorithm source code
])

const TOKEN_FIELD = 'token'
const SENSITIVE_KEYS = new Set(SENSITIVE_LOG_FIELDS.map((key) => key.toLowerCase()))
const REDACTED = '[REDACTED]'
const CIRCULAR = '[CIRCULAR]'
const DEFAULT_MAX_LENGTH = 2000
const ERROR_SUMMARY_MAX_LENGTH = 500

function isSensitiveKey(key: string, redactToken: boolean): boolean {
  const lower = key.toLowerCase()
  return SENSITIVE_KEYS.has(lower) || (redactToken && lower === TOKEN_FIELD)
}

function redactValue(value: any, redactToken: boolean, seen: WeakSet<object>): any {
  if (typeof value === 'string') {
    // URLs can sit under any key (DDO services, remote storage targets, error texts)
    return redactUrls(value)
  }
  if (value === null || typeof value !== 'object') {
    return value
  }
  if (seen.has(value)) {
    return CIRCULAR
  }
  if (Array.isArray(value)) {
    seen.add(value)
    const copy = value.map((item) => redactValue(item, redactToken, seen))
    seen.delete(value)
    return copy
  }
  // only plain objects are walked: Buffers, Dates, streams, class instances pass through
  const proto = Object.getPrototypeOf(value)
  if (proto !== Object.prototype && proto !== null) {
    return value
  }
  seen.add(value)
  const copy: any = {}
  for (const [key, item] of Object.entries(value)) {
    if (isSensitiveKey(key, redactToken)) {
      copy[key] = item !== undefined && item !== null ? REDACTED : item
    } else {
      copy[key] = redactValue(item, redactToken, seen)
    }
  }
  seen.delete(value)
  return copy
}

/**
 * Returns a copy of `value` with every sensitive field replaced by '[REDACTED]', at any
 * depth. Never mutates its input (nested objects may be shared with a live command whose
 * handler still needs the real credentials). Cycles become '[CIRCULAR]'.
 * `redactToken` also redacts `token` keys (off by default: usually an ERC20 address).
 */
export function redactSensitiveFields<T>(value: T, opts?: { redactToken?: boolean }): T {
  return redactValue(value, opts?.redactToken === true, new WeakSet()) as T
}

/**
 * JSON for log lines: BigInt- and cycle-safe, redacted (including `token`) unless
 * `redact: false`, single line, truncated to `maxLength` chars (default 2000, <= 0 = no limit).
 */
export function safeStringify(
  value: unknown,
  opts?: { redact?: boolean; maxLength?: number }
): string {
  const maxLength = opts?.maxLength ?? DEFAULT_MAX_LENGTH
  let str: string
  try {
    const input =
      opts?.redact === false ? value : redactSensitiveFields(value, { redactToken: true })
    const ancestors: object[] = []
    str = JSON.stringify(input, function (this: any, _key: string, item: any) {
      if (typeof item === 'bigint') return item.toString()
      if (item === null || typeof item !== 'object') return item
      // `this` is the object holding `item`: drop ancestors that are no longer on the path
      while (ancestors.length > 0 && ancestors[ancestors.length - 1] !== this) {
        ancestors.pop()
      }
      if (ancestors.includes(item)) return CIRCULAR
      const out =
        item instanceof Error ? { name: item.name, message: errorSummary(item) } : item
      ancestors.push(out)
      return out
    })
  } catch {
    return '[unserializable]'
  }
  if (str === undefined) return String(value)
  if (maxLength > 0 && str.length > maxLength) {
    return `${str.slice(0, maxLength)}…(truncated ${str.length - maxLength} chars)`
  }
  return str
}

// scheme://authority[rest]; userinfo and rest (path, query, fragment) are dropped
const URL_REGEX = /\b(?:https?|ftps?|s3|wss?|ipfs|ipns|ar):\/\/[^\s"'<>`]+/gi
const URL_PARTS = /^([a-z0-9+.-]+:\/\/)([^/?#]*)(.*)$/is
const TRAILING_PUNCTUATION = '.,;:!?)]}'

/**
 * Replaces every URL in `text` with its origin plus '/…': userinfo, path, query and
 * fragment are dropped (they can carry decrypted asset locations, API keys or credentials).
 */
export function redactUrls(text: string): string {
  if (typeof text !== 'string' || !text) return text
  return text.replace(URL_REGEX, (match: string) => {
    // a backwards scan: an unanchored /[...]+$/ regex is quadratic on long punctuation runs
    let end = match.length
    while (end > 0 && TRAILING_PUNCTUATION.includes(match[end - 1])) end--
    const trailing = match.slice(end)
    const url = match.slice(0, end)
    const parts = url.match(URL_PARTS)
    if (!parts) return match
    const [, scheme, authority, rest] = parts
    const host = authority.replace(/^.*@/, '')
    return `${scheme.toLowerCase()}${host}${rest && rest !== '/' ? '/…' : rest}${trailing}`
  })
}

// error texts can embed whole upstream response bodies: only the head is ever logged
function capInput(text: string): string {
  return text.length > ERROR_SUMMARY_MAX_LENGTH * 4
    ? text.slice(0, ERROR_SUMMARY_MAX_LENGTH * 4)
    : text
}

function truncate(text: string, maxLength: number): string {
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text
}

/**
 * Short, log-safe description of an error: URLs are reduced to their origin, and JSON parse
 * errors never quote the input (on Node >= 24 they include a snippet of the parsed text,
 * which can be a decrypted payload).
 */
export function errorSummary(err: unknown): string {
  if (err === undefined || err === null) return 'unknown error'
  if (err instanceof Error || (typeof err === 'object' && 'message' in (err as any))) {
    const { name, message } = err as Error
    if (name === 'SyntaxError' && /JSON/i.test(String(message))) {
      return 'invalid JSON (SyntaxError)'
    }
    const text = message ? String(message) : name || 'Error'
    return truncate(redactUrls(capInput(text)), ERROR_SUMMARY_MAX_LENGTH)
  }
  if (typeof err === 'string') {
    return truncate(redactUrls(capInput(err)), ERROR_SUMMARY_MAX_LENGTH)
  }
  return redactUrls(safeStringify(err, { maxLength: ERROR_SUMMARY_MAX_LENGTH }))
}
