import type { DBComputeJobPayment, ComputeResourceRequestWithPrice } from './C2D.js'

// ── Resource requirements ─────────────────────────────────────────────

export interface TemplateResourceRequirement {
  // Exactly one of `id` or `kind` must be set.
  id?: string // exact resource id: 'cpu' | 'ram' | 'disk' | named GPU ('gpu-0')
  kind?: 'discrete' | 'fungible' // match ANY resource of this kind across the env pool
  type?: string // optional: further filter within kind ('gpu', 'fpga', 'tpu')

  min: number // MUST have at least this much — service is rejected otherwise
  recommended?: number // ideal amount; below this the env gets a lower score
  unit?: string // display hint: 'cores' | 'GB' | 'count'
  description?: string // shown in UI: "CUDA GPU — 2 recommended for large models"
}

// ── Template definition ───────────────────────────────────────────────

export interface UserConfigurableEnvVar {
  key: string // env var name, passed in userData
  validation?: string // optional regex; validated at SERVICE_START time
  sensitive?: boolean // advisory hint for clients/UI (e.g. mask on input). The node receives ALL userData ECIES-encrypted, so this does not change node-side storage.
}

export interface ServiceTemplate {
  id: string // [a-z0-9][a-z0-9_-]{0,63}
  name?: string
  description?: string
  // Image specification — exactly one of (tag | checksum | dockerfile) must be set:
  image: string // base image name
  tag?: string // e.g. "latest" — mutually exclusive with checksum/dockerfile
  checksum?: string // digest: "sha256:<64 hex>" — mutually exclusive with tag/dockerfile
  dockerfile?: string // inline Dockerfile content — triggers build; mutually exclusive with tag/checksum
  additionalDockerFiles?: Record<string, string> // filename → content; only valid with dockerfile
  exposedPorts: number[]
  envVars?: Record<string, string> // fixed env vars — operator-set, never returned to callers
  userConfigurableEnvVars?: UserConfigurableEnvVar[]
  command?: string[] // Docker CMD override; ${KEY} expanded from userData
  entrypoint?: string[] // Docker ENTRYPOINT override
  requiredResources?: TemplateResourceRequirement[] // MUST satisfy — gates SERVICE_START
  recommendedResources?: TemplateResourceRequirement[] // SHOULD satisfy — used for scoring + UI
}

// ── Public / sanitized types ──────────────────────────────────────────

// Safe to return in API responses: envVars values are stripped (keys only). Choosing a
// matching compute environment is the client's responsibility (see GET_COMPUTE_ENVIRONMENTS).
export interface ServiceTemplatePublic extends Omit<ServiceTemplate, 'envVars'> {
  envVarKeys?: string[] // keys of envVars only, never values
}

// ── Operational config (per Docker daemon, not global) ────────────────

export interface ServiceOnDemandConfig {
  enabled: boolean
  nodeHost: string // host (or IP) clients use to reach forwarded service ports; e.g. 'localhost'
  hostPortRange?: [number, number] // e.g. [30000, 32767]; specific to this daemon's host
  maxDurationSeconds?: number // default: 86400 (24 h)
  allowImageBuild?: boolean // default: false — gates Dockerfile-based services per daemon
}

// ── Runtime service job ───────────────────────────────────────────────

export interface ServiceEndpoint {
  containerPort: number
  hostPort: number
  url: string // e.g. "http://<nodeHost>:31042"
}

/* eslint-disable no-unused-vars */
export enum ServiceStatusNumber {
  Starting = 10, // DB record created by the start handler; awaits background processing
  PullImage = 11, // pulling pre-built image from registry
  PullImageFailed = 12,
  BuildImage = 13, // building from Dockerfile
  BuildImageFailed = 14,
  VulnerableImage = 15, // Trivy scan found critical vulnerabilities
  Locking = 20, // escrow createLock in progress (funds locked, not yet claimed)
  Claiming = 30, // payment phase: claimLock on success, or cancelLock if the image step failed
  Running = 40,
  Restarting = 45, // SERVICE_RESTART accepted; teardown + re-pull/build + new container in progress
  Stopping = 50,
  Stopped = 70,
  Expired = 75,
  Error = 99
}
/* eslint-enable no-unused-vars */

export const ServiceStatusText: Record<ServiceStatusNumber, string> = {
  [ServiceStatusNumber.Starting]: 'Starting',
  [ServiceStatusNumber.PullImage]: 'PullImage',
  [ServiceStatusNumber.PullImageFailed]: 'PullImageFailed',
  [ServiceStatusNumber.BuildImage]: 'BuildImage',
  [ServiceStatusNumber.BuildImageFailed]: 'BuildImageFailed',
  [ServiceStatusNumber.VulnerableImage]: 'VulnerableImage',
  [ServiceStatusNumber.Locking]: 'Locking',
  [ServiceStatusNumber.Claiming]: 'Claiming',
  [ServiceStatusNumber.Running]: 'Running',
  [ServiceStatusNumber.Restarting]: 'Restarting',
  [ServiceStatusNumber.Stopping]: 'Stopping',
  [ServiceStatusNumber.Stopped]: 'Stopped',
  [ServiceStatusNumber.Expired]: 'Expired',
  [ServiceStatusNumber.Error]: 'Error'
}

// Statuses of a service job that is mid-start/restart and owned by an exclusive
// lifecycle operation. Single source of truth for getPendingServiceStarts (DB query) and
// the pipeline's staleness guard — the two MUST agree or a job can be picked up and then
// ignored (or vice versa). Restarting is included so a job orphaned by a crash
// mid-restart is recovered at boot exactly like a crash mid-start.
export const SERVICE_START_PENDING_STATUSES: readonly ServiceStatusNumber[] = [
  ServiceStatusNumber.Starting,
  ServiceStatusNumber.Locking,
  ServiceStatusNumber.PullImage,
  ServiceStatusNumber.BuildImage,
  ServiceStatusNumber.Claiming,
  ServiceStatusNumber.Restarting
]

export interface ServiceJob {
  serviceId: string // unique id for a running service — distinct from a compute jobId
  clusterHash: string
  environment: string // envId the service runs on — used for shared resource accounting + pricing
  owner: string // consumerAddress
  image: string
  tag?: string
  checksum?: string
  dockerfile?: string // inline Dockerfile (when built); kept so restart can rebuild
  additionalDockerFiles?: Record<string, string> // extra build-context files (only with dockerfile)
  dockerCmd?: string[] // container CMD override
  dockerEntrypoint?: string[] // container ENTRYPOINT override
  containerImage: string // resolved final reference used by Docker (image:tag, image@digest, or built name)
  containerId: string
  networkId: string // per-service Docker network id
  status: ServiceStatusNumber
  statusText: string
  dateCreated: string // ISO timestamp
  expiresAt: number // Unix ms timestamp
  duration: number // requested seconds
  exposedPorts: number[]
  endpoints: ServiceEndpoint[]
  userData?: string // ECIES(node key) string sent by the client; stored as-is, decrypted only at start/restart; never returned
  resources: ComputeResourceRequestWithPrice[]
  payment: DBComputeJobPayment // initial start payment
  extendPayments?: DBComputeJobPayment[] // one entry per successful SERVICE_EXTEND
}
