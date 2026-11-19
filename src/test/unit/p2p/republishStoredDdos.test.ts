import { expect } from 'chai'
import { p2pAnnounceDDOS } from '../../../utils/cronjobs/p2pAnnounceDDOS.js'
import { scheduleCronJobs } from '../../../utils/cronjobs/scheduleCronJobs.js'
import { OceanNode } from '../../../OceanNode.js'

/**
 * The startup re-advertise is the only thing that can put this node's provider records back
 * after its p2p datastore came up empty - kad-dht's reprovider works off that datastore, so
 * with nothing in it there is nothing for it to refresh. It walks every DDO of the store, of
 * every version and state, one page at a time.
 */

const PAGE_SIZE = 100 // must match REPUBLISH_PAGE_SIZE in the job under test

const docsNamed = (tag: string, count: number): any[] =>
  Array.from({ length: count }, (unused, index) => ({
    id: `did:op:${tag}-${index}`,
    version: '4.7.0'
  }))

interface RecordedFind {
  conditions: any[]
  page: { offset: number; limit: number }
}

/**
 * Stands in for the DDO store: `find` with no condition gives all DDOs, in one list for all
 * versions, one page at a time.
 */
function storeFake(docs: any[]): { db: any; finds: RecordedFind[] } {
  const finds: RecordedFind[] = []
  const db = {
    find: (conditions: any[], sort: any[], page: { offset: number; limit: number }) => {
      finds.push({ conditions, page })
      const results = docs.slice(page.offset, page.offset + page.limit)
      return Promise.resolve({
        results: results.map((doc) => ({ ...doc })),
        totalResults: docs.length
      })
    }
  }
  return { db, finds }
}

function nodeWith(ddoDb: any): { node: OceanNode; advertised: string[]; cached: any[] } {
  const advertised: string[] = []
  const cached: any[] = []
  const node = {
    getDatabase: () => Promise.resolve({ ddo: ddoDb }),
    getP2PNode: () => ({
      advertiseString: (did: string) => {
        advertised.push(did)
        return Promise.resolve(true)
      },
      cacheDDO: (ddo: any) => {
        cached.push(ddo)
      }
    })
  } as unknown as OceanNode
  return { node, advertised, cached }
}

describe('The startup re-advertise republishes everything the node holds', () => {
  it('walks all DDOs, with no condition, one page at a time', async () => {
    const docs = [...docsNamed('current', 150), ...docsNamed('older', 80)]
    const { db, finds } = storeFake(docs)
    const { node, advertised, cached } = nodeWith(db)
    await p2pAnnounceDDOS(node)

    expect(new Set(advertised).size).to.equal(230)
    expect(cached.length).to.equal(230)
    // every state and version: no condition at all
    expect(finds.every(({ conditions }) => conditions.length === 0)).to.equal(true)
    expect(finds.map(({ page }) => page)).to.deep.equal([
      { offset: 0, limit: PAGE_SIZE },
      { offset: PAGE_SIZE, limit: PAGE_SIZE },
      { offset: 2 * PAGE_SIZE, limit: PAGE_SIZE }
    ])
  })

  it('stops when the last page is exactly full rather than looping', async () => {
    // a count that is an exact multiple of the page size is the case where "this page was not
    // full" cannot be the stop signal: the job has to fetch one more page and get nothing
    const { db, finds } = storeFake(docsNamed('exact', PAGE_SIZE * 2))
    const { node, advertised } = nodeWith(db)
    await p2pAnnounceDDOS(node)
    expect(new Set(advertised).size).to.equal(PAGE_SIZE * 2)
    expect(finds.length).to.equal(3)
  })

  it('makes one request and no more when everything fits in a page', async () => {
    const { db, finds } = storeFake(docsNamed('few', 7))
    const { node, advertised } = nodeWith(db)
    await p2pAnnounceDDOS(node)
    expect(advertised.length).to.equal(7)
    expect(finds.length).to.equal(1)
  })

  it('advertises nothing when the store really is empty', async () => {
    const { db } = storeFake([])
    const { node, advertised } = nodeWith(db)
    await p2pAnnounceDDOS(node)
    expect(advertised.length).to.equal(0)
  })
})

/**
 * kad-dht already reprovides from the p2p datastore every hour against a 24 h threshold, on
 * records that are valid for 48 h, so a periodic full re-provide on top of it is duplicate
 * work - ~20 outbound DHT streams per DDO, every four hours, for nothing. Once per process is
 * what actually adds something the reprovider cannot do: recover from a datastore that came up
 * empty. The C2D announce is a different job and keeps its interval.
 */
describe('The re-advertise runs once per process, not on a timer', () => {
  // mirrors REPUBLISH_INTERVAL_HOURS in the scheduler
  const FOUR_HOURS = 1000 * 60 * 60 * 4

  it('registers no repeating timer for it and still runs it at startup', async () => {
    const intervals: Array<() => void> = []
    const realSetInterval = globalThis.setInterval
    const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 50))
    let ddoSearches = 0
    let environmentFetches = 0

    const ddoDb = {
      find: () => {
        ddoSearches++
        return Promise.resolve({ results: [], totalResults: 0 })
      }
    }
    const node = {
      getDatabase: () => Promise.resolve({ ddo: ddoDb }),
      getP2PNode: () => ({
        advertiseString: () => Promise.resolve(true),
        cacheDDO: () => {}
      }),
      getC2DEngines: () => ({
        fetchEnvironments: () => {
          environmentFetches++
          return Promise.resolve([])
        }
      })
    } as unknown as OceanNode

    try {
      // recorded, not started: the assertion is about what gets scheduled, and a real timer
      // here would outlive the test
      // Recorded, not started: the assertion is about what gets scheduled, and a real timer
      // here would outlive the test. Filtered to the scheduler's own period because this
      // replaces the global for as long as scheduleCronJobs takes to run, and in a full-suite
      // process other modules are registering their own (much shorter) intervals meanwhile.
      globalThis.setInterval = ((handler: () => void, delay?: number) => {
        if (delay === FOUR_HOURS) {
          intervals.push(handler)
        }
        return 0 as unknown as NodeJS.Timeout
      }) as unknown as typeof globalThis.setInterval

      await scheduleCronJobs(node)
    } finally {
      globalThis.setInterval = realSetInterval
    }

    // the startup pass happened
    expect(ddoSearches).to.equal(1)
    expect(environmentFetches).to.equal(1)
    // exactly one repeating job remains, and it is not this one
    expect(intervals.length).to.equal(1)
    for (const tick of intervals) {
      tick()
    }
    await settle()
    expect(ddoSearches, 'the re-advertise must not be driven by a timer').to.equal(1)
    expect(environmentFetches, 'the c2d announce keeps its interval').to.equal(2)
  })
})
