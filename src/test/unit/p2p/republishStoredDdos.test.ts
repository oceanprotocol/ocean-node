import { expect } from 'chai'
import { p2pAnnounceDDOS } from '../../../utils/cronjobs/p2pAnnounceDDOS.js'
import { scheduleCronJobs } from '../../../utils/cronjobs/scheduleCronJobs.js'
import { OceanNode } from '../../../OceanNode.js'

/**
 * The startup re-advertise is the only thing that can put this node's provider records back
 * after its p2p datastore came up empty - kad-dht's reprovider works off that datastore, so
 * with nothing in it there is nothing for it to refresh. It used to send `{ q: '*' }` and read
 * `result[0].found` / `result[0].hits`, which is neither backend's contract:
 *
 *  - Elasticsearch spreads the query object into the request body, where `q` is not a key. The
 *    request fails with `parsing_exception: Unknown key for a VALUE_STRING in [q]`, the failure
 *    is caught and skipped per schema, and the result comes back empty - so the job logged
 *    "There is nothing to republish" on a store holding hundreds of DDOs, and logged it as a
 *    success.
 *  - Typesense does accept `q: '*'`, but returns one response per collection and the first one
 *    is the deprecated-DDO collection, which on a healthy node is empty. `result[0].found` is
 *    therefore 0, so the same "nothing to republish" branch was taken, and even when it was not
 *    only `result[0].hits` - one page of one collection - would ever have been iterated.
 *
 * The fakes below reproduce each backend's paging contract and its answer shape rather than
 * asserting on the query string, so a change that sends a form the backend rejects fails here
 * the same way it fails in production.
 */

const PAGE_SIZE = 100 // must match REPUBLISH_PAGE_SIZE in the job under test

const docsNamed = (tag: string, count: number): any[] =>
  Array.from({ length: count }, (unused, index) => ({
    id: `did:op:${tag}-${index}`,
    version: '4.7.0'
  }))

interface RecordedQuery {
  query: Record<string, any>
  perPage?: number
  page?: number
}

/**
 * Stands in for `ElasticsearchDdoDatabase`: schemas are named by `index`, the query object is
 * the request body (so any key Elasticsearch does not know is fatal for that schema, caught and
 * skipped), `from` is a 1-based page number that the database layer turns into an offset, and
 * the answer is one bare array of documents per schema that had hits - schemas with none are
 * absent entirely, and there is no total anywhere in the response.
 */
function elasticFake(collections: Array<[string, any[]]>): {
  db: any
  queries: RecordedQuery[]
} {
  const queries: RecordedQuery[] = []
  const bodyKeys = ['query', 'size', 'from', 'sort', 'index']
  const db = {
    getSchemas: () => collections.map(([index]) => ({ index })),
    search: (query: Record<string, any>) => {
      queries.push({ query })
      const size = query.size || PAGE_SIZE
      const offset = (query.from || 1) * size - size
      const results: any[] = []
      for (const [, docs] of collections) {
        const rejected = Object.keys(query).some((key) => !bodyKeys.includes(key))
        if (rejected || !query.query?.match_all) {
          // the per-schema catch that swallowed the `q` failure
          continue
        }
        const page = docs.slice(offset, offset + size)
        if (page.length > 0) {
          results.push(page.map((doc) => ({ ...doc })))
        }
      }
      return Promise.resolve(results)
    }
  }
  return { db, queries }
}

/**
 * Stands in for `TypesenseDdoDatabase`: schemas are named by `name`, paging is passed as the
 * second and third arguments rather than inside the query, `q` is required and `'*'` is the
 * match-everything wildcard, and the answer is one object per collection *always* - each with
 * that collection's own `found` and a `hits[]` whose entries wrap the document.
 */
function typesenseFake(collections: Array<[string, any[]]>): {
  db: any
  queries: RecordedQuery[]
} {
  const queries: RecordedQuery[] = []
  const db = {
    getSchemas: () => collections.map(([name]) => ({ name })),
    search: (query: Record<string, any>, perPage?: number, page?: number) => {
      queries.push({ query, perPage, page })
      if (query.q !== '*') {
        // the real client answers a missing/!invalid `q` with a 400, which the database layer
        // turns into a null after logging
        return Promise.resolve(null)
      }
      const size = Math.min(perPage || 250, 250)
      const pageNumber = page || 1
      return Promise.resolve(
        collections.map(([, docs]) => ({
          found: docs.length,
          out_of: docs.length,
          page: pageNumber,
          hits: docs
            .slice((pageNumber - 1) * size, pageNumber * size)
            .map((doc) => ({ document: { ...doc } }))
        }))
      )
    }
  }
  return { db, queries }
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
  it('finds documents on Elasticsearch, where the old query form failed outright', async () => {
    const collections: Array<[string, any[]]> = [
      ['op_ddo_short', []],
      ['op_ddo_v4.7.0', docsNamed('current', 150)],
      ['op_ddo_v4.5.0', docsNamed('older', 80)]
    ]
    // what the pre-fix job sent and read, against an identical store - on its own fake so the
    // recorded queries below contain only what the job itself issued
    const oldShape: any = await elasticFake(collections).db.search({ q: '*' })
    expect(
      !!(oldShape && oldShape.length > 0 && oldShape[0].found),
      'the old guard should be provably false here'
    ).to.equal(false)

    const { db, queries } = elasticFake(collections)

    const { node, advertised, cached } = nodeWith(db)
    await p2pAnnounceDDOS(node)

    expect(new Set(advertised).size).to.equal(230)
    expect(advertised.filter((did) => did.startsWith('did:op:current-')).length).to.equal(
      150
    )
    expect(advertised.filter((did) => did.startsWith('did:op:older-')).length).to.equal(
      80
    )
    expect(cached.length).to.equal(230)
    // no request may carry the URI-style `q` into the request body
    expect(queries.every(({ query }) => query.q === undefined)).to.equal(true)
    expect(queries.every(({ query }) => query.query?.match_all !== undefined)).to.equal(
      true
    )
  })

  it('walks past the first page and past the first collection on Typesense', async () => {
    // the first collection is empty, exactly as op_ddo_short is on a node holding current
    // DDOs - which is what made `result[0].found` read as "nothing to republish"
    const collections: Array<[string, any[]]> = [
      ['op_ddo_short', []],
      ['op_ddo_v4.7.0', docsNamed('current', 150)],
      ['op_ddo_v4.5.0', docsNamed('older', 80)]
    ]
    const oldShape: any = await typesenseFake(collections).db.search({ q: '*' })
    expect(
      !!(oldShape && oldShape.length > 0 && oldShape[0].found),
      'the old guard should be provably false here'
    ).to.equal(false)

    const { db, queries } = typesenseFake(collections)

    const { node, advertised } = nodeWith(db)
    await p2pAnnounceDDOS(node)

    expect(new Set(advertised).size).to.equal(230)
    expect(advertised.filter((did) => did.startsWith('did:op:current-')).length).to.equal(
      150
    )
    expect(advertised.filter((did) => did.startsWith('did:op:older-')).length).to.equal(
      80
    )
    // 150 documents in one collection cannot fit in a single page of 100
    expect(Math.max(...queries.map(({ page }) => page))).to.be.greaterThan(1)
    expect(queries.every(({ query }) => query.q === '*')).to.equal(true)
    expect(queries.every(({ perPage }) => perPage <= 250)).to.equal(true)
  })

  it('stops when the last page is exactly full rather than looping', async () => {
    // a count that is an exact multiple of the page size is the case where "this page was not
    // full" cannot be the stop signal: the job has to fetch one more page and get nothing
    for (const fake of [elasticFake, typesenseFake]) {
      const { db, queries } = fake([['op_ddo_v4.7.0', docsNamed('exact', PAGE_SIZE * 2)]])
      const { node, advertised } = nodeWith(db)
      await p2pAnnounceDDOS(node)
      expect(new Set(advertised).size).to.equal(PAGE_SIZE * 2)
      expect(queries.length).to.equal(3)
    }
  })

  it('makes one request and no more when everything fits in a page', async () => {
    for (const fake of [elasticFake, typesenseFake]) {
      const { db, queries } = fake([['op_ddo_v4.7.0', docsNamed('few', 7)]])
      const { node, advertised } = nodeWith(db)
      await p2pAnnounceDDOS(node)
      expect(advertised.length).to.equal(7)
      expect(queries.length).to.equal(1)
    }
  })

  it('advertises nothing when the store really is empty', async () => {
    for (const fake of [elasticFake, typesenseFake]) {
      const { db } = fake([
        ['op_ddo_short', []],
        ['op_ddo_v4.7.0', []]
      ])
      const { node, advertised } = nodeWith(db)
      await p2pAnnounceDDOS(node)
      expect(advertised.length).to.equal(0)
    }
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
      getSchemas: (): any[] => [],
      search: () => {
        ddoSearches++
        return Promise.resolve([])
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
