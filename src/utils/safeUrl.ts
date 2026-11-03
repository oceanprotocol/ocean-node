/**
 * SSRF guard for outbound requests whose target is chosen by a remote caller
 * (asset `url` / `ftp` / `s3` file objects: fileInfo, download, encrypt, compute
 * provisioning and compute-output upload).
 *
 * Two layers:
 *
 * 1. A synchronous check on the URL host (`checkHostnameSync` / `checkUrlHost`) used by
 *    the storage `validate()` methods: IP literals (in any encoding the WHATWG URL parser
 *    normalises — decimal, hex, octal, IPv4-mapped IPv6) and `localhost` names are rejected
 *    up front with a clear error.
 *
 * 2. A connect-time check. HTTP(S) requests go through an undici `Agent` whose connector
 *    validates every address a hostname resolves to and every IP literal it is asked to
 *    connect to — on the first hop and on every redirect. That is what closes DNS
 *    rebinding and "public URL that redirects to an internal one". FTP and S3 resolve the
 *    host themselves before connecting (`resolveSafeAddress` / `createSafeHttpAgents`).
 *
 * Blocked by default: everything that is not a globally routable unicast address —
 * loopback, RFC1918 private, link-local, CGNAT, multicast, broadcast, unspecified,
 * documentation and other reserved ranges, and their IPv6 equivalents (`::1`, `fc00::/7`,
 * `fe80::/10`, mapped/translated IPv4, …). Operators can carve out exceptions with
 * `ALLOWED_PRIVATE_URL_RANGES` (CIDRs or single IPs), e.g. a LAN object store.
 */
import { lookup as dnsLookup, promises as dnsPromises } from 'node:dns'
import type { LookupOptions } from 'node:dns'
import http from 'node:http'
import https from 'node:https'
import { isIP } from 'node:net'
import type { LookupFunction } from 'node:net'
import ipaddr from 'ipaddr.js'
import { Agent, buildConnector } from 'undici'
import type { Dispatcher } from 'undici'
import type { OceanNodeConfig } from '../@types/OceanNode.js'
import { CORE_LOGGER } from './logging/common.js'

export type AllowedRange = [ipaddr.IPv4 | ipaddr.IPv6, number]

export const PRIVATE_URL_ERROR =
  'URL points to a private, loopback or reserved network address'

type SafeUrlConfig = Pick<OceanNodeConfig, 'allowedPrivateUrlRanges'> | undefined | null

/**
 * Parse one `ALLOWED_PRIVATE_URL_RANGES` entry: a CIDR (`10.0.0.0/8`, `fd00::/8`) or a
 * single IP (treated as /32 or /128). Returns null when the entry is not valid.
 */
export function parseAllowedRange(entry: unknown): AllowedRange | null {
  if (typeof entry !== 'string') {
    return null
  }
  const value = entry.trim()
  if (!value) {
    return null
  }
  try {
    if (value.includes('/')) {
      const [addr, bits] = ipaddr.parseCIDR(value)
      // ipaddr.process() unwraps IPv4-mapped IPv6 addresses to IPv4 before the
      // allow-list check in isBlockedAddress. Normalize CIDRs of the same form
      // (::ffff:x.x.x.x/N, N >= 96) to IPv4 equivalents so the kinds match.
      if (addr.kind() === 'ipv6' && bits >= 96) {
        const v6 = addr as ipaddr.IPv6
        if (v6.isIPv4MappedAddress()) {
          return [v6.toIPv4Address(), bits - 96]
        }
      }
      return [addr, bits]
    }
    const addr = ipaddr.parse(value)
    return [addr, addr.kind() === 'ipv4' ? 32 : 128]
  } catch (e) {
    return null
  }
}

export function parseAllowedRanges(entries: unknown): AllowedRange[] {
  if (!Array.isArray(entries)) {
    return []
  }
  const ranges: AllowedRange[] = []
  for (const entry of entries) {
    const range = parseAllowedRange(entry)
    if (range) {
      ranges.push(range)
    } else {
      // config parsing already logged + dropped invalid entries; this is a safety net
      // for config objects built by hand (tests, pushConfig)
      CORE_LOGGER.warn(`Ignoring invalid allowedPrivateUrlRanges entry: ${String(entry)}`)
    }
  }
  return ranges
}

export function getAllowedRanges(config: SafeUrlConfig): AllowedRange[] {
  return parseAllowedRanges(config?.allowedPrivateUrlRanges)
}

/**
 * true when `address` must not be contacted: anything that is not a public unicast
 * address, unless it falls inside one of the operator's allowed ranges. Unparseable
 * input is treated as blocked (fail closed).
 */
export function isBlockedAddress(address: string, allowed: AllowedRange[] = []): boolean {
  let parsed: ipaddr.IPv4 | ipaddr.IPv6
  try {
    // process() also unwraps IPv4-mapped IPv6 (::ffff:127.0.0.1 -> 127.0.0.1)
    parsed = ipaddr.process(address)
  } catch (e) {
    return true
  }
  for (const [network, bits] of allowed) {
    if (network.kind() === parsed.kind() && parsed.match(network, bits)) {
      return false
    }
  }
  return parsed.range() !== 'unicast'
}

function stripBrackets(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname
}

export function isLocalHostname(hostname: string): boolean {
  const name = hostname.toLowerCase().replace(/\.$/, '')
  return name === 'localhost' || name.endsWith('.localhost')
}

/**
 * Synchronous host check (no DNS). Returns an error message when the host is an IP
 * literal or a localhost name that is blocked, null when it is allowed or is a DNS name
 * that still has to be validated at connect time.
 */
export function checkHostnameSync(
  hostname: string,
  allowed: AllowedRange[] = []
): string | null {
  const host = stripBrackets(hostname || '')
  if (!host) {
    return 'URL has no host'
  }
  if (isIP(host)) {
    return isBlockedAddress(host, allowed) ? PRIVATE_URL_ERROR : null
  }
  if (isLocalHostname(host)) {
    // localhost resolves to 127.0.0.1 and/or ::1; only let it through when the operator
    // allowed loopback explicitly (the lookup check still validates the real answer)
    const loopbackBlocked =
      isBlockedAddress('127.0.0.1', allowed) && isBlockedAddress('::1', allowed)
    return loopbackBlocked ? PRIVATE_URL_ERROR : null
  }
  return null
}

/**
 * Parse `url` and run the synchronous host check against the node config.
 * Returns an error message or null.
 */
export function checkUrlHost(url: string, config: SafeUrlConfig): string | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch (e) {
    return 'Invalid URL'
  }
  return checkHostnameSync(parsed.hostname, getAllowedRanges(config))
}

/**
 * dns.lookup wrapper that rejects when any resolved address is blocked. Node may ask
 * for all addresses (`all: true`, happy eyeballs) and try them in turn, so every one of
 * them has to be acceptable.
 */
export function createSafeLookup(allowed: AllowedRange[]): LookupFunction {
  return (hostname, options, callback) => {
    dnsLookup(hostname, options as LookupOptions, (err, address, family) => {
      if (!err) {
        const addresses = Array.isArray(address)
          ? address.map((entry) => entry.address)
          : [address]
        const blocked = addresses.find((entry) => isBlockedAddress(entry, allowed))
        if (blocked !== undefined) {
          callback(
            new Error(`${PRIVATE_URL_ERROR} (${hostname} resolves to ${blocked})`),
            address as any,
            family
          )
          return
        }
      }
      callback(err, address as any, family)
    })
  }
}

/**
 * Resolve `hostname` and return one address that passed the check. Used by clients that
 * do not expose a lookup hook (FTP), which then connect to the returned IP.
 */
export async function resolveSafeAddress(
  hostname: string,
  allowed: AllowedRange[] = []
): Promise<{ address: string; family: number }> {
  const host = stripBrackets(hostname || '')
  const reason = checkHostnameSync(host, allowed)
  if (reason) {
    throw new Error(`${reason} (${host})`)
  }
  const literal = isIP(host)
  if (literal) {
    return { address: host, family: literal }
  }
  const results = await dnsPromises.lookup(host, { all: true, order: 'ipv4first' })
  if (!results.length) {
    throw new Error(`Could not resolve host ${host}`)
  }
  for (const result of results) {
    if (isBlockedAddress(result.address, allowed)) {
      throw new Error(`${PRIVATE_URL_ERROR} (${host} resolves to ${result.address})`)
    }
  }
  return { address: results[0].address, family: results[0].family }
}

/**
 * undici connector: sync check on IP literals (which never go through dns.lookup) plus
 * the validating lookup for names. Invoked for every new connection, including the ones
 * fetch opens while following redirects.
 */
export function createSafeConnector(allowed: AllowedRange[]): buildConnector.connector {
  const inner = buildConnector({ lookup: createSafeLookup(allowed) })
  return (options, callback) => {
    const reason = checkHostnameSync(options.hostname, allowed)
    if (reason) {
      callback(new Error(`${reason} (${options.hostname})`), null)
      return
    }
    inner(options, callback)
  }
}

export function createSafeAgent(allowedRanges: unknown): Agent {
  return new Agent({ connect: createSafeConnector(parseAllowedRanges(allowedRanges)) })
}

/**
 * LRU cache for safe dispatchers keyed by JSON-serialised allowedPrivateUrlRanges.
 *
 * The node normally runs with a single configuration so the cache stays at one
 * entry. The cap (16) guards against unbounded growth when pushConfig is used to
 * cycle through many distinct allowedPrivateUrlRanges values.
 *
 * Evicted agents are NEVER closed: a caller that received an agent reference
 * before eviction may still have in-flight requests dispatched through it, and
 * closing the agent would abort those connections. The agent is simply removed
 * from the map; existing references remain valid and the agent's connection pool
 * drains naturally as idle connections time out and GC collects the object.
 */
const DISPATCHER_CACHE_MAX = 16
const dispatcherCache = new Map<string, Agent>()

/**
 * Shared, cached undici dispatcher for the node config's allowed ranges. Pass it as
 * `dispatcher` to `fetchStream` / `fetchHeadersTimeout` (undici fetch) for any request to
 * a caller-supplied URL.
 */
export function getSafeDispatcher(config: SafeUrlConfig): Dispatcher {
  const entries = Array.isArray(config?.allowedPrivateUrlRanges)
    ? config.allowedPrivateUrlRanges
    : []
  const key = JSON.stringify(entries)

  // Cache hit: move to end (most-recently-used position) and return.
  const existing = dispatcherCache.get(key)
  if (existing) {
    dispatcherCache.delete(key)
    dispatcherCache.set(key, existing)
    return existing
  }

  const agent = createSafeAgent(entries)

  // Evict the least-recently-used entry when at capacity. Do NOT close it —
  // see the cache comment above.
  if (dispatcherCache.size >= DISPATCHER_CACHE_MAX) {
    dispatcherCache.delete(dispatcherCache.keys().next().value as string)
  }

  dispatcherCache.set(key, agent)
  return agent
}

/**
 * node:http / node:https agents with the validating lookup, for clients built on the
 * core http stack (the AWS S3 SDK). IP-literal hosts never hit dns.lookup, so callers
 * must run `checkHostnameSync` on the endpoint host up front.
 */
export function createSafeHttpAgents(allowedRanges: unknown): {
  httpAgent: http.Agent
  httpsAgent: https.Agent
} {
  const lookup = createSafeLookup(parseAllowedRanges(allowedRanges))
  return {
    httpAgent: new http.Agent({ lookup }),
    httpsAgent: new https.Agent({ lookup })
  }
}
