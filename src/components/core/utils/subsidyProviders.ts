import { isAddress, getAddress } from 'ethers'
import { OceanNodeConfig } from '../../../@types/OceanNode.js'

// The Escrow v2 contract caps the number of UNIQUE sponsors per lock at `maxSponsorsPerLock()`
// (== 10) and reverts `createLock`/`reLock` with "Too many sponsors" beyond it. We mirror that
// limit node-side so an over-long list is rejected cheaply (a 400) instead of costing an
// `estimateGas` round-trip on a guaranteed on-chain revert. Kept in sync with the contract
// constant; if the contract ever changes it, update here (or read it on-chain).
export const MAX_SUBSIDY_PROVIDERS_PER_LOCK = 10

export interface ResolvedSubsidyProviders {
  valid: boolean
  // Present only when valid === false: a human-readable reason for the rejection.
  reason?: string
  // Present only when valid === true. The resolved override to persist on the job and hand to the
  // escrow claim:
  //   undefined  → the user sent nothing; fall back to the node config at claim time
  //   []         → the user explicitly wants NO subsidy providers
  //   non-empty  → use exactly these (EIP-55 checksummed) addresses, ignoring node config
  resolved?: string[]
}

/**
 * Resolve and validate a user-supplied subsidy-provider list for a single-chain request
 * (startCompute / startService / serviceExtend).
 *
 * Semantics of `userList`:
 *   - `undefined`  → the user opted out; the node config is used (returned as `resolved: undefined`)
 *   - `[]`         → the user wants no providers (returned as `resolved: []`)
 *   - non-empty    → the user picks exactly these providers (returned checksummed)
 *
 * Snapshot vs live-config asymmetry (important for async/batched settlement): an *explicit* user
 * choice (`[]` or a non-empty list) is a concrete value that callers persist on the job and feed to
 * the escrow claim unchanged — it is frozen at request time. The `undefined` case persists nothing;
 * the escrow then falls back to the node's `SUBSIDY_PROVIDERS` read *live* at claim time, which for
 * a batched/async compute claim may run minutes-to-hours later and reflect a different node config
 * than the one this request was validated against. That matches the pre-existing node-config-only
 * behavior; only an explicit user list is guaranteed to survive a mid-flight config change.
 *
 * Every supplied address must be a valid EVM address. When `SUBSIDY_PROVIDER_FILTER` is ON, every
 * supplied address must also be in the node's `subsidyProviders` whitelist for `chainId`; any
 * address outside the whitelist rejects the whole request. An empty list is always allowed (it is
 * a subset of any whitelist).
 */
export function resolveUserSubsidyProviders(
  userList: string[] | undefined,
  chainId: number,
  config: OceanNodeConfig
): ResolvedSubsidyProviders {
  // No list supplied → fall back to node config at claim time.
  if (userList === undefined || userList === null) {
    return { valid: true, resolved: undefined }
  }
  if (!Array.isArray(userList)) {
    return { valid: false, reason: 'subsidyProviders must be an array of addresses' }
  }

  // Validate + normalize every entry to its checksummed form.
  const invalid: string[] = []
  const normalized: string[] = []
  for (const addr of userList) {
    if (typeof addr !== 'string' || !isAddress(addr)) {
      invalid.push(String(addr))
      continue
    }
    normalized.push(getAddress(addr))
  }
  if (invalid.length > 0) {
    return {
      valid: false,
      reason: `Invalid subsidy provider address(es): ${invalid.join(', ')}`
    }
  }

  // Collapse duplicates: the escrow counts UNIQUE sponsors, so a repeated address is a single
  // sponsor. De-duping here keeps the persisted/forwarded list minimal and makes the cap below
  // count the same way the contract does.
  const deduped = Array.from(new Set(normalized))

  // Enforce the contract's per-lock sponsor cap locally (see MAX_SUBSIDY_PROVIDERS_PER_LOCK).
  if (deduped.length > MAX_SUBSIDY_PROVIDERS_PER_LOCK) {
    return {
      valid: false,
      reason: `Too many subsidy providers: ${deduped.length} unique (max ${MAX_SUBSIDY_PROVIDERS_PER_LOCK} per lock)`
    }
  }

  // Whitelist enforcement: only addresses already configured on this node (for the request chain)
  // are allowed through when the filter is ON.
  if (config.subsidyProviderFilter) {
    const whitelist = new Set(
      (config.subsidyProviders?.[String(chainId)] ?? []).map((addr) => getAddress(addr))
    )
    const disallowed = deduped.filter((addr) => !whitelist.has(addr))
    if (disallowed.length > 0) {
      return {
        valid: false,
        reason: `Subsidy provider(s) not allowed by this node for chain ${chainId}: ${disallowed.join(
          ', '
        )}`
      }
    }
  }

  return { valid: true, resolved: deduped }
}

// The subset of a docker container spec the image gate matches against. All optional. A
// dockerfile-built image is user-built (NOT a trusted operator image) and the engine runs it under
// a synthetic reference, so a non-empty `dockerfile` always makes the gate match nothing — even
// when `image`/`tag` are also supplied, which the compute (raw-code) path allows.
export interface SubsidyImageContainer {
  image?: string
  tag?: string
  checksum?: string
  dockerfile?: string
}

// A docker entrypoint/cmd override is "custom" when the request/DDO carries a non-empty value.
// Handles both the service shape (`string[]`) and the compute container shape (`string`);
// whitespace-only strings count as empty. Shared by the gate call sites so "no custom
// entrypoint/cmd" means the same thing everywhere.
export function isNonEmpty(value: string | string[] | null | undefined): boolean {
  if (value === null || value === undefined) return false
  if (Array.isArray(value)) return value.length > 0
  return value.trim().length > 0
}

/**
 * True when `entry` (an operator allowlist docker reference) matches `container`.
 *
 * Normal entries are compared against the SINGLE reference the node would actually resolve
 * `container` to — matching exactly the image the engine runs. This mirrors `resolveServiceImage`'s
 * priority (`serviceResourceMatching.ts`): dockerfile > checksum > tag:
 *   - a non-empty `dockerfile` → a user-built synthetic image → matches NOTHING (returns false),
 *   - else a `checksum` → `image@checksum` (the tag, if any, is ignored — just as the engine does),
 *   - else → `image:${tag ?? 'latest'}`.
 * Building a single candidate (not one per tag/checksum) is a security requirement: a job that
 * carries BOTH a trusted `tag` and an attacker-controlled `checksum` runs the digest, so matching
 * the tag candidate would subsidize the wrong image. An operator may still pin by tag OR by sha256
 * — each allowlist entry is compared against the one reference the engine resolves.
 *
 * WILDCARD TAG: an entry of the form `name:*` matches ANY tag or digest of `name` (e.g.
 * `oceanprotocol/example:*` matches `…:latest`, `…:v1.2` and `…@sha256:…`). It is for operators who
 * control the publish process for an image and trust every version of it. A dockerfile-built image
 * still never matches (the guard above runs first). The wildcard applies to the WHOLE image name,
 * not a prefix — `oceanprotocol/*` is a literal name, not a glob.
 */
export function imageReferenceMatches(
  container: SubsidyImageContainer | null | undefined,
  entry: string
): boolean {
  if (!container || !container.image) return false
  // dockerfile wins in resolveServiceImage → a synthetic, user-built reference → never trusted.
  if (isNonEmpty(container.dockerfile)) return false
  const trimmed = (entry ?? '').trim()
  if (trimmed.length === 0) return false
  // Wildcard tag `name:*` → any tag/digest of that exact image name (`:*` at the very end; the name
  // may itself contain a registry `host:port`, so split on the trailing `:*` only).
  if (trimmed.endsWith(':*')) {
    const name = trimmed.slice(0, -2)
    return name.length > 0 && container.image === name
  }
  const candidate = container.checksum
    ? `${container.image}@${container.checksum}`
    : `${container.image}:${container.tag ?? 'latest'}`
  return candidate === trimmed
}

/**
 * Apply the per-address image gate (`SUBSIDY_PROVIDER_ALLOWED_IMAGES`) to an already-resolved
 * effective subsidy list.
 *
 *   - `!allowedImages || zero keys` → gate OFF; every address kept (legacy behavior). `{}`
 *     deliberately means "no restrictions", NOT "kill all subsidy".
 *   - otherwise, per address in `effective`:
 *       · NOT a key in the map → kept (the gate only restricts the addresses it lists; an unlisted
 *         address has already cleared SUBSIDY_PROVIDER_FILTER and passes through).
 *       · a key → kept ONLY when the job has no custom entrypoint/cmd AND its image matches one of
 *         that address's allowed refs; otherwise dropped.
 *
 * Returns the surviving `kept` list (used for the lock + claim + persisted `subsidyProviders`) and
 * the `dropped` list (persisted as `payment.droppedSubsidies` for observability). Pure: no config
 * or network reads, so it unit-tests like `resolveUserSubsidyProviders`.
 */
export function filterSubsidyByAllowedImages(
  effective: string[],
  container: SubsidyImageContainer | null | undefined,
  hasCustomEntrypoint: boolean,
  allowedImages: Record<string, string[]> | null | undefined
): { kept: string[]; dropped: string[] } {
  if (!allowedImages || Object.keys(allowedImages).length === 0) {
    return { kept: effective, dropped: [] }
  }
  // Normalize the map keys to their checksummed form before lookup. The config schema already
  // checksums keys, so this is a no-op for config-loaded maps — but it makes the gate correct for
  // ANY caller (a map built in a test or set programmatically), so a lowercase/mixed-case key can
  // never silently fail to match a checksummed effective address and leak a subsidy. Keys that are
  // not addresses are kept as-is (they can never equal a checksummed address → never match).
  const normalized = new Map<string, string[]>()
  for (const [rawKey, list] of Object.entries(allowedImages)) {
    let key: string
    try {
      key = getAddress(rawKey)
    } catch {
      key = rawKey
    }
    const existing = normalized.get(key)
    normalized.set(key, existing ? [...existing, ...(list ?? [])] : (list ?? []))
  }
  const kept: string[] = []
  const dropped: string[] = []
  for (const addr of effective) {
    const key = getAddress(addr)
    const list = normalized.get(key)
    if (list === undefined) {
      // Address not named in the map → the gate does not apply to it.
      kept.push(addr)
      continue
    }
    // imageReferenceMatches already returns false for a null/imageless/dockerfile container.
    const allowed =
      !hasCustomEntrypoint &&
      list.some((entry) => imageReferenceMatches(container, entry))
    if (allowed) kept.push(addr)
    else dropped.push(addr)
  }
  return { kept, dropped }
}

// The job shape the restart gate reads: the start's applied subsidy providers plus every
// extension's payment record. Kept structural (not the full ServiceJob) so this module stays
// dependency-light and unit-testable.
interface SubsidizedJobView {
  payment?: { subsidyProviders?: string[] } | null
  extendPayments?: Array<{
    claimTx?: string
    cancelTx?: string
    subsidyProviders?: string[]
  }> | null
}

/**
 * The subsidy addresses a RESPEC `SERVICE_RESTART` would strand on a non-allowed image — i.e. the
 * ones the image gate drops for the NEW container spec. The "applied" set a restart runs on is the
 * START's providers UNION every CLAIMED extension's providers (claimTx set, not cancelled): a service
 * can start UNSUBSIDIZED and be extended WITH subsidy, and the restart runs on that extended
 * (subsidized) window, so extension sponsors must gate the restart too. Returns `[]` when the job is
 * unsubsidized or the gate is off.
 *
 * Shared by the restart handler (fast-fail 403 on the pre-lock read) and the engine's
 * `restartService` (authoritative backstop on the fresh row under the lifecycle lock — closes the
 * TOCTOU where a concurrent `serviceExtend` subsidizes the job after the handler's read).
 */
export function restartSubsidyDropped(
  job: SubsidizedJobView,
  container: SubsidyImageContainer | null | undefined,
  hasCustomEntrypoint: boolean,
  allowedImages: Record<string, string[]> | null | undefined
): string[] {
  const applied = Array.from(
    new Set([
      ...(job.payment?.subsidyProviders ?? []),
      ...(job.extendPayments ?? [])
        .filter((p) => p.claimTx && !p.cancelTx)
        .flatMap((p) => p.subsidyProviders ?? [])
    ])
  )
  if (applied.length === 0) return []
  return filterSubsidyByAllowedImages(
    applied,
    container,
    hasCustomEntrypoint,
    allowedImages
  ).dropped
}

/**
 * COMPUTE-only: true when the job supplies its own algorithm from ANY external source — inline raw
 * code (`meta.rawcode`), a direct file (`fileObject`), or a published algorithm DID
 * (`documentId`/`serviceId`).
 *
 * For compute the subsidized workload is NOT the image alone: a generic algorithm-runner image
 * executes whatever is mounted at `/data/transformations/algorithm`, so an allowlisted image with an
 * empty entrypoint still runs attacker-chosen code delivered as the algorithm. A published
 * `documentId` is no safer than inline code here — anyone can publish an algorithm DDO that installs
 * and starts a miner, then point a subsidized job at it — so a DID algorithm disqualifies subsidy
 * exactly like `rawcode`/`fileObject`. Only a SELF-CONTAINED allowlisted image (empty entrypoint AND
 * no external algorithm of any kind) qualifies: the image's own baked `ENTRYPOINT` does all the work
 * and the mounted algorithm cannot change what runs.
 */
export function hasUserSuppliedAlgorithm(
  algorithm:
    | {
        meta?: { rawcode?: string } | null
        fileObject?: unknown
        documentId?: string | null
        serviceId?: string | null
      }
    | null
    | undefined
): boolean {
  if (!algorithm) return false
  return (
    isNonEmpty(algorithm.meta?.rawcode) ||
    algorithm.fileObject != null ||
    isNonEmpty(algorithm.documentId) ||
    isNonEmpty(algorithm.serviceId)
  )
}
