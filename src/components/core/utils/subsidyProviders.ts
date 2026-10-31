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
