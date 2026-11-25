import { EncryptMethod } from '../@types/fileObject.js'
import crypto from 'crypto'
import { PROTOCOL_COMMANDS } from './constants.js'

// this can be handy as we do this kind of hash in multiple places
export function create256Hash(input: string): string {
  const result = crypto.createHash('sha256').update(input).digest('hex')
  return '0x' + result
}

/**
 * ON-02: single source of truth for the DECRYPT_DDO signed message.
 *
 * The signer (Indexer `BaseProcessor.decryptDDO`) and the verifier
 * (`verifySignatureForConsumer` in core/utils/nonceHandler) MUST build this message
 * identically or every cross-node HTTP decrypt breaks — so it lives in exactly one place that
 * both import, and must never be forked into an "accept the old scheme too" variant.
 *
 * Unlike the generic `consumer + nonce + command + issuerPeerId` message used by every other
 * command, the DECRYPT_DDO message additionally binds:
 *  - `issuerPeerId`  → the VERIFIER node's own peerId (destination binding): a signature minted
 *    for node A is useless at node B.
 *  - `chainId + txId + dataNftAddress` → resource binding: a signature for one asset cannot be
 *    replayed to decrypt another.
 *
 * All fields are stringified exactly as the legacy construction did, so a value is bound by its
 * string form. Empty/undefined binding fields collapse to '' — never pass this helper for a
 * non-DECRYPT_DDO command (those keep their byte-for-byte original message).
 *
 * `dataNftAddress` is lower-cased so the binding is casing-agnostic: a caller that signs the
 * lower-case form of the NFT address still verifies, exactly the tolerance `verifyConsumerSignature`
 * already gives the decrypter address (via `addressCasingVariants`). Because both the signer and
 * the verifier go through this one helper, lower-casing here keeps node↔node identical while also
 * accepting a lower-case-signing client — the node checksum-normalizes the address on ingress, so
 * without this an SDK that signed the lower-case form would never match.
 */
export function buildDecryptDDOSignatureMessage(fields: {
  decrypterAddress: string
  nonce: string | number
  issuerPeerId: string
  chainId: string | number
  txId: string
  dataNftAddress: string
}): string {
  return String(
    String(fields.decrypterAddress) +
      String(fields.nonce) +
      String(PROTOCOL_COMMANDS.DECRYPT_DDO) +
      String(fields.issuerPeerId ?? '') +
      String(fields.chainId ?? '') +
      String(fields.txId ?? '') +
      String(fields.dataNftAddress ?? '').toLowerCase()
  )
}

/**
 * Scoped auth tokens — SHARED wire contract with ocean.js (companion plan §3).
 *
 * The signer (ocean.js `buildCreateAuthTokenSignatureMessage`) and the verifier (this repo, via
 * `verifySignatureForConsumer`) MUST build byte-identical messages. If one byte of the format
 * below changes, both repos change together (see the plan headers). The golden vectors in the
 * unit tests of BOTH repos pin these exact bytes.
 *
 * Current token format version. It is embedded in the SIGNED bytes (`|v:<n>`) AND carried as the
 * `v` JWT claim, so token versions are cryptographically domain-separated: a v2 signature can
 * never verify as a future v3, and a verifier rejects any `v` it does not implement.
 */
export const AUTH_TOKEN_VERSION = 2

/**
 * Build the v2 scoped-auth-token signed message (plan §3.2). Shared single source of truth, used
 * at creation (`verifySignatureForConsumer`) and at foreign re-verification (`validateRemoteToken`).
 *
 * message =
 *   address + nonce + "createAuthToken" + issuerPeerId
 *   + "|v:"   + V
 *   + "|aud:" + AUD       (canonical: dedup via Set, default ascending string sort, comma-joined)
 *   + "|cmd:" + CMD       (same canonicalization over scope command names)
 *   + "|exp:" + EXP       (String(validUntil), epoch-ms integer, required in v2)
 *
 * Omitted audience/scope collapse to the empty string (unrestricted). Callers never pass `[]`
 * (rejected at creation), so an empty segment always means "omitted / unrestricted".
 */
export function buildCreateAuthTokenSignatureMessage(fields: {
  address: string
  nonce: string | number
  issuerPeerId: string
  audience?: string[]
  scope?: string[]
  validUntil: number
}): string {
  const aud =
    fields.audience && fields.audience.length
      ? Array.from(new Set(fields.audience)).sort().join(',')
      : ''
  const cmd =
    fields.scope && fields.scope.length
      ? Array.from(new Set(fields.scope)).sort().join(',')
      : ''
  const V = String(AUTH_TOKEN_VERSION)
  return (
    String(fields.address) +
    String(fields.nonce) +
    String(PROTOCOL_COMMANDS.CREATE_AUTH_TOKEN) +
    String(fields.issuerPeerId ?? '') +
    '|v:' +
    V +
    '|aud:' +
    aud +
    '|cmd:' +
    cmd +
    '|exp:' +
    String(fields.validUntil)
  )
}

/**
 * OJ-03 — domain-separation prefix for the status identity challenge (shared with ocean.js).
 *
 * The node signs `utf8(STATUS_CHALLENGE_DOMAIN + clientChallenge)` with its libp2p IDENTITY key.
 * The fixed prefix guarantees these bytes can never collide with anything else the identity key
 * signs (Noise handshakes, future attestations). ocean.js reconstructs the identical
 * `prefix + challenge` and verifies with `@libp2p/crypto` `publicKey.verify`. Mirror this exact
 * string in ocean.js — do not re-spell it.
 */
export const STATUS_CHALLENGE_DOMAIN = 'ocean-node-status-challenge-v1:'

// convert from string format to EncryptMethod (case insensitive)
export function getEncryptMethodFromString(str: string): EncryptMethod {
  if (!str || str.length === 0) return EncryptMethod.AES // default

  return str.toUpperCase() === 'ECIES' ? EncryptMethod.ECIES : EncryptMethod.AES
}
