import Web3 from 'web3'

export async function signMessage(
  message: string,
  address: string
): Promise<{ v: string; r: string; s: string }> {
  try {
    const web3 = new Web3('http://127.0.0.1:8545')
    let signedMessage = (await web3.eth.sign(message, address)) as string
    signedMessage = signedMessage.slice(2) // remove 0x
    const r = '0x' + signedMessage.slice(0, 64)
    const s = '0x' + signedMessage.slice(64, 128)
    const v = '0x' + signedMessage.slice(128, 130)

    return { v, r, s }
  } catch (e) {
    console.log('signMessage error', e)
    throw new Error('Signing message failed')
  }
}
