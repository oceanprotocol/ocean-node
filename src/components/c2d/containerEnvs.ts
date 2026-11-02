import { CORE_LOGGER } from '../../utils/logging/common.js'

// Node-owner environment injection for every container the node spawns — C2D algorithm
// containers and Service-on-Demand containers (docs/compute.md, docs/services.md). Driven by
// the single `PASS_CONTAINER_ENVS` knob (config `passContainerEnvs`). HF_ENDPOINT for a local
// Hugging Face mirror is the motivating example, but any infra var (proxies, registry mirrors,
// log levels, …) works. SECURITY: every value here is readable inside the (third-party)
// container, so never put secrets/tokens in it — see docs/env.md.

// Keys the node sets itself for the C2D pod contract. The owner must not be able to shadow
// these: they are dropped at parse time (with a warning) and, defensively, again at merge time.
export const RESERVED_CONTAINER_ENV_KEYS = ['DIDS', 'TRANSFORMATION_DID'] as const

// POSIX-style env var names. Anything else would serialize to a malformed `KEY=value` entry in
// Docker's Env array, so it is skipped. The explicit denylist blocks prototype-pollution-shaped
// keys that would pass the regex but misbehave as plain-object property names.
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype'])
function isValidEnvKey(k: string): boolean {
  return ENV_KEY_RE.test(k) && !DANGEROUS_KEYS.has(k)
}

// Parse the `PASS_CONTAINER_ENVS` value into a plain {KEY: value} map. Accepts either a JSON
// object (`{"FOO":"bar"}`) or a JSON array of `KEY=value` strings (`["FOO=bar"]`); an array
// entry is split on the FIRST '=' so values may contain '='. Keys are validated and reserved
// keys are dropped here (once, at config load). Fail-soft: unset, empty, or malformed input
// logs and yields `{}` (feature off) rather than throwing — this is called from the config
// transform at startup, so it must never refuse to boot the node.
export function parsePassContainerEnvs(raw: unknown): Record<string, string> {
  if (raw === undefined || raw === null || raw === '' || raw === 'undefined') return {}
  let parsed: unknown = raw
  if (typeof raw === 'string') {
    const trimmed = raw.trim()
    if (!trimmed) return {}
    try {
      parsed = JSON.parse(trimmed)
    } catch (e) {
      CORE_LOGGER.error(`PASS_CONTAINER_ENVS: not valid JSON (${e?.message}) — ignored`)
      return {}
    }
  }
  const reserved = new Set<string>(RESERVED_CONTAINER_ENV_KEYS)
  const out: Record<string, string> = {}
  const put = (key: string, value: string) => {
    if (!isValidEnvKey(key)) {
      CORE_LOGGER.warn(`PASS_CONTAINER_ENVS: "${key}" is not a valid env name — skipped`)
      return
    }
    if (reserved.has(key)) {
      CORE_LOGGER.warn(
        `PASS_CONTAINER_ENVS: "${key}" is reserved by the node and cannot be set — skipped`
      )
      return
    }
    out[key] = value
  }
  if (Array.isArray(parsed)) {
    for (const item of parsed) {
      if (typeof item !== 'string') {
        CORE_LOGGER.warn('PASS_CONTAINER_ENVS: array entry is not a string — skipped')
        continue
      }
      const eq = item.indexOf('=')
      if (eq <= 0) {
        CORE_LOGGER.warn(`PASS_CONTAINER_ENVS: "${item}" is not KEY=value — skipped`)
        continue
      }
      put(item.slice(0, eq), item.slice(eq + 1))
    }
    return out
  }
  if (parsed && typeof parsed === 'object') {
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === 'string') put(k, v)
      else if (typeof v === 'number' || typeof v === 'boolean') put(k, String(v))
      else
        CORE_LOGGER.warn(
          `PASS_CONTAINER_ENVS: value for "${k}" is not a scalar — skipped`
        )
    }
    return out
  }
  CORE_LOGGER.warn('PASS_CONTAINER_ENVS: expected a JSON object or array — ignored')
  return {}
}

// Merge node-owner envs on top of the user/algorithm envs. The owner WINS on key collisions
// (they control the infrastructure). Reserved keys are stripped defensively — they are already
// dropped at parse time, but this keeps the guarantee even if `ownerEnvs` came from elsewhere.
export function mergeOwnerEnvs(
  userEnv: Record<string, string>,
  ownerEnvs: Record<string, string>
): Record<string, string> {
  const reserved = new Set<string>(RESERVED_CONTAINER_ENV_KEYS)
  const safeOwner: Record<string, string> = {}
  for (const [k, v] of Object.entries(ownerEnvs ?? {})) {
    if (!reserved.has(k)) safeOwner[k] = v
  }
  return { ...userEnv, ...safeOwner }
}

// Minimal view of a C2D job needed to build its algorithm container's env, kept decoupled from
// the full job type so this stays pure and unit-testable.
export interface AlgoEnvInput {
  algoEnvs?: Record<string, unknown> // job.algorithm.envs
  inputDids: Array<string | null> // one per /data/inputs/<index>, null for raw fileObject inputs
  transformationDid?: string // job.algorithm.documentId
}

// Builds the Docker `Env` array for a C2D algorithm container: algorithm-provided envs, then the
// node owner's PASS_CONTAINER_ENVS on top (owner wins), and finally the pod-configuration
// contract (DIDS + TRANSFORMATION_DID) which is authoritative — reserved keys are removed from
// the merged set first so the contract entries are never duplicated or shadowed.
export function buildAlgoContainerEnv(
  input: AlgoEnvInput,
  ownerEnvs: Record<string, string>
): string[] {
  const algoEnvs: Record<string, string> = {}
  if (input.algoEnvs) {
    for (const key of Object.keys(input.algoEnvs)) {
      algoEnvs[key] = String(input.algoEnvs[key])
    }
  }
  const merged = mergeOwnerEnvs(algoEnvs, ownerEnvs)
  for (const k of RESERVED_CONTAINER_ENV_KEYS) delete merged[k]
  const envVars = Object.entries(merged).map(([k, v]) => `${k}=${v}`)
  envVars.push(`DIDS=${JSON.stringify(input.inputDids)}`)
  if (input.transformationDid) {
    envVars.push(`TRANSFORMATION_DID=${input.transformationDid}`)
  }
  return envVars
}
