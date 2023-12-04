import { Database } from '../src/components/database/index.js'
import { Signer } from 'ethers'
import Web3 from 'web3'

export const genericAsset = {
  '@context': ['https://w3id.org/did/v1'],
  id: '',
  version: '4.1.0',
  chainId: 8996,
  nftAddress: '0x0',
  metadata: {
    created: '2021-12-20T14:35:20Z',
    updated: '2021-12-20T14:35:20Z',
    type: 'dataset',
    name: 'dataset-name',
    description: 'Ocean protocol test dataset description',
    author: 'oceanprotocol-team',
    license: 'MIT',
    tags: ['white-papers'],
    additionalInformation: { 'test-key': 'test-value' },
    links: ['http://data.ceda.ac.uk/badc/ukcp09/']
  },
  services: [
    {
      id: 'testFakeId',
      type: 'access',
      description: 'Download service',
      files: '',
      datatokenAddress: '0x0',
      serviceEndpoint: 'http://172.15.0.4:8030',
      timeout: 0
    }
  ]
}

export function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function waitToIndex(did: string, database: Database): Promise<any> {
  let tries = 0
  do {
    try {
      const ddo = await database.ddo.retrieve(did)
      if (ddo) {
        return ddo
      }
    } catch (e) {
      // do nothing
    }
    sleep(1500)
    tries++
  } while (tries < 1000)
  return null
}

export async function signMessage(
  message: string,
  signerAddress: string
): Promise<{ v: string; r: string; s: string }> {
  // Initialize Web3 with the provider
  const web3 = new Web3('http://127.0.0.1:8545')

  try {
    // Sign the message
    const signature = (await web3.eth.sign(
      web3.utils.sha3(message) || '',
      signerAddress
    )) as string

    // Extract r, s, and v components from the signature
    const r = signature.slice(0, 66)
    const s = '0x' + signature.slice(66, 130)
    const v = '0x' + signature.slice(130, 132)

    return { v, r, s }
  } catch (e) {
    console.log('signMessage error', e)
    throw new Error('Signing message failed')
  }
}

// export async function signMessage(
//   message: string,
//   signer: Signer
// ): Promise<{ v: string; r: string; s: string }> {
//   // Ensure the signer is connected to a provider
//   if (!signer.provider) {
//     throw new Error('Signer must be connected to a provider')
//   }
//   try {
//     // Sign the message
//     const signature = await signer.signMessage(message)

//     // Extract r, s, and v components from the signature
//     const r = signature.slice(0, 66)
//     const s = '0x' + signature.slice(66, 130)
//     const v = '0x' + signature.slice(130, 132)

//     return { v, r, s }
//   } catch (e) {
//     console.log('signMessage error', e)
//     throw new Error('Signing message failed')
//   }
// }
