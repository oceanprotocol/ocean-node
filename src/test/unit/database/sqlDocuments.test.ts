import { expect } from 'chai'
import type { SqlClient } from '../../../components/database/sql/SqlClient.js'
import { makeSqlClient } from '../../utils/sqlClient.js'
import {
  SqlDocuments,
  flattenDocument
} from '../../../components/database/sql/SqlDocuments.js'
import type { Condition, SortSpec } from '../../../components/database/BaseDatabase.js'

// Conditions, sort and paging on a SQL document table.

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
    tags: ['ml', 'weather'],
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

const ALL = { offset: 0, limit: 100 }

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

  it('gives no row for null, and keeps the full text of a long string', () => {
    const rows = flattenDocument({ none: null, long: 'A'.repeat(600) })
    expect(rows).to.have.length(1)
    expect(rows[0].str).to.equal('a'.repeat(600))
  })
})

describe('SQL documents', () => {
  let db: SqlClient
  let documents: SqlDocuments

  const ids = async (conditions: Condition[], sort: SortSpec[] = []) =>
    (await documents.find(conditions, sort, ALL)).results.map((doc) => doc.id)
  const sorted = async (conditions: Condition[]) => (await ids(conditions)).sort()
  const count = async () =>
    Number((await db.get('SELECT COUNT(*) AS "count" FROM ddo')).count)

  beforeEach(async () => {
    db = await makeSqlClient()
    documents = new SqlDocuments(db, 'ddo')
    await documents.init()
    await documents.put(WEATHER.id, WEATHER)
    await documents.put(CLASSIFIER.id, CLASSIFIER)
    await documents.put(ARCHIVE.id, ARCHIVE)
  })
  afterEach(() => db.close())

  describe('documents', () => {
    it('reads a document back, and null for an unknown id', async () => {
      expect(await documents.get(WEATHER.id)).to.deep.equal(WEATHER)
      expect(await documents.get('none')).to.equal(null)
    })

    it('a second put replaces the document and its old field rows', async () => {
      await documents.put(WEATHER.id, { ...WEATHER, chainId: 1 })
      expect(await sorted([{ paths: ['chainId'], anyOf: [8996] }])).to.deep.equal([
        CLASSIFIER.id
      ])
      expect(await sorted([{ paths: ['chainId'], anyOf: [1] }])).to.deep.equal([
        WEATHER.id
      ])
      expect(await count()).to.equal(3)
    })

    it('adds the id to a document that has no id field', async () => {
      await documents.put('order-1', { consumer: '0xC' })
      expect(await documents.get('order-1')).to.deep.equal({
        consumer: '0xC',
        id: 'order-1'
      })
      expect(await ids([{ paths: ['id'], anyOf: ['order-1'] }])).to.deep.equal([
        'order-1'
      ])
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
      expect(await count()).to.equal(3)
    })

    it('gives the documents in the order of the bytes of their ids', async () => {
      for (const id of ['e1', 'e10', 'e-dup', 'E2']) {
        await documents.put(id, { kind: 'event' })
      }
      expect(await ids([{ paths: ['kind'], anyOf: ['event'] }])).to.deep.equal([
        'E2',
        'e-dup',
        'e1',
        'e10'
      ])
    })

    it('deletes a document with its field rows', async () => {
      expect(await documents.delete(WEATHER.id)).to.equal(true)
      expect(await documents.delete(WEATHER.id)).to.equal(false)
      expect(await sorted([])).to.deep.equal([ARCHIVE.id, CLASSIFIER.id])
      const rows = await db.all('SELECT * FROM ddo_fields WHERE "id" = ?', [WEATHER.id])
      expect(rows).to.deep.equal([])
    })

    it('keeps a document whose text has a NUL character', async () => {
      await documents.put('nul', {
        name: 'a\u0000b',
        'k\u0000ey': 'v',
        metadata: { 'k\u0000ey': 'w' }
      })
      expect(await sorted([{ paths: ['name'], anyOf: ['ab'] }])).to.deep.equal(['nul'])
      expect(await sorted([{ paths: ['metadata.key'], anyOf: ['w'] }])).to.deep.equal([
        'nul'
      ])
      expect((await documents.get('nul')).name).to.equal('a\u0000b')
    })

    it('deletes many documents with their field rows, more than one statement holds', async () => {
      for (let i = 0; i < 450; i++) await documents.put(`bulk-${i}`, { kind: 'bulk' })
      expect(
        await documents.deleteMatching([{ paths: ['kind'], anyOf: ['bulk'] }])
      ).to.equal(450)
      expect(await count()).to.equal(3)
      const left = await db.get(
        'SELECT COUNT(*) AS "n" FROM ddo_fields WHERE "id" LIKE ?',
        ['bulk-%']
      )
      expect(Number(left.n)).to.equal(0)
    })

    it('deletes the documents that meet the conditions', async () => {
      expect(
        await documents.deleteMatching([{ paths: ['chainId'], anyOf: [8996] }])
      ).to.equal(2)
      expect(await sorted([])).to.deep.equal([ARCHIVE.id])
    })
  })

  describe('conditions', () => {
    it('anyOf: a scalar, a number and a boolean, in any letter case', async () => {
      expect(
        await sorted([{ paths: ['metadata.type'], anyOf: ['DATASET'] }])
      ).to.deep.equal([ARCHIVE.id, WEATHER.id])
      expect(await sorted([{ paths: ['chainId'], anyOf: [137] }])).to.deep.equal([
        ARCHIVE.id
      ])
      expect(
        await sorted([{ paths: ['indexedMetadata.purgatory.state'], anyOf: [true] }])
      ).to.deep.equal([ARCHIVE.id])
    })

    it('anyOf: a field in an array matches when one element matches', async () => {
      expect(
        await sorted([{ paths: ['services.type'], anyOf: ['compute'] }])
      ).to.deep.equal([WEATHER.id])
      expect(
        await sorted([{ paths: ['metadata.tags'], anyOf: ['climate'] }])
      ).to.deep.equal([WEATHER.id])
    })

    it('anyOf: one of the values, on one of the paths; no value matches nothing', async () => {
      expect(
        await sorted([{ paths: ['id'], anyOf: [WEATHER.id, ARCHIVE.id, 'did:op:none'] }])
      ).to.deep.equal([ARCHIVE.id, WEATHER.id])
      expect(
        await sorted([{ paths: ['nftAddress', 'other.nftAddress'], anyOf: ['0xbbb'] }])
      ).to.deep.equal([CLASSIFIER.id])
      expect(await ids([{ paths: ['id'], anyOf: [] }])).to.deep.equal([])
    })

    it('noneOf: a document without the field passes; no value excludes nothing', async () => {
      expect(
        await sorted([{ paths: ['indexedMetadata.nft.state'], noneOf: [5] }])
      ).to.deep.equal([CLASSIFIER.id, WEATHER.id])
      expect(
        await sorted([{ paths: ['metadata.description'], noneOf: ['x'] }])
      ).to.deep.equal([ARCHIVE.id, CLASSIFIER.id, WEATHER.id])
      expect(await sorted([{ paths: ['id'], noneOf: [] }])).to.have.length(3)
    })

    it('range: numbers as numbers, ISO dates as text', async () => {
      expect(
        await sorted([{ paths: ['indexedMetadata.stats.orders'], range: { gt: 4 } }])
      ).to.deep.equal([CLASSIFIER.id, WEATHER.id])
      expect(
        await sorted([
          { paths: ['metadata.created'], range: { gte: '2026-02-01T00:00:00.000Z' } }
        ])
      ).to.deep.equal([ARCHIVE.id, CLASSIFIER.id])
    })

    it('exists: a leaf field and an object field', async () => {
      expect(
        await sorted([{ paths: ['metadata.description'], exists: true }])
      ).to.deep.equal([WEATHER.id])
      expect(await sorted([{ paths: ['indexedMetadata'], exists: true }])).to.have.length(
        3
      )
      expect(await sorted([{ paths: ['nothing'], exists: true }])).to.deep.equal([])
    })

    it('words: each word inside a value of one of the fields, in any letter case', async () => {
      const text = ['metadata.name', 'metadata.description', 'metadata.tags']
      expect(await sorted([{ paths: text, words: ['WEATHER'] }])).to.deep.equal([
        ARCHIVE.id,
        CLASSIFIER.id,
        WEATHER.id
      ])
      expect(await sorted([{ paths: text, words: ['weather', 'sea'] }])).to.deep.equal([
        WEATHER.id
      ])
      expect(await sorted([{ paths: text, words: ['clas'] }])).to.deep.equal([
        CLASSIFIER.id
      ])
      // a LIKE wildcard in a word is a plain character
      expect(await sorted([{ paths: text, words: ['%'] }])).to.deep.equal([])
    })

    it('a value longer than the index key: words after the key, and full equality', async () => {
      const long = 'a'.repeat(600)
      await documents.put('long', { metadata: { description: `${long} ocean` } })
      const description = ['metadata.description']
      expect(await ids([{ paths: description, words: ['ocean'] }])).to.deep.equal([
        'long'
      ])
      expect(await ids([{ paths: description, anyOf: [`${long} ocean`] }])).to.deep.equal(
        ['long']
      )
      // the same first 512 characters are not the same value
      expect(await ids([{ paths: description, anyOf: [long] }])).to.deep.equal([])
    })

    it('either: one of the conditions holds; no condition matches nothing', async () => {
      const either: Condition[] = [
        { paths: ['id'], anyOf: [ARCHIVE.id] },
        { paths: ['indexedMetadata.nft.owner'], anyOf: ['0xownerb'] }
      ]
      expect(await sorted([{ either }])).to.deep.equal([ARCHIVE.id, CLASSIFIER.id])
      expect(await ids([{ either: [] }])).to.deep.equal([])
    })

    it('all conditions must hold', async () => {
      expect(
        await sorted([
          { paths: ['metadata.type'], anyOf: ['dataset'] },
          { paths: ['indexedMetadata.nft.state'], noneOf: [5] }
        ])
      ).to.deep.equal([WEATHER.id])
    })
  })

  describe('sort, paging and counts', () => {
    const orders: SortSpec = { paths: ['indexedMetadata.stats.orders'], order: 'desc' }

    it('sorts a number field as a number, in the two directions', async () => {
      expect(await ids([], [orders])).to.deep.equal([
        CLASSIFIER.id,
        WEATHER.id,
        ARCHIVE.id
      ])
      expect(await ids([], [{ ...orders, order: 'asc' }])).to.deep.equal([
        ARCHIVE.id,
        WEATHER.id,
        CLASSIFIER.id
      ])
    })

    it('puts the documents without the field last', async () => {
      const description: SortSpec = { paths: ['metadata.description'], order: 'asc' }
      const found = await ids([], [description])
      expect(found[0]).to.equal(WEATHER.id)
    })

    it('gives one page and the number of all matches', async () => {
      const page = await documents.find([], [orders], { offset: 1, limit: 1 })
      expect(page.results.map((doc) => doc.id)).to.deep.equal([WEATHER.id])
      expect(page.totalResults).to.equal(3)
      const countOnly = await documents.find([], [], { offset: 0, limit: 0 })
      expect(countOnly).to.deep.equal({ results: [], totalResults: 3 })
    })

    it('counts the distinct values of a field in the documents that match', async () => {
      const tags = await documents.valueCounts(['metadata.tags'], [], 10)
      expect(tags).to.deep.equal([
        { value: 'weather', count: 2 },
        { value: 'climate', count: 1 },
        { value: 'ml', count: 1 }
      ])
      const ofDatasets = await documents.valueCounts(
        ['metadata.tags'],
        [{ paths: ['metadata.type'], anyOf: ['dataset'] }],
        1
      )
      expect(ofDatasets).to.deep.equal([{ value: 'climate', count: 1 }])
    })
  })
})

// Differences that a comparison with Elasticsearch on the same documents found.
describe('SQL documents: values and order', () => {
  let db: SqlClient
  let documents: SqlDocuments
  const LONG = 'x'.repeat(600)

  const ids = async (conditions: Condition[], sort: SortSpec[] = []) =>
    (await documents.find(conditions, sort, ALL)).results.map((doc) => doc.id)

  beforeEach(async () => {
    db = await makeSqlClient()
    documents = new SqlDocuments(db, 'ddo')
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
    expect(await ids([{ paths: ['price'], range: { gte: 5 } }])).to.deep.equal(['dear'])
    expect(await ids([{ paths: ['price'], range: { gt: '0', lt: '5' } }])).to.deep.equal([
      'cheap'
    ])
    expect(await ids([], [{ paths: ['price'], order: 'desc' }])).to.deep.equal([
      'dear',
      'cheap',
      'free'
    ])
  })

  it('compares a date with a bound that holds only a year', async () => {
    expect(await ids([{ paths: ['created'], range: { gte: '2023' } }])).to.deep.equal([
      'dear'
    ])
  })

  it('finds a value that is longer than the text that the field table keeps', async () => {
    expect(await ids([{ paths: ['license'], anyOf: [LONG] }])).to.deep.equal(['free'])
    expect(await ids([{ paths: ['license'], words: [LONG] }])).to.deep.equal(['free'])
  })

  it('sorts and compares text by its bytes, the same on all databases', async () => {
    // lower case: '_' (0x5f), 'a' (0x61), 'ä' (0xc3 0xa4)
    expect(await ids([], [{ paths: ['name'], order: 'asc' }])).to.deep.equal([
      'cheap',
      'free',
      'dear'
    ])
    expect(await ids([{ paths: ['name'], range: { gte: 'a', lt: 'c' } }])).to.deep.equal([
      'free'
    ])
  })

  it('gives no field row to a path that is longer than a field name', async () => {
    const key = 'k'.repeat(200)
    await documents.put('long-path', { [key]: 'value', name: 'b' })
    expect(await ids([{ paths: ['name'], anyOf: ['b'] }])).to.deep.equal(['long-path'])
    expect(await ids([{ paths: [key], exists: true }])).to.deep.equal([])
  })
})
