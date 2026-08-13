import { ethers } from 'ethers'

// EVM addresses reach the node in whatever casing the client happened to use: checksummed
// (EIP-55) straight from a wallet, all-lowercase out of a database, or hand-typed in a curl.
// The node then uses them as identity KEYS — the `owner` filter on job/service queries, the
// nonce row id, ownership comparisons. A differently-cased address does not fail loudly
// there, it silently MISSES: the job "does not exist", or an owner-only field is quietly
// dropped. So every address a user supplies is canonicalized on ingress
// (`normalizeCommandAddresses`, called from the handler base classes) and every ownership
// comparison stays case-insensitive on top of that.
//
// (This module is about the addresses *callers send us*. `utils/address.ts` is a different
// thing entirely: the deployed Ocean contract artifact addresses per chain.)

/**
 * Canonical EIP-55 (checksummed) form of an address.
 * Anything that is not a valid address is returned untouched, so the per-command validators
 * still produce their own "not a valid web3 address" response instead of this throwing.
 */
export function normalizeAddress(value: string): string {
  if (typeof value !== 'string' || !ethers.isAddress(value)) return value
  return ethers.getAddress(value)
}

/** normalizeAddress over a list, leaving non-array input untouched. */
export function normalizeAddresses(values: string[]): string[] {
  if (!Array.isArray(values)) return values
  return values.map((value) => normalizeAddress(value))
}

/**
 * Case-insensitive address equality — use it for EVERY ownership/authorization comparison.
 * Ingress normalization fixes what the caller sends; the other side of the comparison can
 * still be a legacy DB row written before normalization existed.
 */
export function sameAddress(a?: string, b?: string): boolean {
  if (!a || !b) return false
  return a.toLowerCase() === b.toLowerCase()
}

/** Case-insensitive `list.includes(address)`. Null-safe on both sides. */
export function includesAddress(list?: string[], address?: string): boolean {
  if (!list || !address) return false
  return list.some((entry) => sameAddress(entry, address))
}

/**
 * Every plausible casing a client could have embedded in a SIGNED message for this address,
 * most-likely first and deduped.
 *
 * Signature verification MUST try all of them: the signed message is built client-side by
 * concatenating the address as a string, so verifying only the canonical form would reject
 * signatures produced over the lowercase form — a compatibility break introduced by the
 * ingress normalization itself.
 */
export function addressCasingVariants(value: string): string[] {
  if (typeof value !== 'string') return [value]
  return [...new Set([value, normalizeAddress(value), value.toLowerCase()])]
}

// Command fields carrying a single EVM address supplied by the caller.
// Deliberately NOT included: the escrow query fields (`payer`/`payee`/`token`), whose handler
// lowercases them to match how escrow events are stored (see escrowHandler).
const ADDRESS_FIELDS = [
  'consumerAddress',
  'address',
  'owner',
  'decrypterAddress',
  'dataNftAddress',
  'publisherAddress'
]

// Command fields carrying a list of caller-supplied EVM addresses.
const ADDRESS_LIST_FIELDS = ['consumerAddrs', 'additionalViewers']

/**
 * Canonicalizes every caller-supplied address on a command, in place, before anything reads
 * it (validators, DB lookups, ownership checks). Called once from the handler base classes so
 * it covers all three entry points — REST routes, HTTP /directCommand and P2P — for every
 * command, present and future.
 */
export function normalizeCommandAddresses<T>(task: T): T {
  if (!task || typeof task !== 'object') return task
  const record = task as Record<string, any>
  for (const field of ADDRESS_FIELDS) {
    if (typeof record[field] === 'string') {
      record[field] = normalizeAddress(record[field])
    }
  }
  for (const field of ADDRESS_LIST_FIELDS) {
    if (Array.isArray(record[field])) {
      record[field] = normalizeAddresses(record[field])
    }
  }
  return task
}
