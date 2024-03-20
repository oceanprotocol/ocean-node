import { ethers } from 'ethers'

export interface StopNodeCommand {
  expiryTimestamp: number
  signature: string
}

// This function assumes you have ethers.js installed and MetaMask available
export async function generateStopNodeCommandParameters(): Promise<StopNodeCommand> {
  // Ensure there's an Ethereum provider (e.g., MetaMask)
  if (!window.ethereum) {
    throw new Error('No Ethereum provider detected.')
  }

  // Create an instance of the ethers.js provider
  const provider = new ethers.BrowserProvider(window.ethereum)

  // Request account access if needed
  await provider.send('eth_requestAccounts', [])

  // const signer = provider.getSigner()

  // Generate expiryTimestamp (current time + 12 hours)
  const expiryTimestamp = Math.floor(new Date().getTime() / 1000) + 12 * 60 * 60

  // Convert expiryTimestamp to UTF-8 bytes, then to a SHA-256 hash
  // const messageHash = ethers.utils.sha256(
  //   ethers.utils.toUtf8Bytes(expiryTimestamp.toString())
  // )

  // // Sign the message hash
  const signature = '' // await signer.signMessage(ethers.utils.arrayify(messageHash))

  return {
    expiryTimestamp,
    signature
  }
}
