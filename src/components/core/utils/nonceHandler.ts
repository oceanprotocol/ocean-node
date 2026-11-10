import { ReadableString } from '../../P2P/handleProtocolCommands.js'
import { OceanNodeConfig, P2PCommandResponse } from '../../../@types/OceanNode.js'
import { ethers } from 'ethers'
import { CORE_LOGGER, DATABASE_LOGGER } from '../../../utils/logging/common.js'
import { AbstractNonceDatabase } from '../../database/BaseDatabase.js'
import { CoreHandlersRegistry } from '../handler/coreHandlersRegistry.js'
import { OceanNode } from '../../../OceanNode.js'
import { PROTOCOL_COMMANDS } from '../../../utils/constants.js'
import { NonceCommand } from '../../../@types/commands.js'
import { streamToString } from '../../../utils/util.js'
import { Readable } from 'node:stream'
import { addressCasingVariants } from '../../../utils/evmAddress.js'
import { buildDecryptDDOSignatureMessage } from '../../../utils/crypt.js'

export function getDefaultErrorResponse(errorMessage: string): P2PCommandResponse {
  return {
    stream: null,
    status: { httpStatus: 500, error: 'Unknown error: ' + errorMessage }
  }
}

export function getDefaultResponse(nonce: number): P2PCommandResponse {
  const streamResponse = new ReadableString(String(nonce))
  // set nonce here
  return {
    status: {
      httpStatus: 200,
      headers: {
        'Content-Type': 'text/plain'
      }
    },
    stream: streamResponse
  }
}

// returns true/false (+ error message if needed)
export type NonceResponse = {
  valid: boolean
  error?: string
}

// we are doing the nonce stream response transformation in a few places
// so we can use this shortcut function when we just want the final number
export async function getNonceAsNumber(address: string): Promise<number> {
  const command: NonceCommand = { command: PROTOCOL_COMMANDS.NONCE, address }
  const nonceResponse = await CoreHandlersRegistry.getInstance(OceanNode.getInstance())
    .getHandlerForTask(command)
    .handle(command)
  if (nonceResponse.stream) {
    return Number(await streamToString(nonceResponse.stream as Readable))
  }
  return 0
}
// get stored nonce for an address ( 0 if not found)
export async function getNonce(
  db: AbstractNonceDatabase,
  address: string
): Promise<P2PCommandResponse> {
  // get nonce from db
  try {
    const nonceResponse = await db.retrieve(address)
    if (nonceResponse && nonceResponse.nonce !== null) {
      return getDefaultResponse(nonceResponse.nonce)
    }
    // // did not found anything, try add it and return default
    const setFirst = await db.create(address, 0)
    if (setFirst) {
      return getDefaultResponse(0)
    }
    return getDefaultErrorResponse(
      `Unable to retrieve nonce neither set first default for: ${address}`
    )
  } catch (err) {
    // did not found anything, try add it and return default
    if (err.message.indexOf(address) > -1) {
      return getDefaultErrorResponse(err.message)
    } else {
      DATABASE_LOGGER.error('Failure executing nonce task: ' + err.message)
      return getDefaultErrorResponse(err.message)
    }
  }
}

// update stored nonce for an address
async function updateNonce(
  db: AbstractNonceDatabase,
  address: string,
  nonce: number
): Promise<NonceResponse> {
  try {
    // update nonce on db
    // it will create if none exists yet
    const resp = await db.update(address, nonce)
    return {
      valid: resp != null,
      error: resp == null ? 'error updating nonce to: ' + nonce : null
    }
  } catch (err) {
    DATABASE_LOGGER.error('Failure executing nonce task: ' + err.message)
    return {
      valid: false,
      error: err.message
    }
  }
}

// get stored nonce for an address, update it on db, validate signature
export async function checkNonce(
  config: OceanNodeConfig,
  db: AbstractNonceDatabase,
  consumer: string,
  nonce: number,
  signature: string,
  command: string,
  chainId?: string | null,
  // ON-02: resource-binding fields, appended to the signed message ONLY for DECRYPT_DDO.
  extraSignedFields?: { txId?: string; dataNftAddress?: string }
): Promise<NonceResponse> {
  try {
    // get nonce from db
    let previousNonce = 0 // if none exists
    const existingNonce = await db.retrieve(consumer)
    if (existingNonce && existingNonce.nonce !== null) {
      previousNonce = existingNonce.nonce
    }
    // check if bigger than previous stored one and validate signature
    const validate = await validateNonceAndSignature(
      nonce,
      previousNonce, // will return 0 if none exists
      consumer,
      signature,
      command,
      config,
      chainId,
      extraSignedFields
    )
    if (validate.valid) {
      const updateStatus = await updateNonce(db, consumer, nonce)
      return updateStatus
    } else {
      // invalid nonce / signature is client input
      CORE_LOGGER.debug(
        `Failure when validating nonce and signature for ${consumer}: ${validate.error}`
      )
      return {
        valid: false,
        error: validate.error
      }
    }
    // return validation status and possible error msg
  } catch (err) {
    DATABASE_LOGGER.error('Failure executing nonce task: ' + err.message)
    return {
      valid: false,
      error: err.message
    }
  }
}

/**
 *
 * @param nonce nonce
 * @param existingNonce store nonce
 * @param consumer address
 * @param signature sign(nonce)
 * @param message Use this message instead of default String(nonce)
 * @returns true or false + error message
 */
async function validateNonceAndSignature(
  nonce: number,
  existingNonce: number,
  consumer: string,
  signature: string,
  command: string = null,
  config: OceanNodeConfig,
  chainId?: string | null,
  extraSignedFields?: { txId?: string; dataNftAddress?: string }
): Promise<NonceResponse> {
  if (nonce <= existingNonce) {
    return {
      valid: false,
      error: 'nonce: ' + nonce + ' is not a valid nonce'
    }
  }
  // ON-02: DECRYPT_DDO binds the signed message to THIS (verifier) node's peerId, exactly as
  // CREATE_AUTH_TOKEN does, so a signature harvested from one node cannot be replayed at another.
  const issuerPeerId =
    command === PROTOCOL_COMMANDS.CREATE_AUTH_TOKEN ||
    command === PROTOCOL_COMMANDS.DECRYPT_DDO
      ? OceanNode.getInstance().getKeyManager().getPeerIdString()
      : ''
  if (
    await verifyConsumerSignature(
      consumer,
      nonce,
      signature,
      issuerPeerId,
      command,
      config,
      chainId,
      extraSignedFields
    )
  ) {
    return { valid: true }
  }
  return {
    valid: false,
    error: 'consumer address and nonce signature mismatch'
  }
}

export async function verifyConsumerSignature(
  consumer: string,
  nonce: string | number,
  signature: string,
  issuerPeerId: string,
  command: string = null,
  config?: OceanNodeConfig,
  chainId?: string | null,
  extraSignedFields?: { txId?: string; dataNftAddress?: string }
): Promise<boolean> {
  // The signed message embeds the consumer address as a STRING, so its casing is part of what
  // was signed. Addresses are checksum-normalized on ingress (utils/evmAddress.ts), which would
  // otherwise reject clients that built and signed the message from the lowercase form — so
  // try every plausible casing. Deduped, canonical form first: one attempt for most callers.
  for (const candidate of addressCasingVariants(consumer)) {
    if (
      await verifySignatureForConsumer(
        candidate,
        nonce,
        signature,
        issuerPeerId,
        command,
        config,
        chainId,
        extraSignedFields
      )
    ) {
      return true
    }
  }
  return false
}

async function verifySignatureForConsumer(
  consumer: string,
  nonce: string | number,
  signature: string,
  issuerPeerId: string,
  command: string = null,
  config?: OceanNodeConfig,
  chainId?: string | null,
  extraSignedFields?: { txId?: string; dataNftAddress?: string }
): Promise<boolean> {
  // ON-02: DECRYPT_DDO uses a resource- and destination-bound message built by the SHARED
  // helper that the Indexer signer also uses, so signer and verifier cannot drift. Every other
  // command keeps its byte-for-byte original message (consumer + nonce + command + issuerPeerId).
  const message =
    command === PROTOCOL_COMMANDS.DECRYPT_DDO
      ? buildDecryptDDOSignatureMessage({
          decrypterAddress: String(consumer),
          nonce,
          issuerPeerId: String(issuerPeerId),
          chainId: chainId ?? '',
          txId: extraSignedFields?.txId ?? '',
          dataNftAddress: extraSignedFields?.dataNftAddress ?? ''
        })
      : String(String(consumer) + String(nonce) + String(command) + String(issuerPeerId))
  const consumerMessage = ethers.solidityPackedKeccak256(
    ['bytes'],
    [ethers.hexlify(ethers.toUtf8Bytes(message))]
  )
  const messageHashBytes = ethers.getBytes(consumerMessage)
  const legacyMessageHashBytes = ethers.toBeArray(consumerMessage)

  // Try EOA signature validation
  try {
    const addressFromHashSignature = ethers.verifyMessage(consumerMessage, signature)
    const addressFromBytesSignature = ethers.verifyMessage(messageHashBytes, signature)
    const addressFromLegacyBytesSignature = ethers.verifyMessage(
      legacyMessageHashBytes,
      signature
    )
    if (
      ethers.getAddress(addressFromHashSignature)?.toLowerCase() ===
        ethers.getAddress(consumer)?.toLowerCase() ||
      ethers.getAddress(addressFromBytesSignature)?.toLowerCase() ===
        ethers.getAddress(consumer)?.toLowerCase() ||
      ethers.getAddress(addressFromLegacyBytesSignature)?.toLowerCase() ===
        ethers.getAddress(consumer)?.toLowerCase()
    ) {
      return true
    }
  } catch (error) {
    // Continue to smart account check
  }

  // An explicit chain restricts validation; otherwise try every configured network.
  const targetChainIds = chainId
    ? [chainId]
    : Object.keys(config?.supportedNetworks || {})
  for (const targetChainId of targetChainIds) {
    const network = config?.supportedNetworks?.[targetChainId]
    if (!network) continue
    try {
      const provider = new ethers.JsonRpcProvider(network.rpc)

      // Try custom hash format (for backward compatibility)
      if (await isERC1271Valid(consumer, consumerMessage, signature, provider)) {
        return true
      }

      // Try EIP-191 prefixed hash (standard for smart wallets)
      const eip191Hash = ethers.hashMessage(message)
      if (await isERC1271Valid(consumer, eip191Hash, signature, provider)) {
        return true
      }
    } catch (error) {
      CORE_LOGGER.error(`ERC-1271 signature validation error: ${error?.message}`)
    }
  }

  return false
}

// Smart account validation
export async function isERC1271Valid(
  address: string,
  hash: string | Uint8Array,
  signature: string,
  provider: ethers.Provider
): Promise<boolean> {
  try {
    const contract = new ethers.Contract(
      address,
      ['function isValidSignature(bytes32, bytes) view returns (bytes4)'],
      provider
    )
    const hashToUse = typeof hash === 'string' ? hash : ethers.hexlify(hash)
    const result = await contract.isValidSignature(hashToUse, signature)
    return result === '0x1626ba7e' // ERC-1271 magic value
  } catch {
    return false
  }
}
