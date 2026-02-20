import { ethers, Signer, JsonRpcSigner } from 'ethers'

/**
 * Generates a message hash for signing authentication requests to Ocean Protocol nodes.
 *
 * Creates a keccak256 hash of the concatenated consumer address, nonce, and command string
 * using Solidity's packed encoding format. The resulting hash bytes can be signed by a wallet
 * to authenticate requests.
 *
 * @param consumer - The consumer's Ethereum address (hex string)
 * @param nonce - A unique nonce value (string or number) to prevent replay attacks
 * @param command - The protocol command being requested (e.g., 'COMPUTE_START')
 * @returns A Uint8Array containing the message hash bytes ready for signing
 *
 */
export function createHashForSignature(
  consumer: string,
  nonce: string | number,
  command: string
): Uint8Array {
  const message = String(String(consumer) + String(nonce) + String(command))
  const consumerMessage = ethers.solidityPackedKeccak256(
    ['bytes'],
    [ethers.hexlify(ethers.toUtf8Bytes(message))]
  )
  const messageHashBytes = ethers.toBeArray(consumerMessage)
  return messageHashBytes
}

/**
 * Safe sign a message.
 * @param {Signer} signer - The signer to use.
 * @param {string} messageHash - The message to sign.
 * @returns {Promise<string>} A promise that resolves with the signature.
 */
export async function safeSign(
  signer: Signer,
  messageHashBytes: Uint8Array
): Promise<string> {
  try {
    return await signer.signMessage(messageHashBytes)
  } catch (error) {
    // LoggerInstance.error('Sign provider message error: ', error)
    // Check if the user is using barge chain
    const network = await signer.provider.getNetwork()
    const chainId = Number(network.chainId)
    if (chainId === 8996) {
      return await (signer as JsonRpcSigner)._legacySignMessage(messageHashBytes)
    }
  }
}
