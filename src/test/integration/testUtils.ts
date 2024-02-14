import { Database } from '../../components/database/index.js'
import { INDEXER_LOGGER } from '../../utils/logging/common.js'
import { sleep } from '../../utils/util.js'

import { JsonRpcSigner, JsonRpcProvider, getBytes } from 'ethers'

export const delay = (interval: number) => {
  return it('should delay', (done) => {
    setTimeout(() => done(), interval)
  }).timeout(interval + 1500)
}

export const waitToIndex = async (did: string, database: Database): Promise<any> => {
  let tries = 0
  do {
    try {
      const ddo = await database.ddo.retrieve(did)
      if (ddo) {
        return ddo
      }
    } catch (e) {
      INDEXER_LOGGER.logMessage(`Error could not retrieve the DDO ${did}: ${e}`)
    }
    await sleep(1500)

    tries++
  } while (tries < 100)
  return null
}

export const deleteAsset = async (did: string, database: Database): Promise<any> => {
  try {
    return await database.ddo.delete(did)
  } catch (e) {
    INDEXER_LOGGER.logMessage(`Error could not delete the DDO ${did}: ${e}`)
    return false
  }
}

export async function signMessage(
  message: string,
  address: string,
  provider: JsonRpcProvider
): Promise<{ v: string; r: string; s: string }> {
  try {
    const jsonRpcSigner = new JsonRpcSigner(provider, address)
    const signature = await jsonRpcSigner._legacySignMessage(getBytes(message))

    const signedMessage = signature.slice(2) // remove 0x
    const r = '0x' + signedMessage.slice(0, 64)
    const s = '0x' + signedMessage.slice(64, 128)
    const v = '0x' + signedMessage.slice(128, 130)
    return { v, r, s }
  } catch (e) {
    console.log('signMessage error', e)
    throw new Error('Signing message failed')
  }
}
