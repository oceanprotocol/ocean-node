import { Signature, Wallet } from 'ethers'

export async function signMessage(
  message: string,
  wallet: Wallet
): Promise<{ v: string; r: string; s: string }> {
  try {
    const signedMessage = await wallet.signMessage(message)
    const signature = Signature.from(signedMessage)

    return {
      v: signature.v.toString(),
      r: signature.r,
      s: signature.s
    }
  } catch (e) {
    console.error('signMessage error', e)
    throw new Error('Signing message failed')
  }
}
