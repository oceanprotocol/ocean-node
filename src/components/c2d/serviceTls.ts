import net from 'net'
import type { ServiceEndpoint } from '../../@types/C2D/ServiceOnDemand.js'
import { isBlockedAddress, isLocalHostname } from '../../utils/safeUrl.js'

export const SECURE_TLS_UNAVAILABLE_MESSAGE =
  'TLS is not available on this environment: no public nodeHost, no certificate yet, ' +
  'or a remote Docker daemon'

// null when valid; [] is valid (turns TLS off on restart)
export function validateSecureTls(value: unknown, exposedPorts: number[]): string | null {
  if (value === undefined) return null
  if (!Array.isArray(exposedPorts) || !exposedPorts.every(Number.isInteger))
    return 'exposed ports must be an array of integers'
  if (!Array.isArray(value)) return '"secureTls" must be an array of container ports'
  if (new Set(value).size !== value.length)
    return '"secureTls" lists a port more than once'
  const bad = value.findIndex((port) => !exposedPorts.includes(port))
  if (bad !== -1)
    return `"secureTls" port ${String(value[bad])} is not one of the exposed ports`
  return null
}

export function urlHost(host: string): string {
  return net.isIP(host) === 6 ? `[${host}]` : host
}

export function buildServiceEndpoints(
  exposedPorts: number[],
  hostPorts: number[],
  nodeHost: string,
  secureTls?: number[]
): ServiceEndpoint[] {
  return exposedPorts.map((containerPort, i) => {
    const tls = !!secureTls?.includes(containerPort)
    return {
      containerPort,
      hostPort: hostPorts[i],
      url: `${tls ? 'https' : 'http'}://${urlHost(nodeHost)}:${hostPorts[i]}`,
      tls
    }
  })
}

// Names that only resolve on a private network: a public CA does not issue for them
const PRIVATE_NAME_SUFFIXES = [
  '.local',
  '.internal',
  '.lan',
  '.home.arpa',
  '.localdomain'
]

// A public IP or a dotted, non-local domain: the names a public CA issues for
export function tlsNameFor(nodeHost?: string): string | null {
  if (!nodeHost) return null
  if (net.isIP(nodeHost)) return isBlockedAddress(nodeHost) ? null : nodeHost
  const name = nodeHost.toLowerCase()
  if (!name.includes('.') || isLocalHostname(name)) return null
  return PRIVATE_NAME_SUFFIXES.some((s) => name.endsWith(s)) ? null : nodeHost
}
