import { INDEXER_DDO_EVENT_EMITTER } from '../../components/Indexer/index.js'
import { Database } from '../../components/database/index.js'
import { INDEXER_LOGGER } from '../../utils/logging/common.js'

import { JsonRpcSigner, JsonRpcProvider, getBytes } from 'ethers'
import { DEFAULT_TEST_TIMEOUT } from '../utils/utils.js'
import { getDatabase } from '../../utils/database.js'

// listen for indexer events
export function addIndexerEventListener(eventName: string, ddoId: string, callback: any) {
  const listener = (did: string) => {
    if (ddoId === did) {
      callback(did)
    }
  }

  INDEXER_DDO_EVENT_EMITTER.addListener(eventName, listener)
  return listener
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

export type WaitIndexResult = {
  ddo: Record<string, any> | null
  wasTimeout: boolean
}

export const waitToIndex = async (
  did: string,
  eventName: string,
  testTimeout: number = DEFAULT_TEST_TIMEOUT,
  forceWaitForEvent?: boolean
): Promise<WaitIndexResult> => {
  if (!forceWaitForEvent) {
    const ddo = await getIndexedDDOFromDB(did)
    if (ddo) return { ddo, wasTimeout: false }
  }

  return new Promise((resolve) => {
    const listener = addIndexerEventListener(eventName, did, async () => {
      clearTimeout(timeoutId)
      const ddo = await getIndexedDDOFromDB(did)
      INDEXER_DDO_EVENT_EMITTER.removeListener(eventName, listener)
      resolve({ ddo, wasTimeout: false })
    })

    const timeoutId = setTimeout(async () => {
      try {
        const ddo = await getIndexedDDOFromDB(did)
        INDEXER_DDO_EVENT_EMITTER.removeListener(eventName, listener)
        resolve({ ddo, wasTimeout: true })
      } catch (error) {
        console.error('Error fetching DDO:', error)
        INDEXER_DDO_EVENT_EMITTER.removeListener(eventName, listener)
        resolve({ ddo: null, wasTimeout: true })
      }
    }, testTimeout - 5000)
  })
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
