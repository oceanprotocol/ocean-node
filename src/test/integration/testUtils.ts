import { INDEXER_DDO_EVENT_EMITTER } from '../../components/Indexer/index.js'
import { Database } from '../../components/database/index.js'
import { CORE_LOGGER, INDEXER_LOGGER } from '../../utils/logging/common.js'

import { JsonRpcSigner, JsonRpcProvider, getBytes } from 'ethers'
import { DEFAULT_TEST_TIMEOUT } from '../utils/utils.js'
import { getDatabase } from '../../utils/database.js'
import { DDO } from '../../@types/DDO/DDO.js'
import { sleep } from '../../utils/util.js'
import EventEmitter from 'events'
// listen for indexer events
export function addIndexerEventListener(eventName: string, ddoId: string, callback: any) {
  // add listener
  INDEXER_DDO_EVENT_EMITTER.addListener(eventName, (did: string) => {
    INDEXER_LOGGER.info(`Test suite - Listened event: "${eventName}" for DDO: ${did}`)
    if (ddoId === did && typeof callback === 'function') {
      // remove it
      INDEXER_DDO_EVENT_EMITTER.removeListener(eventName, () => {})
      callback(did)
    }
  })
}
/**
 * Listen for any type of events
 * @param eventEmitter the event emiiter to attach to
 * @param eventName the event name
 * @param callback result function
 */
export function addGenericEventListener(
  eventEmitter: EventEmitter,
  eventName: string,
  callback: any
) {
  // add listener
  eventEmitter.addListener(eventName, (data: any) => {
    CORE_LOGGER.info(`Test suite - Listened event: "${eventName}" with data: ${data}`)
    if (typeof callback === 'function') {
      // always remove it (one shot only)
      eventEmitter.removeListener(eventName, () => {})
      callback(data)
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

export type WaitIndexResult = {
  ddo: DDO | null
  wasTimeout: boolean
}
// WIP
export const waitToIndex = async (
  did: string,
  eventName: string,
  testTimeout: number = DEFAULT_TEST_TIMEOUT,
  forceWaitForEvent?: boolean
): Promise<WaitIndexResult> => {
  const result: WaitIndexResult = { ddo: null, wasTimeout: false }
  let listening = false
  let wait = true

  const timeout = setTimeout(async () => {
    const res = await getIndexedDDOFromDB(did)
    result.ddo = res
    result.wasTimeout = true
    wait = false
    return result
  }, testTimeout - 5000) // little less (5 secs) than the initial timeout

  while (wait) {
    // we might want to wait for the event, on certain ocasions (ex: when we update something that already exists)
    // otherwise we might get the still "unmodified" version
    // ideally, the tests would call the waitToIndex() method before the action that triggers it
    if (!forceWaitForEvent) {
      // first try
      const res = await getIndexedDDOFromDB(did)
      if (res !== null) {
        clearTimeout(timeout)
        result.ddo = res
        result.wasTimeout = false
        wait = false
        return result
      }
    } else if (!listening) {
      // 2nd approach, whatever happens first (timeout or event emition)
      listening = true
      addIndexerEventListener(eventName, did, async (id: string) => {
        INDEXER_LOGGER.info('Listened Indexer event: ' + eventName)
        clearTimeout(timeout)
        const res = await getIndexedDDOFromDB(id)
        result.ddo = res
        result.wasTimeout = false
        wait = false
        return result
      })
    }
    // hold your breath for a while
    await sleep(1000)
  }
  return result
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
