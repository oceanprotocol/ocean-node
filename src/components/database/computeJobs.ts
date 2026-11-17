// What all compute stores know about jobs and service jobs, whatever the backend.
import type { DBComputeJob } from '../../@types/C2D/C2D.js'
import type { ServiceJobExpected } from './C2DDatabase.js'
import {
  ServiceStatusNumber,
  SERVICE_STOPPED_STATUSES,
  isStoppedLike,
  type ServiceJob
} from '../../@types/C2D/ServiceOnDemand.js'

// Every status before Expired is "active": the consumer paid for the resources for a TIME
// WINDOW, so the reservation holds from the moment the record is created (Starting) through
// the whole start pipeline, while Running/Restarting/Stopping, through Error (container died
// on its own) AND through an explicit Stopped — a stopped service can be restarted anytime on
// the same resources until expiresAt. Only expiry releases the reservation.
export const ACTIVE_SERVICE_STATUSES = [
  ServiceStatusNumber.Starting,
  ServiceStatusNumber.Locking,
  ServiceStatusNumber.PullImage,
  ServiceStatusNumber.BuildImage,
  ServiceStatusNumber.Claiming,
  ServiceStatusNumber.Running,
  ServiceStatusNumber.Restarting,
  ServiceStatusNumber.Stopping,
  ...SERVICE_STOPPED_STATUSES,
  ServiceStatusNumber.Error
]

// Running, Error and Stopped all still hold their paid reservation, so all must be swept once
// past expiresAt: the sweep is the ONLY place the reservation is released. Stopping is swept
// too: a process crash mid-stop persists that status and nothing else recovers it.
export const EXPIRABLE_SERVICE_STATUSES = [
  ServiceStatusNumber.Running,
  ServiceStatusNumber.Error,
  ...SERVICE_STOPPED_STATUSES,
  ServiceStatusNumber.Stopping
]

// The node-internal job fields that live in the unindexed body.
export function jobToBody(job: DBComputeJob): any {
  return {
    clusterHash: job.clusterHash,
    configlogURL: job.configlogURL,
    publishlogURL: job.publishlogURL,
    algologURL: job.algologURL,
    outputsURL: job.outputsURL,
    stopRequested: job.stopRequested,
    algorithm: job.algorithm,
    assets: job.assets,
    isRunning: job.isRunning,
    isStarted: job.isStarted,
    containerImage: job.containerImage,
    resources: job.resources,
    isFree: job.isFree,
    algoStartTimestamp: job.algoStartTimestamp,
    algoStopTimestamp: job.algoStopTimestamp,
    metadata: job.metadata,
    additionalViewers: job.additionalViewers,
    terminationDetails: job.terminationDetails,
    payment: job.payment,
    algoDuration: job.algoDuration,
    queueMaxWaitTime: job.queueMaxWaitTime,
    // a queued job pulls its image later, with the registry auth of the user
    encryptedDockerRegistryAuth: job.encryptedDockerRegistryAuth,
    output: job.output,
    outputBucketId: job.outputBucketId,
    jobIdHash: job.jobIdHash,
    buildStartTimestamp: job.buildStartTimestamp,
    buildStopTimestamp: job.buildStopTimestamp,
    // Runtime metrics snapshot. It MUST round-trip through the body: it is what the owner
    // reads back on COMPUTE_GET_STATUS, and it is also the previous-sample accumulator every
    // next sample needs — without it persisted, every sample is a "first sample", so CPU %
    // can never be computed (no delta) and the memory peak never accumulates. Still
    // node-internal on the way out: omitDBComputeFieldsFromComputeJob strips it unless the
    // verified owner asked for it, so it stays out of the escrow claim proof.
    runtimeMetrics: job.runtimeMetrics
  }
}

// agreementIds are stored as given; match both the 0x-prefixed and the bare form
export function agreementIdVariants(agreementId: string): string[] {
  return agreementId.startsWith('0x')
    ? [agreementId, agreementId.slice(2)]
    : [agreementId, '0x' + agreementId]
}

// A best-effort patch of a service job (metrics, readiness) is written only when the
// lifecycle fields are still the ones that the caller saw.
export function matchesExpected(job: ServiceJob, expected: ServiceJobExpected): boolean {
  return (
    job.owner === expected.owner &&
    job.clusterHash === expected.clusterHash &&
    job.status === expected.status &&
    job.containerId === expected.containerId
  )
}

// The reservation is tied to PAYMENT: an Error or Stopped service whose payment was never
// claimed must not hold resources, or anyone could keep the GPU of a node for free with an
// empty escrow account. The statuses before Running keep the reservation without a claimTx.
export function holdsReservation(job: ServiceJob): boolean {
  return (
    (job.status !== ServiceStatusNumber.Error && !isStoppedLike(job.status)) ||
    !!job.payment?.claimTx
  )
}
