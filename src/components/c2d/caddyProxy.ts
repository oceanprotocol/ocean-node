import type Dockerode from 'dockerode'
import { PassThrough } from 'stream'
import { setTimeout as sleep } from 'timers/promises'
import {
  DEFAULT_SERVICE_MAX_DURATION_SECONDS,
  ServiceStatusNumber,
  type ServiceEndpoint,
  type ServiceJob,
  type ServiceOnDemandConfig
} from '../../@types/C2D/ServiceOnDemand.js'
import { create256Hash } from '../../utils/crypt.js'
import { CORE_LOGGER } from '../../utils/logging/common.js'
import { urlHost } from './serviceTls.js'

export const CADDY_IMAGE = 'caddy:2.11.9-alpine'
// One per Docker host: Caddy binds the host's port 80 and admin port 2019
export const CADDY_CONTAINER = 'ocean-node-caddy'
export const CADDY_ACME_JSON = '/letsencrypt/acme.json'
const CADDY_DATA_VOLUME = 'ocean-node-caddy-data'
const CADDY_CERT_DIR = '/data/ocean'
const CADDY_CERT_STORAGE = '/data/caddy/certificates'
// Docker can rewrite bind paths in inspect output, so the mounted file is compared by label
const ACME_LABEL = 'ocean-node.letsencrypt-acme-path'
const OWNER_LABEL = 'ocean-node.owner'
const ENSURE_TIMEOUT_MS = 120_000 // includes the image pull
const EXEC_TIMEOUT_MS = 10_000
const EXEC_EXIT_POLL_MS = 100
const EXEC_EXIT_POLLS = 20
const RESEND_MS = 60_000 // a restarted Caddy has no config until the next load
const LOG_KEY = 'service-tls-sync'
const LOG_INTERVAL_MS = 600_000
const CERT_FILE_HASH_CHARS = 16
// Admin API on the host's loopback (Caddy's default): service containers cannot reach it
export const CADDY_LOAD_CMD = [
  'wget',
  '-qO-',
  '--header',
  'Content-Type: application/json',
  '--post-file=/dev/stdin',
  'http://127.0.0.1:2019/load'
]

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout
  const timeout = new Promise<never>((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${what}: timed out`)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

async function inspectOrNull<T>(target: { inspect(): Promise<T> }): Promise<T | null> {
  try {
    return await target.inspect()
  } catch (e) {
    if (e?.statusCode === 404) return null
    throw e
  }
}

async function ownCaddy(docker: Dockerode, owner: string) {
  const container = docker.getContainer(CADDY_CONTAINER)
  const info = await inspectOrNull(container)
  const current = info?.Config?.Labels?.[OWNER_LABEL]
  if (info && current !== owner)
    throw new Error(
      `${CADDY_CONTAINER} belongs to another node (${current ?? 'unknown'})`
    )
  return { container, info }
}

async function createCaddy(
  docker: Dockerode,
  owner: string,
  acmePath?: string
): Promise<Dockerode.Container> {
  if (!(await inspectOrNull(docker.getImage(CADDY_IMAGE)))) {
    const stream = await docker.pull(CADDY_IMAGE)
    await new Promise((resolve, reject) =>
      docker.modem.followProgress(stream, (err: Error) =>
        err ? reject(err) : resolve(null)
      )
    )
  }
  const binds = [`${CADDY_DATA_VOLUME}:/data`]
  if (acmePath) binds.push(`${acmePath}:${CADDY_ACME_JSON}:ro`)
  const container = await docker.createContainer({
    name: CADDY_CONTAINER,
    Image: CADDY_IMAGE,
    Cmd: ['caddy', 'run'],
    Labels: { [ACME_LABEL]: acmePath ?? '', [OWNER_LABEL]: owner },
    // host network: Caddy listens on the services' random host ports
    HostConfig: { NetworkMode: 'host', RestartPolicy: { Name: 'always' }, Binds: binds }
  })
  await container.start()
  return container
}

export function ensureCaddy(
  docker: Dockerode,
  owner: string,
  acmePath?: string
): Promise<Dockerode.Container> {
  const ensure = async () => {
    const { container, info } = await ownCaddy(docker, owner)
    if (
      info?.Config?.Image === CADDY_IMAGE &&
      info.Config.Labels?.[ACME_LABEL] === (acmePath ?? '')
    ) {
      if (!info.State?.Running) await container.start()
      return container
    }
    if (info) await container.remove({ force: true })
    return createCaddy(docker, owner, acmePath)
  }
  return withTimeout(ensure(), ENSURE_TIMEOUT_MS, `start ${CADDY_CONTAINER}`)
}

export async function removeCaddy(docker: Dockerode, owner: string): Promise<void> {
  const { container, info } = await ownCaddy(docker, owner)
  if (info) await container.remove({ force: true })
}

// `input` goes on stdin and never into an error: it can hold a private key
export async function caddyExec(
  container: Dockerode.Container,
  Cmd: string[],
  input = ''
): Promise<string> {
  const exec = await container.exec({
    Cmd,
    AttachStdin: true,
    AttachStdout: true,
    AttachStderr: true
  })
  const stream = await exec.start({ hijack: true, stdin: true })
  const out = new PassThrough()
  const chunks: Buffer[] = []
  out.on('data', (c: Buffer) => chunks.push(c))
  container.modem.demuxStream(stream, out, out)
  const ended = new Promise((resolve, reject) => {
    stream.on('end', resolve)
    stream.on('close', resolve)
    stream.on('error', reject)
  })
  stream.end(input)
  await withTimeout(ended, EXEC_TIMEOUT_MS, `caddy exec ${Cmd[0]}`).finally(() =>
    stream.destroy()
  )
  // Docker can report the exec as running for a moment after its stream ends
  let info = await exec.inspect()
  for (let i = 0; info.Running && i < EXEC_EXIT_POLLS; i++) {
    await sleep(EXEC_EXIT_POLL_MS)
    info = await exec.inspect()
  }
  const output = Buffer.concat(chunks).toString()
  if (info.ExitCode !== 0)
    throw new Error(
      `caddy exec ${Cmd[0]} exited ${info.ExitCode}: ${output.trim().slice(0, 200)}`
    )
  return output
}

export interface CaddyTlsService {
  serviceId: string
  upstreamIp: string
  endpoints: ServiceEndpoint[]
}

// The host matcher makes Caddy get the cert; default_sni serves it to IP clients (no SNI).
// storeCert: another proxy holds port 80, so no redirect server there.
export function buildCaddyServers(
  nodeHost: string,
  services: CaddyTlsService[],
  { storeCert = false, maxDurationSeconds = DEFAULT_SERVICE_MAX_DURATION_SECONDS } = {}
): Record<string, unknown> {
  const servers: Record<string, unknown> = {}
  for (const svc of services) {
    for (const { containerPort, hostPort } of svc.endpoints.filter((e) => e.tls)) {
      const proxy = {
        handler: 'reverse_proxy',
        upstreams: [{ dial: `${urlHost(svc.upstreamIp)}:${containerPort}` }],
        flush_interval: -1,
        // without it, a config reload closes open websockets
        stream_close_delay: `${maxDurationSeconds}s`
      }
      servers[`ocean_${svc.serviceId}_${containerPort}`] = {
        listen: [`:${hostPort}`],
        tls_connection_policies: [{ default_sni: nodeHost }],
        routes: [{ match: [{ host: [nodeHost] }], handle: [proxy] }],
        ...(storeCert && { automatic_https: { disable_redirects: true } })
      }
    }
  }
  return servers
}

// Without certFile Caddy gets the cert itself, before any service needs it (automate);
// the shortlived profile is required for IP certificates.
export function buildCaddyConfig(
  servers: Record<string, unknown>,
  nodeHost: string,
  certFile?: string
) {
  const tls = certFile
    ? { certificates: { load_files: [{ certificate: certFile, key: certFile }] } }
    : {
        certificates: { automate: [nodeHost] },
        automation: {
          policies: [{ issuers: [{ module: 'acme', profile: 'shortlived' }] }]
        }
      }
  return { apps: { tls, http: { servers } } }
}

interface AcmeJsonCert {
  domain?: { main?: string; sans?: string[] }
  certificate: string // base64 PEM chain
  key: string // base64 PEM
}

// Traefik's acme.json: { <resolver>: { Certificates: AcmeJsonCert[] } }. Returns chain + key.
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

const defaultIo = { ensure: ensureCaddy, exec: caddyExec, remove: removeCaddy }

// Keeps the node's Caddy container in line with the running TLS services
export class CaddyProxy {
  certReady = false // Caddy holds a cert for nodeHost: features.secureTls
  private lastLoad: { json: string; at: number } | null = null
  private removed = false
  private upstreamIps = new Map<string, string>() // containerId -> IP on ocean-svc-<id>

  constructor(
    private readonly docker: Dockerode,
    private readonly owner: string,
    private readonly io = defaultIo
  ) {}

  // nodeHost null: TLS is off, so Caddy goes. Resolves true when Caddy holds no stale ports.
  async sync(
    nodeHost: string | null,
    runningJobs: () => Promise<ServiceJob[]>,
    sod?: ServiceOnDemandConfig
  ): Promise<boolean> {
    try {
      if (nodeHost) await this.load(nodeHost, await runningJobs(), sod)
      else await this.remove()
      CORE_LOGGER.resetThrottle(LOG_KEY)
      return true
    } catch (e: any) {
      this.certReady = false
      CORE_LOGGER.throttled(
        LOG_KEY,
        'error',
        `Service TLS: Caddy sync failed: ${e.message}`,
        LOG_INTERVAL_MS
      )
      return false
    }
  }

  private async remove() {
    if (this.removed) return
    await this.io.remove(this.docker, this.owner)
    this.removed = true
    this.lastLoad = null
    this.certReady = false
  }

  private async load(nodeHost: string, jobs: ServiceJob[], sod?: ServiceOnDemandConfig) {
    const acmePath = sod?.letsEncryptAcmePath
    const servers = buildCaddyServers(nodeHost, await this.tlsServices(jobs), {
      storeCert: !!acmePath,
      maxDurationSeconds: sod?.maxDurationSeconds
    })
    const json = JSON.stringify(servers)
    if (this.lastLoad?.json === json && Date.now() - this.lastLoad.at < RESEND_MS) return
    const caddy = await this.io.ensure(this.docker, this.owner, acmePath)
    const certFile = acmePath ? await this.copyStoreCert(caddy, nodeHost) : undefined
    const config = buildCaddyConfig(servers, nodeHost, certFile)
    await this.io.exec(caddy, CADDY_LOAD_CMD, JSON.stringify(config))
    this.lastLoad = { json, at: Date.now() }
    this.removed = false
    this.certReady = !!certFile || (await this.hasCert(caddy, nodeHost))
  }

  // The file name follows the cert, so a renewal changes the config and Caddy reloads it
  private async copyStoreCert(caddy: Dockerode.Container, nodeHost: string) {
    const pem = findStoreCert(
      await this.io.exec(caddy, ['cat', CADDY_ACME_JSON]),
      nodeHost
    )
    if (!pem) throw new Error(`letsEncryptAcmePath has no certificate for ${nodeHost}`)
    const file = `${CADDY_CERT_DIR}/${create256Hash(pem).slice(2, 2 + CERT_FILE_HASH_CHARS)}.pem`
    const write = `umask 077 && mkdir -p ${CADDY_CERT_DIR} && rm -f ${CADDY_CERT_DIR}/*.pem && cat > ${file}`
    await this.io.exec(caddy, ['sh', '-c', write], pem)
    return file
  }

  // Caddy stores certificates/<issuer>/<name>/<name>.crt, with ':' as '-'
  private hasCert(caddy: Dockerode.Container, nodeHost: string): Promise<boolean> {
    const name = nodeHost.toLowerCase().replaceAll(':', '-')
    const ls = `ls ${CADDY_CERT_STORAGE}/*/"$1"/"$1".crt`
    return this.io.exec(caddy, ['sh', '-c', ls, '--', name]).then(
      () => true,
      () => false
    )
  }

  private async tlsServices(jobs: ServiceJob[]): Promise<CaddyTlsService[]> {
    const secure = jobs.filter(
      (j) => j.status === ServiceStatusNumber.Running && j.secureTls?.length
    )
    const live = new Set(secure.map((j) => j.containerId))
    for (const id of this.upstreamIps.keys())
      if (!live.has(id)) this.upstreamIps.delete(id)
    const services = await Promise.all(secure.map((j) => this.tlsService(j)))
    return services.filter((s) => s)
  }

  private async tlsService(job: ServiceJob): Promise<CaddyTlsService | null> {
    let upstreamIp = this.upstreamIps.get(job.containerId)
    if (!upstreamIp) {
      try {
        const info = await this.docker.getContainer(job.containerId).inspect()
        upstreamIp =
          info.NetworkSettings?.Networks?.[`ocean-svc-${job.serviceId}`]?.IPAddress
        if (!upstreamIp) throw new Error('container has no IP on its service network')
        this.upstreamIps.set(job.containerId, upstreamIp)
      } catch (e: any) {
        CORE_LOGGER.throttled(
          `service-tls-skip-${job.serviceId}`,
          'warn',
          `Service TLS: skipping service ${job.serviceId}: ${e.message}`
        )
        return null
      }
    }
    return { serviceId: job.serviceId, upstreamIp, endpoints: job.endpoints }
  }
}
