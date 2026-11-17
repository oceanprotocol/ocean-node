import { expect } from 'chai'
import type { SqlClient } from '../../../components/database/sql/SqlClient.js'
import { SQL_DB_TYPE, makeSqlClient } from '../../utils/sqlClient.js'
import {
  SqlDocuments,
  flattenDocument
} from '../../../components/database/sql/SqlDocuments.js'
import {
  QueryError,
  UnsupportedQueryError
} from '../../../components/database/BaseDatabase.js'

// The query of the node (the Elasticsearch format) on a SQL document table.

const WEATHER = {
  id: 'did:op:weather',
  chainId: 8996,
  nftAddress: '0xAAA',
  metadata: {
    name: 'Ocean Weather Data',
    type: 'dataset',
    tags: ['weather', 'Climate'],
    created: '2026-01-10T00:00:00Z',
    description: 'Hourly temperature of the North Sea'
  },
  services: [
    { type: 'access', datatokenAddress: '0xD1' },
    { type: 'compute', datatokenAddress: '0xD2' }
  ],
  indexedMetadata: {
    nft: { state: 0, owner: '0xOwnerA' },
    stats: [{ orders: 5, prices: [{ type: 'fixedrate', price: '10' }] }],
    purgatory: { state: false },
    event: { block: 100 }
  }
}
const CLASSIFIER = {
  id: 'did:op:classifier',
  chainId: 8996,
  nftAddress: '0xBBB',
  metadata: {
    name: 'Image Classifier',
    type: 'algorithm',
    tags: ['ml'],
    created: '2026-02-10T00:00:00Z'
  },
  services: [{ type: 'access', datatokenAddress: '0xD3' }],
  indexedMetadata: {
    nft: { state: 0, owner: '0xOwnerB' },
    stats: [{ orders: 12 }],
    purgatory: { state: false },
    event: { block: 200 }
  }
}
const ARCHIVE = {
  id: 'did:op:archive',
  chainId: 137,
  nftAddress: '0xCCC',
  metadata: {
    name: 'Old weather archive',
    type: 'dataset',
    created: '2026-03-10T00:00:00Z'
  },
  services: [{ type: 'access', datatokenAddress: '0xD4' }],
  indexedMetadata: {
    nft: { state: 5, owner: '0xOwnerA' },
    stats: [{ orders: 0 }],
    purgatory: { state: true },
    event: { block: 300 }
  }
}

describe('flattenDocument', () => {
  it('gives one row per leaf value, with no array index in the path', () => {
    const rows = flattenDocument({ a: { b: 'X' }, list: [{ n: 1 }, { n: 2.5 }], t: true })
    expect(rows).to.deep.equal([
      { path: 'a.b', str: 'x', num: null },
      { path: 'list.n', str: '1', num: 1 },
      { path: 'list.n', str: '2.5', num: 2.5 },
      { path: 't', str: 'true', num: null }
    ])
  })

  it('gives no row for null, and keeps the first 512 characters of a string', () => {
    const rows = flattenDocument({ none: null, long: 'A'.repeat(600) })
    expect(rows).to.have.length(1)
    expect(rows[0].str).to.equal('a'.repeat(512))
  })
})

describe('SQL documents', () => {
  let db: SqlClient
  let documents: SqlDocuments

  const ids = async (query: Record<string, any>, sort?: any) =>
    (await documents.search({ query, sort }, 100, 0)).map((doc) => doc.id)
  const sorted = async (query: Record<string, any>) => (await ids(query)).sort()

  beforeEach(async () => {
    db = await makeSqlClient()
    documents = new SqlDocuments(db, 'ddo', SQL_DB_TYPE)
    await documents.init()
    await documents.put(WEATHER.id, WEATHER, { _schema: 'op_ddo_v4.1.0' })
    await documents.put(CLASSIFIER.id, CLASSIFIER, { _schema: 'op_ddo_v4.1.0' })
    await documents.put(ARCHIVE.id, ARCHIVE, { _schema: 'op_ddo_short' })
  })
  afterEach(() => db.close())

  describe('documents', () => {
    it('reads a document back, and null for an unknown id', async () => {
      expect(await documents.get(WEATHER.id)).to.deep.equal(WEATHER)
      expect(await documents.get('none')).to.equal(null)
    })

    it('a second put replaces the document and its old field rows', async () => {
      await documents.put(WEATHER.id, { ...WEATHER, chainId: 1 })
      expect(await sorted({ term: { chainId: 8996 } })).to.deep.equal([CLASSIFIER.id])
      expect(await sorted({ term: { chainId: 1 } })).to.deep.equal([WEATHER.id])
      expect(await documents.count()).to.equal(3)
    })

    it('adds the id to a document that has no id field', async () => {
      await documents.put('order-1', { consumer: '0xC' })
      expect(await documents.get('order-1')).to.deep.equal({
        consumer: '0xC',
        id: 'order-1'
      })
      expect(await ids({ term: { _id: 'order-1' } })).to.deep.equal(['order-1'])
    })

    it('modify changes a document in one step, and creates it when absent', async () => {
      await documents.modify('counter', (doc) => ({ count: (doc?.count ?? 0) + 1 }))
      await documents.modify('counter', (doc) => ({ count: (doc?.count ?? 0) + 1 }))
      expect((await documents.get('counter')).count).to.equal(2)
    })

    it('modifies of one document at the same time do not lose a change', async () => {
      await documents.put('counter', { count: 0 })
      const increment = () =>
        documents.modify('counter', (doc) => ({ count: doc.count + 1 }))
      await Promise.all(Array.from({ length: 20 }, increment))
      expect((await documents.get('counter')).count).to.equal(20)
    })

    it('modifies that make one document at the same time keep all changes', async () => {
      const add = (item: number) =>
        documents.modify('list', (doc) => ({ items: [...(doc?.items ?? []), item] }))
      await Promise.all(Array.from({ length: 20 }, (_, item) => add(item)))
      expect((await documents.get('list')).items).to.have.length(20)
    })

    it('a modify that changes nothing leaves no document', async () => {
      expect(await documents.modify('absent', () => null)).to.equal(null)
      expect(await documents.get('absent')).to.equal(null)
      expect(await documents.count()).to.equal(3)
    })

    it('gives the documents in the order of the bytes of their ids', async () => {
      for (const id of ['e1', 'e10', 'e-dup', 'E2']) {
        await documents.put(id, { kind: 'event' })
      }
      const found = await documents.search({ query: { term: { kind: 'event' } } }, 10, 0)
      expect(found.map((doc) => doc.id)).to.deep.equal(['E2', 'e-dup', 'e1', 'e10'])
    })

    it('deletes a document with its field rows', async () => {
      expect(await documents.delete(WEATHER.id)).to.equal(true)
      expect(await documents.delete(WEATHER.id)).to.equal(false)
      expect(await sorted({ match_all: {} })).to.deep.equal([ARCHIVE.id, CLASSIFIER.id])
      const rows = await db.all('SELECT * FROM ddo_fields WHERE "id" = ?', [WEATHER.id])
      expect(rows).to.deep.equal([])
    })

    it('deletes the documents that match a query', async () => {
      expect(await documents.deleteMatching({ term: { chainId: 8996 } })).to.equal(2)
      expect(await sorted({ match_all: {} })).to.deep.equal([ARCHIVE.id])
    })
  })

  describe('leaf clauses', () => {
    it('term on a scalar field, on a number and on a boolean', async () => {
      expect(await sorted({ term: { 'metadata.type': 'algorithm' } })).to.deep.equal([
        CLASSIFIER.id
      ])
      expect(await sorted({ term: { chainId: 137 } })).to.deep.equal([ARCHIVE.id])
      expect(
        await sorted({ term: { 'indexedMetadata.purgatory.state': false } })
      ).to.deep.equal([CLASSIFIER.id, WEATHER.id])
    })

    it('term on an array field matches when one element matches', async () => {
      // "compute" is the second service of the document
      expect(await sorted({ term: { 'services.type': 'compute' } })).to.deep.equal([
        WEATHER.id
      ])
      expect(await sorted({ term: { 'metadata.tags': 'ml' } })).to.deep.equal([
        CLASSIFIER.id
      ])
    })

    it('term ignores the letter case, a .keyword suffix and accepts { value }', async () => {
      const expected = [ARCHIVE.id, WEATHER.id]
      expect(
        await sorted({ term: { 'indexedMetadata.nft.owner': '0xownera' } })
      ).to.deep.equal(expected)
      expect(
        await sorted({ term: { 'indexedMetadata.nft.owner.keyword': '0xOwnerA' } })
      ).to.deep.equal(expected)
      expect(
        await sorted({ term: { 'indexedMetadata.nft.owner': { value: '0xOwnerA' } } })
      ).to.deep.equal(expected)
    })

    it('terms matches one of the values; _id is the id', async () => {
      expect(await sorted({ terms: { chainId: [137, 1] } })).to.deep.equal([ARCHIVE.id])
      expect(await sorted({ terms: { _id: [WEATHER.id, 'none'] } })).to.deep.equal([
        WEATHER.id
      ])
      expect(await sorted({ terms: { chainId: [] } })).to.deep.equal([])
    })

    it('match and match_phrase find a text inside a value, in any letter case', async () => {
      expect(await sorted({ match: { 'metadata.name': 'WEATHER' } })).to.deep.equal([
        ARCHIVE.id,
        WEATHER.id
      ])
      expect(
        await sorted({ match_phrase: { 'metadata.name': { query: 'weather data' } } })
      ).to.deep.equal([WEATHER.id])
      // % and _ in the text are not wildcards
      expect(await sorted({ match: { 'metadata.name': '%' } })).to.deep.equal([])
    })

    it('range compares numbers as numbers and ISO dates as text', async () => {
      const orders = 'indexedMetadata.stats.orders'
      expect(await sorted({ range: { [orders]: { gt: 0 } } })).to.deep.equal([
        CLASSIFIER.id,
        WEATHER.id
      ])
      // as text, '5' is above '12'
      expect(await sorted({ range: { [orders]: { gte: 6, lte: '12' } } })).to.deep.equal([
        CLASSIFIER.id
      ])
      expect(
        await sorted({
          range: { 'metadata.created': { gte: '2026-02-01', lt: '2026-03-01' } }
        })
      ).to.deep.equal([CLASSIFIER.id])
    })

    it('exists finds a leaf field and an object field', async () => {
      expect(await sorted({ exists: { field: 'metadata.tags' } })).to.deep.equal([
        CLASSIFIER.id,
        WEATHER.id
      ])
      expect(await sorted({ exists: { field: 'metadata' } })).to.have.length(3)
      expect(await sorted({ exists: { field: 'none' } })).to.deep.equal([])
    })

    it('query_string finds words in the listed fields', async () => {
      const fields = ['metadata.name^10', 'metadata.description', 'metadata.tags']
      expect(
        await sorted({ query_string: { query: 'classifier OR temperature', fields } })
      ).to.deep.equal([CLASSIFIER.id, WEATHER.id])
      expect(
        await sorted({
          query_string: { query: '*weather* archive', fields, default_operator: 'AND' }
        })
      ).to.deep.equal([ARCHIVE.id])
      // escaped characters, as the market sends them
      expect(
        await sorted({ query_string: { query: '\\(weath*', fields } })
      ).to.deep.equal([ARCHIVE.id, WEATHER.id])
    })

    it('query_string with no word matches all; with no fields it searches all fields', async () => {
      expect(await sorted({ query_string: { query: '**' } })).to.have.length(3)
      expect(await sorted({ query_string: { query: '0xd2' } })).to.deep.equal([
        WEATHER.id
      ])
    })
  })

  describe('bool', () => {
    it('must and filter are both required; must_not excludes', async () => {
      expect(
        await sorted({
          bool: {
            must: [{ term: { 'metadata.type': 'dataset' } }],
            filter: [{ terms: { chainId: [8996, 137] } }],
            must_not: [{ term: { 'indexedMetadata.nft.state': 5 } }]
          }
        })
      ).to.deep.equal([WEATHER.id])
    })

    it('accepts one clause in place of an array, and skips null and false entries', async () => {
      expect(
        await sorted({
          bool: {
            filter: [null, { term: { chainId: 8996 } }, false],
            must_not: { term: { 'nftAddress.keyword': '0xAAA' } }
          }
        })
      ).to.deep.equal([CLASSIFIER.id])
    })

    it('should alone needs one match; with a filter it is optional', async () => {
      const should = [
        { term: { 'metadata.type': 'algorithm' } },
        { term: { chainId: 137 } }
      ]
      expect(await sorted({ bool: { should } })).to.deep.equal([
        ARCHIVE.id,
        CLASSIFIER.id
      ])
      const filter = [{ term: { chainId: 8996 } }]
      expect(await sorted({ bool: { filter, should } })).to.deep.equal([
        CLASSIFIER.id,
        WEATHER.id
      ])
      expect(
        await sorted({ bool: { filter, should, minimum_should_match: 1 } })
      ).to.deep.equal([CLASSIFIER.id])
    })

    it('nested bool, as the market builds its queries', async () => {
      expect(
        await sorted({
          bool: {
            filter: [
              { terms: { chainId: [8996, 137] } },
              { term: { 'indexedMetadata.purgatory.state': false } },
              {
                bool: {
                  must_not: [
                    { term: { chainId: 11155420 } },
                    false,
                    { term: { 'indexedMetadata.stats.prices.type': 'pool' } }
                  ]
                }
              }
            ]
          }
        })
      ).to.deep.equal([CLASSIFIER.id, WEATHER.id])
    })

    it('an empty query and match_all give all documents', async () => {
      expect(await sorted(undefined)).to.have.length(3)
      expect(await sorted({ bool: {} })).to.have.length(3)
    })
  })

  describe('sort and paging', () => {
    const orders = 'indexedMetadata.stats.orders'

    it('sorts a number field as a number, in the two directions', async () => {
      // as text the order is 0, 12, 5
      expect(await ids({ match_all: {} }, { [orders]: 'asc' })).to.deep.equal([
        ARCHIVE.id,
        WEATHER.id,
        CLASSIFIER.id
      ])
      expect(
        await ids({ match_all: {} }, [{ [orders]: { order: 'desc' } }])
      ).to.deep.equal([CLASSIFIER.id, WEATHER.id, ARCHIVE.id])
    })

    it('sorts a text field, and puts the documents without the field last', async () => {
      expect(await ids({ match_all: {} }, 'metadata.name')).to.deep.equal([
        CLASSIFIER.id,
        WEATHER.id,
        ARCHIVE.id
      ])
      expect(await ids({ match_all: {} }, { 'metadata.tags': 'desc' })).to.deep.equal([
        WEATHER.id,
        CLASSIFIER.id,
        ARCHIVE.id
      ])
    })

    it('accepts _score and gives the documents in a stable order', async () => {
      expect(await ids({ match_all: {} }, { _score: 'desc' })).to.deep.equal([
        ARCHIVE.id,
        CLASSIFIER.id,
        WEATHER.id
      ])
    })

    it('gives one page of the result', async () => {
      const sort = { [orders]: 'asc' }
      const page = async (limit: number, offset: number) =>
        (await documents.search({ query: { match_all: {} }, sort }, limit, offset)).map(
          (doc) => doc.id
        )
      expect(await page(2, 0)).to.deep.equal([ARCHIVE.id, WEATHER.id])
      expect(await page(2, 2)).to.deep.equal([CLASSIFIER.id])
    })
  })

  describe('extra fields', () => {
    it('a query can use a field that is not in the document', async () => {
      expect(await sorted({ term: { _schema: 'op_ddo_short' } })).to.deep.equal([
        ARCHIVE.id
      ])
      expect(await documents.get(ARCHIVE.id)).to.not.have.property('_schema')
    })
  })

  describe('unsupported clauses', () => {
    const rejects = async (query: Record<string, any>, clause: string) => {
      let error: Error
      await documents.search({ query }, 10, 0).catch((err) => {
        error = err
      })
      expect(error).to.be.instanceOf(UnsupportedQueryError)
      expect(error.message).to.equal(
        `Query clause '${clause}' is not supported on the ${SQL_DB_TYPE} database`
      )
    }

    it('names the clause that it cannot run', async () => {
      await rejects({ wildcard: { 'metadata.name': 'oc*' } }, 'wildcard')
      await rejects({ bool: { filter: [{ nested: { path: 'services' } }] } }, 'nested')
      await rejects(
        {
          bool: {
            should: [{ term: { chainId: 1 } }, { term: { chainId: 137 } }],
            minimum_should_match: 2
          }
        },
        'minimum_should_match'
      )
      await rejects({ bool: { must_never: [] } }, 'bool.must_never')
      await rejects({ range: { chainId: { gte: 1, format: 'epoch' } } }, 'range.format')
    })

    it('refuses a terms lookup, which reads another index on Elasticsearch', async () => {
      await rejects(
        { terms: { id: { index: 'nonce', id: '0x1', path: 'nonce' } } },
        'terms lookup'
      )
    })
  })
})

// The query comes from a public caller: the translator must refuse what it does not know,
// and no part of the query must reach the SQL text.
describe('SQL documents: a query that is not valid', () => {
  let db: SqlClient
  let documents: SqlDocuments

  const search = (query: unknown, sort?: unknown) =>
    documents.search({ query: query as any, sort }, 100, 0)
  const errorOf = async (work: Promise<unknown>): Promise<Error> => {
    let error: Error
    await work.catch((err) => {
      error = err
    })
    return error
  }
  // HTTP 400 with the name of the clause or the option
  const unsupported = async (work: Promise<unknown>, clause: string) => {
    const error = await errorOf(work)
    expect(error).to.be.instanceOf(UnsupportedQueryError)
    expect(error.message).to.contain(`'${clause}'`)
  }
  // HTTP 400; not an error of the database
  const invalid = async (work: Promise<unknown>) => {
    const error = await errorOf(work)
    expect(error).to.be.instanceOf(QueryError)
    expect(error).to.not.be.instanceOf(UnsupportedQueryError)
  }

  beforeEach(async () => {
    db = await makeSqlClient()
    documents = new SqlDocuments(db, 'ddo', SQL_DB_TYPE)
    await documents.init()
    await documents.put('a', { name: 'a', secret: 'do not read' })
  })
  afterEach(() => db.close())

  it('refuses a clause with the name of an Object.prototype member', async () => {
    // Object(body) gives the body back: the caller would write the SQL
    const injected = { sql: '1 = 1 --', params: [] as unknown[] }
    await unsupported(search({ constructor: injected }), 'constructor')
    await unsupported(search({ toString: {} }), 'toString')
    await unsupported(search(JSON.parse('{"__proto__": {"sql": "1 = 1"}}')), '__proto__')
    await unsupported(
      search({ range: { name: { constructor: 1 } } }),
      'range.constructor'
    )
  })

  it('refuses a clause that has a wrong type', async () => {
    for (const query of [
      'match_all',
      { bool: null },
      { bool: { filter: [5] } },
      { term: {} },
      { term: 'name' },
      { term: { name: { value: { nested: 1 } } } },
      { term: { name: [1, 2] } },
      { terms: { name: [{ a: 1 }] } },
      { match: { name: {} } },
      { range: { name: null } },
      { range: { name: { gte: [1] } } },
      { exists: { field: 5 } },
      { query_string: 'name' },
      { query_string: { query: 'a', fields: 'name' } },
      { query_string: { query: 'a', fields: [5] } }
    ]) {
      await invalid(search(query))
    }
  })

  it('refuses a clause with two names, and a leaf clause with two fields', async () => {
    await invalid(search({ term: { name: 'a' }, match_all: {} }))
    // Elasticsearch refuses this too; the second field must not be ignored
    await invalid(search({ term: { name: 'a', secret: 'x' } }))
    await invalid(search({ range: { name: { gte: 'a' }, secret: { gte: 'a' } } }))
  })

  it('refuses an option that it does not evaluate', async () => {
    await unsupported(
      search({ match: { name: { query: 'a', operator: 'and' } } }),
      'match.operator'
    )
    await unsupported(
      search({ term: { name: { value: 'a', case_insensitive: true } } }),
      'term.case_insensitive'
    )
    await unsupported(search({ exists: { field: 'name', other: 1 } }), 'exists.other')
    await unsupported(
      search({ query_string: { query: 'a', fuzziness: 2 } }),
      'query_string.fuzziness'
    )
    await unsupported(
      search({ query_string: { query: 'a', fields: ['metadata.*'] } }),
      'query_string field pattern'
    )
    // boost changes the score only
    expect(await search({ term: { name: { value: 'a', boost: 2 } } })).to.have.length(1)
    expect(await search({ terms: { name: ['a'], boost: 2 } })).to.have.length(1)
  })

  it('refuses the query_string operators that it does not evaluate', async () => {
    for (const query of [
      'a NOT b',
      '+a -b',
      '!a',
      'name:a',
      'a~',
      'a?c',
      'a^2',
      'a && b',
      'a || b'
    ]) {
      await unsupported(search({ query_string: { query } }), 'query_string operator')
    }
    // a client escapes the text of a user: an operator after a backslash is text
    const escaped = { query_string: { query: 'did\\:op\\:a OR \\-a OR a' } }
    expect(await search(escaped)).to.have.length(1)
  })

  it('refuses a sort that it cannot do', async () => {
    await unsupported(
      search({}, { name: { order: 'asc', missing: '_first' } }),
      'sort.missing'
    )
    await unsupported(
      search({}, { _script: { type: 'number', script: 'x', order: 'asc' } }),
      'sort.type'
    )
    await invalid(search({}, { name: 'up' }))
    await invalid(search({}, 5))
    await invalid(
      search(
        {},
        Array.from({ length: 9 }, (_, i) => `field${i}`)
      )
    )
  })

  it('limits the size of a query', async () => {
    const manyValues = Array.from({ length: 2000 }, (_, i) => `v${i}`)
    await invalid(search({ terms: { name: manyValues } }))
    await invalid(search({ query_string: { query: manyValues.join(' ') } }))
    let deep: Record<string, any> = { match_all: {} }
    for (let level = 0; level < 30; level++) {
      deep = { bool: { filter: [deep] } }
    }
    await invalid(search(deep))
    // a list of 1000 ids is a normal query
    expect(await search({ terms: { name: manyValues.slice(0, 1000) } })).to.deep.equal([])
  })

  it('refuses a page that is not a whole number, 0 or more', async () => {
    for (const page of [
      { size: -1 },
      { size: 'abc' },
      { size: { a: 1 } },
      { from: 1.5 }
    ]) {
      await invalid(documents.query({ query: { match_all: {} }, ...page }))
    }
    expect(await documents.query({ size: 0, from: 0 })).to.have.length(1)
  })
})

// Differences that a comparison with Elasticsearch on the same documents found.
describe('SQL documents: values and order', () => {
  let db: SqlClient
  let documents: SqlDocuments
  const LONG = 'x'.repeat(600)

  const ids = async (query: Record<string, any>, sort?: unknown) =>
    (await documents.search({ query, sort }, 100, 0)).map((doc) => doc.id)

  beforeEach(async () => {
    db = await makeSqlClient()
    documents = new SqlDocuments(db, 'ddo', SQL_DB_TYPE)
    await documents.init()
    await documents.put('cheap', {
      name: '_x',
      price: '2.5',
      created: '2022-06-10T08:00:00Z'
    })
    await documents.put('dear', {
      name: 'Ärger',
      price: '10',
      created: '2023-01-05T08:00:00Z'
    })
    await documents.put('free', { name: 'a', price: 0, license: LONG })
  })
  afterEach(() => db.close())

  it('compares and sorts a number that is stored as text as a number', async () => {
    // as text, '10' is below '2.5'
    expect(await ids({ range: { price: { gte: 5 } } })).to.deep.equal(['dear'])
    expect(await ids({ range: { price: { gt: '0', lt: '5' } } })).to.deep.equal(['cheap'])
    expect(await ids({ match_all: {} }, { price: 'desc' })).to.deep.equal([
      'dear',
      'cheap',
      'free'
    ])
  })

  it('compares a date with a bound that holds only a year', async () => {
    expect(await ids({ range: { created: { gte: '2023' } } })).to.deep.equal(['dear'])
    expect(await ids({ range: { created: { gte: '2022', lt: '2023' } } })).to.deep.equal([
      'cheap'
    ])
  })

  it('finds a value that is longer than the text that the field table keeps', async () => {
    expect(await ids({ term: { license: LONG } })).to.deep.equal(['free'])
    expect(await ids({ match: { license: LONG } })).to.deep.equal(['free'])
  })

  it('sorts and compares text by its bytes, the same on all databases', async () => {
    // lower case: '_' (0x5f), 'a' (0x61), 'ä' (0xc3 0xa4)
    expect(await ids({ match_all: {} }, { name: 'asc' })).to.deep.equal([
      'cheap',
      'free',
      'dear'
    ])
    expect(await ids({ range: { name: { gte: 'a', lt: 'c' } } })).to.deep.equal(['free'])
  })

  it('should alone needs one match when minimum_should_match is 0', async () => {
    const should = [{ term: { name: 'a' } }]
    expect(await ids({ bool: { should, minimum_should_match: 0 } })).to.deep.equal([
      'free'
    ])
  })

  it('gives no field row to a path that is longer than a field name', async () => {
    const key = 'k'.repeat(200)
    await documents.put('long-path', { [key]: 'value', name: 'b' })
    expect(await ids({ term: { name: 'b' } })).to.deep.equal(['long-path'])
    expect(await ids({ exists: { field: key } })).to.deep.equal([])
  })
})
