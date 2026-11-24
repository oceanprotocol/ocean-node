import net from 'net'
import type { ServiceEndpoint } from '../../@types/C2D/ServiceOnDemand.js'
import { isBlockedAddress, isLocalHostname } from '../../utils/safeUrl.js'

export const SECURE_TLS_UNAVAILABLE_MESSAGE =
  'TLS is not available on this environment: the node has no public nodeHost or no ' +
  'running TLS proxy (Caddy), or the environment runs on a remote Docker daemon'

const CADDY_STREAM_CLOSE_DELAY = '24h' // the default max service duration

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

export interface CaddyTlsService {
  serviceId: string
  upstreamIp: string
  secureTls: number[]
  endpoints: ServiceEndpoint[]
}

// The host matcher makes Caddy get the cert; default_sni serves it to IP clients (no SNI).
// With a store cert, redirects are off so Caddy does not bind port 80 (another proxy holds it).
export function buildCaddyServers(
  nodeHost: string,
  services: CaddyTlsService[],
  storeCert = false
): Record<string, unknown> {
  const servers: Record<string, unknown> = {}
  for (const svc of services) {
    for (const port of svc.secureTls) {
      const hostPort = svc.endpoints.find((e) => e.containerPort === port)?.hostPort
      if (hostPort === undefined) continue
      const proxy = {
        handler: 'reverse_proxy',
        upstreams: [{ dial: `${urlHost(svc.upstreamIp)}:${port}` }],
        flush_interval: -1,
        // a config change closes open websockets unless they get this grace
        stream_close_delay: CADDY_STREAM_CLOSE_DELAY
      }
      servers[`ocean_${svc.serviceId}_${port}`] = {
        listen: [`:${hostPort}`],
        tls_connection_policies: [{ default_sni: nodeHost }],
        routes: [{ match: [{ host: [nodeHost] }], handle: [proxy] }],
        ...(storeCert && { automatic_https: { disable_redirects: true } })
      }
    }
  }
  return servers
}

// certFile: the letsEncryptAcmePath cert (no ACME); else Caddy gets one (shortlived: needed for IPs)
export function buildCaddyConfig(servers: Record<string, unknown>, certFile?: string) {
  const tls = certFile
    ? { certificates: { load_files: [{ certificate: certFile, key: certFile }] } }
    : {
        automation: {
          policies: [{ issuers: [{ module: 'acme', profile: 'shortlived' }] }]
        }
      }
  return { apps: { tls, http: { servers } } }
}

interface AcmeJsonCert {
  domain?: { main?: string; sans?: string[] }
  certificate: string
  key: string
}

// acme.json: { <resolver>: { Certificates: [{ domain, certificate, key }] } }, PEMs in base64.
// Returns the chain and key as one PEM.
export function findStoreCert(acmeJson: string, name: string): string | null {
  const store = JSON.parse(acmeJson) as Record<string, { Certificates?: AcmeJsonCert[] }>
  for (const resolver of Object.values(store)) {
    const cert = resolver?.Certificates?.find((c) =>
      [c.domain?.main, ...(c.domain?.sans ?? [])].includes(name)
    )
    if (cert)
      return [cert.certificate, cert.key]
        .map((b64) => Buffer.from(b64, 'base64').toString().trim())
        .join('\n')
  }
  return null
}

// A public IP or a dotted, non-local domain: the names a public CA issues for
export function tlsNameFor(nodeHost?: string): string | null {
  if (!nodeHost) return null
  if (net.isIP(nodeHost)) return isBlockedAddress(nodeHost) ? null : nodeHost
  return nodeHost.includes('.') && !isLocalHostname(nodeHost) ? nodeHost : null
}
