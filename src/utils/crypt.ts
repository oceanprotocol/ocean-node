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

// convert from string format to EncryptMethod (case insensitive)
export function getEncryptMethodFromString(str: string): EncryptMethod {
  if (!str || str.length === 0) return EncryptMethod.AES // default

  return str.toUpperCase() === 'ECIES' ? EncryptMethod.ECIES : EncryptMethod.AES
}
