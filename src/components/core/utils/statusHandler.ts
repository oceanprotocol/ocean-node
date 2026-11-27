import os from 'os'
import {
  OceanNodeStatus,
  OceanNodeProvider,
  OceanNodeIndexer,
  StorageTypes,
  OceanNodeConfig,
  AuthTokenPolicyStatus
} from '../../../@types/OceanNode.js'
import { CORE_LOGGER } from '../../../utils/logging/common.js'
import { OceanNode } from '../../../OceanNode.js'
import { SupportedNetwork } from '../../../@types/blockchain.js'
import { humanizeHex } from '../../../utils/humanHash.js'
import { getPackageVersion } from '../../../utils/version.js'
import { getNodeOwnerInfo } from '../../../utils/config.js'

function getSupportedStorageTypes(config: OceanNodeConfig): StorageTypes {
  return {
    url: true,
    arwave: !!config.arweaveGateway,
    ipfs: !!config.ipfsGateway
  }
}

// platform information
const platformInfo = {
  cpus: os.cpus().length,
  freemem: os.freemem(),
  totalmem: os.totalmem(),
  loadavg: os.loadavg(),
  arch: os.arch(),
  machine: os.machine(),
  platform: os.platform(),
  osType: os.type(),
  node: process.version
}

// Node auth-token policy exposed in `status` (plan §17.2). Static config; safe in the cached
// status object. `crossNode: 'open'` is intentionally unreachable (enabling with an empty
// allowlist fails at startup), so an operator who wants to trust everyone must still enumerate.
function buildAuthTokenPolicy(config: OceanNodeConfig): AuthTokenPolicyStatus {
  const fallback = config.tokenRevocationFallback ?? 'cache'
  const crossNode = config.allowCrossNodeTokens ? 'allowlist' : 'disabled'
  const policy: AuthTokenPolicyStatus = {
    maxTokenLifetime: config.maxTokenLifetime ?? 86400,
    crossNode,
    revocationFallback: fallback,
    challengeSupported: true
  }
  // trustedIssuers exposed (user decision, plan §18.5 L2) — only meaningful in allowlist mode.
  if (crossNode === 'allowlist') {
    policy.trustedIssuers = config.trustedTokenIssuers ?? []
  }
  // softFailGrace is only consulted in 'cache' mode.
  if (fallback === 'cache') {
    policy.softFailGrace = config.tokenSoftFailGrace ?? 300
  }
  return policy
}

function getProviderInfo(config: OceanNodeConfig): OceanNodeProvider[] {
  const providers: OceanNodeProvider[] = []
  for (const [key, supportedNetwork] of Object.entries(config.supportedNetworks)) {
    const provider: OceanNodeProvider = {
      chainId: key,
      network: supportedNetwork.network
    }
    providers.push(provider)
  }
  return providers
}

async function getIndexerInfo(
  oceanNode: OceanNode,
  config: OceanNodeConfig
): Promise<OceanNodeIndexer[]> {
  const indexerNetworks: OceanNodeIndexer[] = []
  if (config.indexingNetworks) {
    for (const [key, indexedNetwork] of Object.entries(config.indexingNetworks)) {
      if (config.hasIndexer) {
        const blockNr = await getIndexerBlockInfo(oceanNode, indexedNetwork)
        const indexer: OceanNodeIndexer = {
          chainId: key,
          network: indexedNetwork.network,
          block: blockNr
        }
        indexerNetworks.push(indexer)
      }
    }
  }
  return indexerNetworks
}

async function getIndexerBlockInfo(
  oceanNode: OceanNode,
  supportedNetwork: SupportedNetwork
): Promise<string> {
  let blockNr = '0'
  try {
    const database = await oceanNode.getDatabase()
    if (!database || !database.indexer) {
      CORE_LOGGER.debug(
        `Indexer database is not available for network ${supportedNetwork.network}`
      )
      return blockNr
    }
    const { lastIndexedBlock } = await database.indexer.retrieve(supportedNetwork.chainId)
    blockNr = lastIndexedBlock.toString()
  } catch (error) {
    // a chain that is not indexed yet has no entry; real DB errors are logged by the DB layer
    CORE_LOGGER.error(
      `Error fetching last indexed block for network ${supportedNetwork.network}: ${error.message}`
    )
  }
  return blockNr
}

let nodeStatus: OceanNodeStatus = null

export async function status(
  oceanNode: OceanNode,
  nodeId?: string,
  detailed: boolean = false
): Promise<OceanNodeStatus> {
  CORE_LOGGER.debug('Command status started execution...')
  if (!oceanNode) {
    CORE_LOGGER.error('Node object not found. Cannot proceed with status command.')
    return
  }
  const config = oceanNode.getConfig()

  // no previous status?
  if (!nodeStatus) {
    const publicKey = oceanNode.getKeyManager().getPublicKey()
    const publicKeyHex = Buffer.from(publicKey).toString('hex')

    nodeStatus = {
      // Always identify THIS serving node. `nodeStatus` is a shared module-level cache built
      // once, and the caller-supplied `nodeId` (command `node`) would otherwise poison the
      // cached `id` for every later request — including the root `GET /` identity endpoint that
      // decryptDDO's `issuerPeerId` relies on. The handler still pins `id` to self on the
      // challenged response; keeping the cache self-identified makes the unchallenged response
      // agree. The `nodeId` param is retained for signature compatibility.
      id: oceanNode.getKeyManager().getPeerId().toString(),
      publicKey: publicKeyHex,
      friendlyName: humanizeHex(publicKeyHex),
      address: oceanNode.getKeyManager().getEthAddress(),
      version: getPackageVersion(),
      http: config.hasHttp,
      p2p: config.hasP2P,
      isPSConfigured: config.isPSConfigured,
      provider: [],
      indexer: [],
      escrowAddress: {},
      supportedStorage: getSupportedStorageTypes(config),
      // uptime: process.uptime(),
      platform: platformInfo,
      codeHash: config.codeHash,
      allowedAdmins: oceanNode.getAdminAddresses()
    }
  }
  // need to update at least block info if available
  if (config.supportedNetworks) {
    nodeStatus.provider = getProviderInfo(config)
    // NB: indexer status is intentionally NOT built here — it does a metadata-DB read per
    // indexing chain and is populated for detailed status only (see the detailed branch below),
    // so the basic/health-check path stays cheap and never blocks on the DB.
    for (const chain of Object.keys(config.supportedNetworks)) {
      nodeStatus.escrowAddress[chain] = oceanNode.escrow.getEscrowContractAddressForChain(
        parseInt(chain)
      )
    }
  }
  // Seconds reserved to claim an escrow payment (added to maxJobDuration when locking funds).
  // Set every request so a config reload never leaves a stale value.
  nodeStatus.claimDurationTimeout = config.claimDurationTimeout
  // Per-chain Subsidy Provider contract addresses configured on this node (empty map when none
  // are set). Set on every request, independent of supportedNetworks, so the field is always
  // present and never retains a stale value the config no longer defines.
  nodeStatus.subsidyProviders = config.subsidyProviders ?? {}
  nodeStatus.subsidyProviderFilter = config.subsidyProviderFilter ?? false
  // Per-subsidy-address docker image allowlist; empty map when unset (no gating).
  nodeStatus.subsidyProviderAllowedImages = config.subsidyProviderAllowedImages ?? {}
  // Auth-token policy (plan §17.2). Static config; set every request (like subsidyProviders) so a
  // config reload never leaves a stale value. `signedChallenge` is added per-request by the
  // handler and is deliberately NOT part of this cached object.
  nodeStatus.authTokenPolicy = buildAuthTokenPolicy(config)
  // getConfig() refreshes it from POLICY_SERVER_URL, so the cached status never goes stale.
  nodeStatus.isPSConfigured = config.isPSConfigured
  // Re-read on every request so the cached status follows NODE_OWNER_INFO changes.
  const ownerInfo = getNodeOwnerInfo()
  if (ownerInfo) {
    nodeStatus.ownerInfo = ownerInfo
  } else {
    delete nodeStatus.ownerInfo
  }
  // Whether the P2P interface is usable, not just enabled. Re-read on every request rather
  // than cached with the block above: the routing table fills after startup, so a value
  // captured once would report a node as permanently not-ready.
  if (config.hasP2P && oceanNode.hasP2PInterface()) {
    const p2pNode = oceanNode.getP2PNode()
    nodeStatus.p2pStatus = p2pNode ? p2pNode.getP2PStatus() : undefined
  } else {
    delete nodeStatus.p2pStatus
  }

  // only these 2 might change between requests
  nodeStatus.platform.freemem = os.freemem()
  nodeStatus.platform.loadavg = os.loadavg()
  nodeStatus.uptime = process.uptime()

  // Maintenance (drain) signal. Built as a LOCAL object and assigned to nodeStatus.maintenance
  // only once, after all awaits below complete. nodeStatus is a shared module-level object, so
  // mutating nodeStatus.maintenance in place across the awaits in the detailed branch could let
  // a concurrent request observe a half-populated value (or reset its counts). `enabled` is the
  // always-present signal; the drain-visibility counts are populated for detailed status only.
  const maintenance: NonNullable<OceanNodeStatus['maintenance']> = {
    enabled: oceanNode.isInMaintenance()
  }

  // depends on request. Built into LOCALS (not written to the shared, cached `nodeStatus`) and
  // merged into a per-request shallow copy at the return below — same reasoning as the
  // maintenance block: a concurrent basic request would otherwise `delete` these keys while a
  // detailed request is populating them (and vice versa), racing on the shared object.
  let c2dClusters: OceanNodeStatus['c2dClusters']
  let supportedSchemas: OceanNodeStatus['supportedSchemas']
  let indexer: OceanNodeStatus['indexer']
  if (detailed) {
    // Indexer status reads lastIndexedBlock from the metadata DB once per indexing chain, so it
    // only runs on the detailed path. Built into a local and merged into the per-request shallow
    // copy at the return below (same reasoning as c2dClusters / maintenance): it is never written
    // to the shared, cached `nodeStatus`, where a concurrent basic request could observe it.
    indexer = await getIndexerInfo(oceanNode, config)
    c2dClusters = []
    try {
      const engines = await oceanNode.getC2DEngines().getAllEngines()
      for (const engine of engines) {
        const type = await engine.getC2DType()
        c2dClusters.push({
          type,
          hash: await engine.getC2DConfig().hash,
          environments: await engine.getComputeEnvironments()
        })
      }
    } catch (error) {
      // also hit on every detailed status request of a node without C2D
      CORE_LOGGER.throttled(
        'status-c2d-clusters',
        'error',
        `Error getting c2d clusters: ${error.message}`
      )
    }
    supportedSchemas = (await oceanNode.getDatabase())?.ddo?.getSchemas()

    // Drain-visibility counts: how much already-committed work is still running, so an admin
    // can tell when the node is drained and safe to reboot. Wrapped in try/catch + throttled
    // logging (like the c2dClusters block above) so a node without C2D does not error.
    try {
      let latestExpectedEndTime = 0
      const database = await oceanNode.getDatabase()
      if (database?.c2d) {
        // Count every not-yet-finished job (dateFinished IS NULL), not only those in the
        // RunningAlgorithm state: a draining node still holds resources for jobs that are
        // starting / pulling the image / configuring / publishing, and the admin must see
        // them before deciding it is safe to reboot. getJobs(..., runningJobs=true) filters
        // to RunningAlgorithm only, which undercounts.
        const jobs = await database.c2d.getRunningJobs()
        maintenance.runningComputeJobs = jobs.length
        for (const job of jobs) {
          // maxJobDuration is the RUNTIME budget, measured from when the algorithm starts
          // executing (algoStartTimestamp, decimal-seconds TEXT, "0"/absent until then), NOT
          // from creation. A job that queued or provisioned first finishes LATER than
          // dateCreated + maxJobDuration, so the ETA must use the runtime start once it is set,
          // or it can fall before a still-running job's real completion. Fall back to
          // dateCreated before execution begins. parseFloat, not Date.parse: the latter returns
          // NaN for "1730000000.123" and would silently drop every job from the ETA.
          const start = Math.max(
            parseFloat(job.algoStartTimestamp) || 0,
            parseFloat(job.dateCreated)
          )
          const end = start + (job.maxJobDuration ?? 0)
          if (Number.isFinite(end) && end > latestExpectedEndTime) {
            latestExpectedEndTime = end
          }
        }
      }
      // Services live on the C2D engines; a node without C2D simply reports no services
      // (and never errors). Computed separately so a missing engine does not drop the
      // compute-job count set above.
      const c2dEngines = oceanNode.getC2DEngines()
      if (c2dEngines) {
        let runningServices = 0
        const engines = await c2dEngines.getAllEngines()
        for (const engine of engines) {
          const hash = await engine.getC2DConfig().hash
          const services = await engine.db.getRunningServiceJobs(hash)
          runningServices += services.length
          for (const svc of services) {
            const end = Math.floor((svc.expiresAt ?? 0) / 1000)
            if (end > latestExpectedEndTime) {
              latestExpectedEndTime = end
            }
          }
        }
        maintenance.runningServices = runningServices
      }
      if (latestExpectedEndTime > 0) {
        maintenance.latestExpectedEndTime = latestExpectedEndTime
      }
    } catch (error) {
      CORE_LOGGER.throttled(
        'status-maintenance-drain',
        'error',
        `Error computing maintenance drain counts: ${error.message}`
      )
    }
  }

  // Assign the fully-built maintenance object once, after all awaits above, so a concurrent
  // request never observes it mid-population.
  nodeStatus.maintenance = maintenance

  if (config.persistentStorage) {
    nodeStatus.persistentStorage = {}
    if (config.persistentStorage.accessLists)
      nodeStatus.persistentStorage.accessLists = config.persistentStorage.accessLists
    nodeStatus.persistentStorage.allowBucketSharing =
      config.persistentStorage.allowBucketSharing === true
  }

  // Detailed cluster data lives only on the per-request response, never on the shared cache.
  // A basic request returns the shared object (which never carries these keys, so
  // `c2dClusters` / `supportedSchemas` are absent as before).
  if (detailed) {
    return { ...nodeStatus, indexer, c2dClusters, supportedSchemas }
  }
  return nodeStatus
}
