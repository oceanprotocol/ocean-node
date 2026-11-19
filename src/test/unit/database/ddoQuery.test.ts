import { expect } from 'chai'
import { getAddress } from 'ethers'
import type { Client } from '@elastic/elasticsearch'
import {
  AbstractDdoDatabase,
  QueryError,
  TagCount
} from '../../../components/database/BaseDatabase.js'
import {
  assetConditions,
  pageOf,
  parseQueryRequest,
  sortOf
} from '../../../components/database/assetQuery.js'
import { SqlDdoDatabase } from '../../../components/database/sql/SqlDdo.js'
import { SqlDocuments } from '../../../components/database/sql/SqlDocuments.js'
import type { SqlClient } from '../../../components/database/sql/SqlClient.js'
import { ElasticsearchDdoDatabase } from '../../../components/database/ElasticSearchDatabase.js'
import { createElasticsearchClientWithRetry } from '../../../components/database/ElasticsearchConfigHelper.js'
import { getConfiguration } from '../../../utils/index.js'
import { SQL_DB_CONFIG, makeSqlClient } from '../../utils/sqlClient.js'
import { describeOnElasticsearch } from '../../utils/utils.js'

// The queries of the Enterprise Market (OceanProtocolEnterprise/market, src/@utils/aquarius
// and src/@utils/compute), written in the query of the node, give the same DDOs on SQLite,
// PostgreSQL and Elasticsearch, for DDO v4 and v5 documents.

// a chain of these tests only, so the documents of a shared Elasticsearch do not count
const CHAIN = 7777777
const address = (byte: string) => getAddress('0x' + byte.repeat(20))
const OWNER_A = address('a1')
const OWNER_B = address('b2')
const NODE1 = 'https://node1.example.com'
const NODE2 = 'https://node2.example.com'

interface Stats {
  owner?: string
  state?: number
  purgatory?: boolean
  block?: number
  orders?: number
  priceType?: string
  price?: string
  symbol?: string
  tokenName?: string
  datatoken?: string
}

const indexed = (s: Stats) => ({
  nft: { state: s.state ?? 0, owner: s.owner },
  purgatory: { state: s.purgatory ?? false },
  event: { block: s.block },
  stats: [
    {
      datatokenAddress: s.datatoken,
      orders: s.orders,
      name: s.tokenName,
      symbol: s.symbol,
      prices: [{ type: s.priceType, price: s.price }]
    }
  ]
})

const v5 = (
  id: string,
  subject: Record<string, any>,
  stats?: Stats
): Record<string, any> => ({
  '@context': ['https://www.w3.org/ns/credentials/v2'],
  id,
  version: '5.0.0',
  credentialSubject: { id, chainId: CHAIN, ...subject },
  ...(stats && { indexedMetadata: indexed(stats) })
})

const A = v5(
  'did:op:query-a',
  {
    nftAddress: address('e1'),
    dataspace: 'ds-1',
    metadata: {
      type: 'dataset',
      name: 'Ocean Weather Data',
      description: { value: 'Hourly temperature of the North Sea' },
      author: 'OPF',
      tags: ['weather', 'climate'],
      created: '2026-01-10T00:00:00Z'
    },
    services: [
      { type: 'access', datatokenAddress: address('d1'), serviceEndpoint: NODE1 },
      {
        type: 'compute',
        datatokenAddress: address('d2'),
        serviceEndpoint: NODE1,
        compute: {
          publisherTrustedAlgorithms: [{ did: 'did:op:query-b', serviceId: 'algo-svc' }],
          publisherTrustedAlgorithmPublishers: [OWNER_B]
        }
      }
    ]
  },
  {
    owner: OWNER_A,
    block: 100,
    orders: 5,
    priceType: 'fixedrate',
    price: '8',
    symbol: 'WTH',
    tokenName: 'Weather Token',
    datatoken: address('d1')
  }
)
const B = v5(
  'did:op:query-b',
  {
    nftAddress: address('e2'),
    dataspace: 'ds-1',
    metadata: {
      type: 'algorithm',
      name: 'Image Classifier',
      description: { value: 'Classifies images' },
      author: 'OPF',
      tags: ['ml'],
      created: '2026-02-10T00:00:00Z'
    },
    services: [
      { type: 'access', datatokenAddress: address('d3'), serviceEndpoint: NODE2 }
    ]
  },
  {
    owner: OWNER_B,
    block: 200,
    orders: 12,
    priceType: 'dispenser',
    price: '0',
    symbol: 'IMG',
    tokenName: 'Image Token'
  }
)
const C = v5(
  'did:op:query-c',
  {
    nftAddress: address('e3'),
    dataspace: 'ds-2',
    metadata: {
      type: 'dataset',
      name: 'Sea level archive',
      description: { value: 'Tide gauges' },
      author: 'OPF',
      tags: ['climate'],
      created: '2026-03-10T00:00:00Z'
    },
    services: [
      {
        type: 'compute',
        datatokenAddress: address('d4'),
        serviceEndpoint: NODE2,
        compute: {
          publisherTrustedAlgorithms: [{ did: '*', serviceId: '*' }],
          publisherTrustedAlgorithmPublishers: ['*']
        }
      }
    ]
  },
  {
    owner: OWNER_A,
    purgatory: true,
    block: 300,
    orders: 0,
    priceType: 'fixedrate',
    price: '3',
    symbol: 'SEA'
  }
)
const D = v5(
  'did:op:query-d',
  {
    nftAddress: address('e4'),
    dataspace: 'ds-1',
    metadata: {
      type: 'dataset',
      name: 'Revoked weather set',
      description: { value: 'Revoked' },
      author: 'OPF',
      tags: ['weather'],
      created: '2026-04-10T00:00:00Z'
    },
    services: [
      { type: 'access', datatokenAddress: address('d5'), serviceEndpoint: NODE1 }
    ]
  },
  {
    owner: OWNER_B,
    state: 5,
    block: 400,
    orders: 1,
    priceType: 'pool',
    price: '7',
    symbol: 'REV'
  }
)
const E = {
  '@context': ['https://w3id.org/did/v1'],
  id: 'did:op:query-e',
  version: '4.1.0',
  chainId: CHAIN,
  nftAddress: address('e5'),
  metadata: {
    type: 'dataset',
    name: 'Weather stations',
    description: 'Daily weather station readings',
    author: 'Met',
    tags: ['weather'],
    created: '2025-12-01T00:00:00Z'
  },
  services: [{ type: 'access', datatokenAddress: address('d6'), serviceEndpoint: NODE1 }],
  indexedMetadata: indexed({
    owner: OWNER_A,
    block: 50,
    orders: 2,
    priceType: 'fixedrate',
    price: '5',
    symbol: 'STN'
  })
}
// not indexed yet: no indexedMetadata
const F = v5('did:op:query-f', {
  nftAddress: address('e6'),
  dataspace: 'ds-1',
  metadata: {
    type: 'dataset',
    name: 'Unindexed weather',
    description: { value: 'Pending' },
    author: 'OPF',
    tags: [] as string[],
    created: '2026-05-01T00:00:00Z'
  },
  services: [{ type: 'access', datatokenAddress: address('d7'), serviceEndpoint: NODE1 }]
})

const DOCUMENTS: Record<string, any>[] = [A, B, C, D, E, F]

interface Case {
  name: string
  body: Record<string, any>
  // the ids in this order; `anyOrder` compares them as a set
  ids?: string[]
  anyOrder?: boolean
  total?: number
  tags?: TagCount[]
}

const onChain = (filter: Record<string, any> = {}) => ({ chainIds: [CHAIN], ...filter })

const CASES: Case[] = [
  {
    name: 'search box: the assets with the word, newest first',
    body: {
      filter: onChain({ text: 'weather' }),
      sort: { by: 'created', order: 'desc' }
    },
    ids: [A.id, E.id, F.id]
  },
  {
    name: 'search box: every word must be in the asset',
    body: { filter: onChain({ text: 'Weather NORTH' }) },
    ids: [A.id]
  },
  {
    name: 'search box: the start of a word',
    body: { filter: onChain({ text: 'classif' }) },
    ids: [B.id]
  },
  {
    name: 'search box with relevance sort',
    body: { filter: onChain({ text: 'weather' }), sort: { by: 'relevance' } },
    ids: [A.id, E.id, F.id],
    anyOrder: true
  },
  {
    name: 'relevance with no text: newest first',
    body: { filter: onChain(), sort: { by: 'relevance' } },
    ids: [B.id, A.id, E.id, F.id]
  },
  {
    name: 'search box: a pasted DID',
    body: { filter: onChain({ text: ` ${B.id} ` }) },
    ids: [B.id]
  },
  {
    name: 'search box: a pasted owner address, in lower case',
    body: { filter: onChain({ text: OWNER_B.toLowerCase() }) },
    ids: [B.id]
  },
  {
    name: 'search box: a pasted datatoken address',
    body: { filter: onChain({ text: address('d1') }) },
    ids: [A.id]
  },
  {
    name: 'DDO v5 only',
    body: { filter: onChain({ versions: ['5.0.0'] }) },
    ids: [B.id, A.id, F.id]
  },
  {
    name: 'search filters: type, service, tags, price, time, node and dataspace',
    body: {
      filter: onChain({
        types: ['dataset'],
        serviceTypes: ['access'],
        tags: ['weather'],
        priceTypes: ['fixedrate'],
        createdAfter: '2026-01-01T00:00:00.000Z',
        serviceEndpoints: [NODE1],
        dataspace: 'ds-1'
      })
    },
    ids: [A.id]
  },
  {
    name: 'the default hides unlisted (state 5) and purgatory assets',
    body: { filter: onChain() },
    ids: [B.id, A.id, E.id, F.id]
  },
  {
    name: 'hide pool prices, with an explicit list of states',
    body: {
      filter: onChain({
        excludePriceTypes: ['pool'],
        nftStates: [0, 5],
        includeUnlisted: true
      })
    },
    ids: [B.id, A.id, E.id]
  },
  {
    name: 'asset state filter: unlisted stays hidden unless included',
    body: { filter: onChain({ nftStates: [5] }) },
    ids: []
  },
  {
    name: 'asset state filter with unlisted included',
    body: { filter: onChain({ nftStates: [5], includeUnlisted: true }) },
    ids: [D.id]
  },
  {
    name: 'published assets of an owner, with purgatory, owner in lower case',
    body: {
      filter: onChain({ owners: [OWNER_A.toLowerCase()], includePurgatory: true })
    },
    ids: [C.id, A.id, E.id]
  },
  {
    name: 'bookmarks and most viewed: assets from a DID list',
    body: { filter: onChain({ ids: [A.id, B.id, 'did:op:none'] }) },
    ids: [B.id, A.id]
  },
  {
    name: 'related assets: same tags, without this asset',
    body: {
      filter: onChain({ tags: ['weather', 'climate'], excludeIds: [A.id] }),
      size: 4
    },
    ids: [E.id]
  },
  {
    name: 'related assets: same owner, without this NFT, most orders first',
    body: {
      filter: onChain({
        owners: [OWNER_A],
        excludeNftAddresses: [A.credentialSubject.nftAddress.toLowerCase()]
      }),
      sort: { by: 'orders', order: 'desc' }
    },
    ids: [E.id]
  },
  {
    name: 'algorithm allowlist: one of the ids or of the owners',
    body: {
      filter: onChain({
        types: ['algorithm'],
        anyOf: [{ ids: ['did:op:none'], owners: [OWNER_B] }]
      }),
      size: 3000
    },
    ids: [B.id]
  },
  {
    name: 'whitelist and allowlist: one value of each group',
    body: {
      filter: onChain({
        anyOf: [
          { owners: [OWNER_B], datatokenAddresses: [address('d1').toLowerCase()] },
          { ids: [A.id, 'did:op:none'] }
        ]
      })
    },
    ids: [A.id]
  },
  {
    name: 'datasets that trust an algorithm (DID and service)',
    body: {
      filter: onChain({ trustedAlgorithm: { did: B.id, serviceId: 'algo-svc' } })
    },
    ids: [A.id]
  },
  {
    name: 'datasets that trust every algorithm',
    body: {
      filter: onChain({
        trustedAlgorithm: { did: '*', serviceId: '*' },
        includePurgatory: true
      })
    },
    ids: [C.id]
  },
  {
    name: 'datasets that trust every algorithm publisher',
    body: { filter: onChain({ trustedAlgorithmPublisher: '*', includePurgatory: true }) },
    ids: [C.id]
  },
  {
    name: 'compute datasets of a datatoken, address in lower case',
    body: {
      filter: onChain({
        datatokenAddresses: [
          A.credentialSubject.services[1].datatokenAddress.toLowerCase()
        ],
        serviceTypes: ['compute'],
        types: ['dataset'],
        includePurgatory: true
      })
    },
    ids: [A.id]
  },
  {
    name: 'downloads: indexed access assets of datatokens',
    body: {
      filter: onChain({
        datatokenAddresses: [
          E.services[0].datatokenAddress,
          F.credentialSubject.services[0].datatokenAddress
        ],
        serviceTypes: ['access'],
        indexedOnly: true,
        includePurgatory: true
      })
    },
    ids: [E.id]
  },
  {
    name: 'sort by orders, the most first; without the field last',
    body: { filter: onChain(), sort: { by: 'orders', order: 'desc' } },
    ids: [B.id, A.id, E.id, F.id]
  },
  {
    name: 'sort by price, the lowest first',
    body: { filter: onChain(), sort: { by: 'price', order: 'asc' } },
    ids: [B.id, E.id, A.id, F.id]
  },
  {
    name: 'sort by token symbol',
    body: { filter: onChain(), sort: { by: 'tokenSymbol', order: 'asc' } },
    ids: [B.id, E.id, A.id, F.id]
  },
  {
    name: 'sort by created, the oldest first',
    body: { filter: onChain(), sort: { by: 'created', order: 'asc' } },
    ids: [E.id, A.id, B.id, F.id]
  },
  {
    name: 'one page, and the total of all matches',
    body: { filter: onChain(), page: 2, size: 2 },
    ids: [E.id, F.id],
    total: 4
  },
  {
    name: 'tags of the assets that match',
    body: { type: 'tags', filter: onChain() },
    tags: [
      { tag: 'weather', count: 2 },
      { tag: 'climate', count: 1 },
      { tag: 'ml', count: 1 }
    ]
  }
]

async function run(store: AbstractDdoDatabase, body: Record<string, any>) {
  const request = parseQueryRequest(body)
  if (request.type === 'tags') {
    return { tags: await store.tags(assetConditions(request.filter), request.size) }
  }
  if (request.type !== 'assets') throw new Error('not a DDO query')
  return await store.find(
    assetConditions(request.filter),
    sortOf(request.sort),
    pageOf(request)
  )
}

function checkCases(getStore: () => AbstractDdoDatabase): void {
  for (const c of CASES) {
    it(c.name, async () => {
      const answer: any = await run(getStore(), c.body)
      if (c.tags) {
        expect(answer.tags).to.deep.equal(c.tags)
        return
      }
      const ids = answer.results.map((ddo: any) => ddo.id)
      if (c.anyOrder) expect([...ids].sort()).to.deep.equal([...c.ids].sort())
      else expect(ids).to.deep.equal(c.ids)
      if (c.total !== undefined) expect(answer.totalResults).to.equal(c.total)
    })
  }
}

describe('Query of the node: the Enterprise Market searches on SQL', () => {
  let db: SqlClient
  let store: SqlDdoDatabase

  before(async () => {
    db = await makeSqlClient()
    store = new SqlDdoDatabase(SQL_DB_CONFIG, db)
    await store.init()
    // stored as they are: the SHACL validation of create() is not under test here
    const documents = new SqlDocuments(db, 'ddo')
    for (const doc of DOCUMENTS) await documents.put(doc.id, doc)
  })
  after(() => db.close())

  checkCases(() => store)

  it('deletes the DDOs of a chain, v4 and v5', async () => {
    expect(await store.deleteAllAssetsFromChain(CHAIN)).to.equal(DOCUMENTS.length)
  })
})

describeOnElasticsearch(
  'Query of the node: the Enterprise Market searches on Elasticsearch',
  () => {
    let store: ElasticsearchDdoDatabase
    let client: Client

    before(async function () {
      this.timeout(60000)
      const config = (await getConfiguration()).dbConfig
      store = await ElasticsearchDdoDatabase.create(config)
      client = await createElasticsearchClientWithRetry(config)
      await store.deleteAllAssetsFromChain(CHAIN)
      // stored as they are, in the index of their version
      for (const doc of DOCUMENTS) {
        await client.index({
          index: doc.version === '5.0.0' ? 'op_ddo_v5.0.0' : 'op_ddo_v4.1.0',
          id: doc.id,
          document: doc,
          refresh: 'wait_for'
        })
      }
    })
    after(async () => {
      await store.deleteAllAssetsFromChain(CHAIN)
    })

    checkCases(() => store)
  }
)

describe('Query of the node: the request', () => {
  const invalid = (body: unknown) => {
    try {
      parseQueryRequest(body)
    } catch (error) {
      expect(error).to.be.instanceOf(QueryError)
      return error.message
    }
    throw new Error('no error')
  }

  it('fills the defaults: assets, page 1, size 1000, newest first', () => {
    expect(parseQueryRequest({})).to.deep.equal({
      type: 'assets',
      filter: {},
      page: 1,
      size: 1000
    })
    expect(sortOf(undefined)).to.deep.equal([
      { paths: ['indexedMetadata.event.block'], order: 'desc' }
    ])
  })

  it('refuses an Elasticsearch body, and names the new format', () => {
    expect(invalid({ query: { match_all: {} }, from: 1, size: 10 })).to.contain(
      '{ type, filter, sort, page, size }'
    )
    expect(invalid({ index: 'order' })).to.contain('Elasticsearch')
  })

  it('refuses an unknown filter, a wrong value and an unknown type', () => {
    expect(invalid({ filter: { color: 'red' } })).to.contain('color')
    expect(invalid({ filter: { types: ['movie'] } })).to.contain('filter.types')
    expect(invalid({ filter: { createdAfter: 'yesterday' } })).to.contain('ISO date')
    expect(invalid({ type: 'logs' })).to.contain('type')
  })

  it('refuses a page past the first 10000 documents', () => {
    expect(invalid({ page: 101, size: 100 })).to.contain('10000')
    expect(parseQueryRequest({ page: 100, size: 100 })).to.include({ page: 100 })
  })

  it('an orders query needs a consumer or a payer', () => {
    expect(invalid({ type: 'orders', filter: {} })).to.contain('filter')
    expect(parseQueryRequest({ type: 'orders', filter: { payer: '0x1' } })).to.deep.equal(
      {
        type: 'orders',
        filter: { payer: '0x1' },
        page: 1,
        size: 1000
      }
    )
  })

  it('maps each filter to its condition; unset filters add none', () => {
    expect(
      assetConditions({ includePurgatory: true, includeUnlisted: true, nftStates: [0] })
    ).to.deep.equal([{ paths: ['indexedMetadata.nft.state'], anyOf: [0] }])
    expect(assetConditions({})).to.deep.equal([
      { paths: ['indexedMetadata.nft.state'], noneOf: [5] },
      { paths: ['indexedMetadata.purgatory.state'], noneOf: [true] }
    ])
  })
})
