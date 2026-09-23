import type {
  DBComputeJobPayment,
  DBComputeJobMetadata,
  ComputeResourceRequestWithPrice,
  ContainerMetricsSnapshot
} from './C2D.js'

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
  required?: boolean // advisory hint: the app cannot do its job without it (e.g. HF_TOKEN for a gated model). Not enforced node-side.
}

// ── Catalogue classification (advisory; consumed by UIs) ───────────────

// How an entry presents itself. Absent means 'service' — every template published before this field.
export type ServiceTemplateKind = 'service' | 'bundle'

// Closed set so catalogue buckets stay consistent across nodes.
// Pinned: prettier 2 collapses this union onto one line, prettier 3 keeps the leading pipes,
// and CI resolves a different one than a local install does — so the two never agree on it.
// prettier-ignore
export type ServiceTemplateCategory =
  | 'image'
  | 'video'
  | 'llm'
  | 'serving'
  | 'notebook'
  | 'embeddings'
  | 'app'
  | 'other'

// One thing a bundle pre-downloads. Display metadata only: the template's own
// `command`/`commandFile` does the fetching, and nothing here is verified node-side.
export interface TemplateIncludedItem {
  name: string
  kind: 'model' | 'workflow' | 'customnode' | 'other'
  sizeGb?: number // download size — drives the "N models, X GB" line and setup-time hints
  repoId?: string // Hugging Face repo id, when the item is a plain HF repo
  url?: string // direct download URL for anything that isn't a plain HF repo
}

export interface ServiceTemplateWorkflow {
  id: string // [A-Za-z0-9_.-]+ — becomes a filename and a ?template= value
  name: string
  description?: string
  file?: string // path relative to the templates dir; inlined into `graph` at load time
  graph?: unknown // the workflow JSON itself
}

export interface ServiceTemplate {
  id: string // [a-z0-9][a-z0-9_-]{0,63}
  name?: string
  description?: string
  // ── Catalogue metadata — advisory, never affects how the container runs ──
  kind?: ServiceTemplateKind // default 'service'
  service?: string // bundles only: id of the service template this is a variant of
  outcome?: string // bundles only: the one concrete thing this gets done
  category?: ServiceTemplateCategory
  includes?: TemplateIncludedItem[] // bundles only: manifest of what the command downloads
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
  // path relative to the templates dir; inlined into command[0] at load time and dropped
  // (mutually exclusive with `command`)
  commandFile?: string
  entrypoint?: string[] // Docker ENTRYPOINT override
  requiredResources?: TemplateResourceRequirement[] // MUST satisfy — gates SERVICE_START
  recommendedResources?: TemplateResourceRequirement[] // SHOULD satisfy — used for scoring + UI
  workflows?: ServiceTemplateWorkflow[] // client-selectable graphs; no operator secrets, so public
}

// ── Public / sanitized types ──────────────────────────────────────────

// Safe to return in API responses: envVars values are stripped (keys only). Choosing a
// matching compute environment is the client's responsibility (see GET_COMPUTE_ENVIRONMENTS).
export interface ServiceTemplatePublic extends Omit<ServiceTemplate, 'envVars'> {
  envVarKeys?: string[] // keys of envVars only, never values
}

// ── Operational config (per Docker daemon, not global) ────────────────

// Service duration cap applied when a daemon carries no `serviceOnDemand` block, or one
// that omits `maxDurationSeconds`. Single source of truth for the config schema's default,
// the SERVICE_START / SERVICE_EXTEND checks and the `maxServiceDuration` every compute
// environment advertises — those three must never disagree.
export const DEFAULT_SERVICE_MAX_DURATION_SECONDS = 86400 // 24 h

// Daemon-level service floor when `serviceOnDemand` omits `minDurationSeconds`. Zero means
// "no daemon floor", so an environment's own minServiceDuration (which itself falls back to
// minJobDuration) is what applies — keeping an unconfigured node billing exactly as before.
export const DEFAULT_SERVICE_MIN_DURATION_SECONDS = 0

export interface ServiceOnDemandConfig {
  enabled: boolean
  nodeHost: string // host (or IP) clients use to reach forwarded service ports; e.g. 'localhost'
  hostPortRange?: [number, number] // e.g. [30000, 32767]; specific to this daemon's host
  minDurationSeconds?: number // default: DEFAULT_SERVICE_MIN_DURATION_SECONDS (no daemon floor)
  maxDurationSeconds?: number // default: DEFAULT_SERVICE_MAX_DURATION_SECONDS (24 h)
  allowImageBuild?: boolean // default: false — gates Dockerfile-based services per daemon
}

// ── Readiness + startup progress ──────────────────────────────────────

/**
 * Whether a service can actually serve requests, as opposed to merely having a running container.
 *
 * `Running` says the container process started. An inference engine then spends minutes downloading
 * weights and warming up, during which its forwarded port either refuses connections or answers 503
 * — so a consumer handed the endpoint at `Running` gets nothing but errors. The node closes that gap
 * by asking the workload itself, on a schedule, and reporting the answer here.
 *
 * Only reported for workloads the node recognizes (see components/c2d/serviceEngines). For anything
 * else the field is ABSENT, which every client must read as "this node cannot tell me" and fall back
 * to treating `Running` as usable — the behaviour that predates this feature.
 */
export type ServiceReadinessState =
  | 'waiting' // not answering as expected yet — the normal warm-up window
  | 'ready' // answered the engine's readiness request
  | 'failing' // it WAS ready and stopped answering

export interface ServiceReadiness {
  state: ServiceReadinessState
  engine: string // which profile decided this ('vllm'), so a client can say what was checked
  readySince?: number // Unix ms of the first successful check of THIS container
  lastCheckedAt?: number // Unix ms
  consecutiveFailures?: number
  httpStatus?: number // last response status (absent when the connection itself failed)
  lastError?: string // owner-only: stripped from SERVICE_LIST
  probedUrl?: string // owner-only: which candidate address answered (diagnostics)
}

/**
 * Live progress of the image pull, aggregated from the Docker daemon's own per-layer byte
 * counts. Written only while the job sits in PullImage, and kept afterwards as the record of
 * what was downloaded (a cached image never produces one — absence means "already on the node").
 *
 * `totalBytes` is the sum of the layer totals Docker has ANNOUNCED so far, which grows as
 * layers start, so `percent` is clamped monotonic rather than recomputed each tick.
 */
export interface ServiceImagePullProgress {
  phase: 'downloading' | 'extracting' | 'complete'
  downloadedBytes: number
  totalBytes: number
  percent: number
  layersTotal: number
  layersDone: number
  updatedAt: number // Unix ms
}

/**
 * How much of its model a recognized engine has downloaded, read from the container's own cache.
 *
 * This is the wait the image pull does NOT cover: the image is pulled once per node and cached
 * forever after, while the weights are fetched on every container start, by the engine, after it
 * reports Running.
 *
 * `totalBytes`/`percent` are present only when the size could be established — the engine is
 * serving a Hugging Face repo AND the Hub published a safetensors index for it. Pointed at a local
 * path, an object-store URI or an unindexed repo, only `downloadedBytes` is reported and the client
 * shows an indeterminate bar rather than a ratio against a guess.
 */
export interface ServiceModelDownload {
  modelId?: string // the repo being fetched, when it is a Hub id
  downloadedBytes: number
  totalBytes?: number
  percent?: number
  filesComplete: number
  filesInFlight: number // the hub fetches files in parallel, so only the aggregate is meaningful
  updatedAt: number // Unix ms
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
  updatedAt?: number
  expiresAt: number // Unix ms timestamp
  duration: number // requested seconds
  exposedPorts: number[]
  endpoints: ServiceEndpoint[]
  userData?: string // ECIES(node key) string sent by the client; stored as-is, decrypted only at start/restart; never returned
  // Arbitrary, node-opaque user labels (≤1 KB when JSON-stringified). Set at SERVICE_START,
  // optionally replaced at SERVICE_RESTART. Returned only to the owner via toPublicServiceJob
  // (SERVICE_GET_STATUS is authenticated + owner-scoped) and stripped from the node-wide
  // SERVICE_LIST (toListedServiceJob). Shares the DBComputeJob.metadata type; note the
  // compute equivalent is readable by anyone holding the jobId, whereas this is owner-only.
  metadata?: DBComputeJobMetadata
  outputBucketId?: string // persistent-storage bucket bind-mounted at /data/outputs
  resources: ComputeResourceRequestWithPrice[]
  payment: DBComputeJobPayment // initial start payment
  extendPayments?: DBComputeJobPayment[] // one entry per successful SERVICE_EXTEND
  // Best-effort Docker/NVML runtime metrics sampled while the service container runs.
  // DB-only: stripped from every public response by toPublicServiceJob / toListedServiceJob.
  runtimeMetrics?: ContainerMetricsSnapshot
  // Whether the workload can serve requests yet, for engines the node recognizes. Absent otherwise,
  // which clients read as "not reported" and fall back to treating Running as usable.
  readiness?: ServiceReadiness
  // Image pull byte progress, written while the job is in PullImage.
  imagePull?: ServiceImagePullProgress
  // Model-weight download progress, sampled from the container's cache while it warms up.
  modelDownload?: ServiceModelDownload
}
