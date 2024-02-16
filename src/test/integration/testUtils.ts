import { INDEXER_DDO_EVENT_EMITTER } from '../../components/Indexer/index.js'
import { Database } from '../../components/database/index.js'
import { INDEXER_LOGGER } from '../../utils/logging/common.js'

import { JsonRpcSigner, JsonRpcProvider, getBytes } from 'ethers'
import { DEFAULT_TEST_TIMEOUT } from '../utils/utils.js'
import { getDatabase } from '../../utils/database.js'

// listen for indexer events
export function addIndexerEventListener(eventName: string, ddoId: string, callback: any) {
  // add listener
  INDEXER_DDO_EVENT_EMITTER.addListener(eventName, (did) => {
    INDEXER_LOGGER.info(`Test suite - Listened event: "${eventName}" for DDO ${did.id}`)
    if (ddoId === did.id && typeof callback === 'function') {
      // remove it
      INDEXER_DDO_EVENT_EMITTER.removeListener(eventName, this)
      callback(did)
    }
  })
}

export const delay = (interval: number) => {
  return it('should delay', (done) => {
    setTimeout(() => done(), interval)
  }).timeout(interval + 1500)
}

// called on long running tests
export function expectedTimeoutFailure(testName: string): boolean {
  console.warn(`Timeout Failure for test: "${testName}"`)
  return true
}

async function getIndexedDDOFromDB(did: string): Promise<any> {
  try {
    const database: Database = await getDatabase()
    const ddo = await database.ddo.retrieve(did)
    if (ddo) {
      return ddo
    }
  } catch (e) {
    INDEXER_LOGGER.logMessage(`Error could not retrieve the DDO ${did}: ${e}`)
  }
  return null
}
// WIP
export const waitToIndex = async (
  did: string,
  eventName: string,
  callback: any,
  testTimeout: number = DEFAULT_TEST_TIMEOUT
): Promise<any> => {
  let result = null
  const timeout = setTimeout(async () => {
    result = await getIndexedDDOFromDB(did)
    callback(result, true)
    return result
  }, testTimeout - 5000) // little less (5 secs) than the initial timeout

  // first try
  result = await getIndexedDDOFromDB(did)
  if (result !== null) {
    clearTimeout(timeout)
    return result
  }

  // 2nd approach, whatever happens first (timeout or event emition)
  addIndexerEventListener(eventName, did, async () => {
    clearTimeout(timeout)
    return await getIndexedDDOFromDB(did)
  })
}
/** 
export const waitToIndex = async (did: string, database: Database): Promise<any> => {
  const timeout = setTimeout(() => {}, 1500)
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
} */

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
