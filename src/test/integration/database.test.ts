import { SearchQuery } from '../../@types/DDO/SearchQuery.js'
import { AbstractOrderDatabase } from '../../components/database/BaseDatabase.js'
import { DatabaseFactory } from '../../components/database/DatabaseFactory.js'
import { Database } from '../../components/database/index.js'
import { expect, assert } from 'chai'
import { OceanNodeDBConfig } from '../../@types/OceanNode.js'
import { isDefined } from '../../utils/util.js'
import { ElasticsearchNonceDatabase } from '../../components/database/ElasticSearchDatabase.js'
import { createElasticsearchClientWithRetry } from '../../components/database/ElasticsearchConfigHelper.js'
import { elasticSchemas } from '../../components/database/ElasticSchemas.js'

const elasticConfig: OceanNodeDBConfig = {
  url: 'http://localhost:9200',
  username: process.env.DB_USERNAME,
  password: process.env.DB_PASSWORD
}

describe('**********         Database', () => {
  let database: Database

  before(async () => {
    database = await Database.init(elasticConfig)
  })

  it('instance Database', () => {
    expect(database).to.be.instanceOf(Database)
  })
})

describe('**********         DdoDatabase CRUD', () => {
  let database: Database
  const ddoWithInvalidDid = {
    hashType: 'sha256',
    '@context': ['https://w3id.org/did/v1'],
    id: 'did:op:fa0e8fa9550e8eb13392d6eeb9ba9f8111801b332c8d2345b350b3bc66b379d7',
    nftAddress: '0xBB1081DbF3227bbB233Db68f7117114baBb43656',
    version: '4.1.0',
    chainId: 137,
    nft: { state: 0 },
    metadata: {
      created: '2022-12-30T08:40:06Z',
      updated: '2022-12-30T08:40:06Z',
      type: 'dataset',
      name: 'DEX volume in details',
      description:
        'Volume traded and locked of Decentralized Exchanges (Uniswap, Sushiswap, Curve, Balancer, ...), daily in details',
      tags: ['index', 'defi', 'tvl'],
      author: 'DEX',
      license: 'https://market.oceanprotocol.com/terms',
      additionalInformation: {
        termsAndConditions: true
      }
    }
  }

  before(async () => {
    database = await Database.init(elasticConfig)
  })

  it('creates ddo schema as an array', () => {
    const ddoSchemas = database.ddo.getSchemas()
    // check if it is an array
    assert(Array.isArray(ddoSchemas))
    assert(ddoSchemas.length > 1)
    for (const ddoSchema of ddoSchemas) {
      assert(database.ddo.isElasticsearchSchema(ddoSchema))
      assert(ddoSchema.index)
    }
  })

  it('Database will not create ddo when did is invalid', async () => {
    const result = await database.ddo.create(ddoWithInvalidDid)
    expect(isDefined(result?.id)).to.equal(false)
  })
})

describe('**********         NonceDatabase CRUD', () => {
  let database: Database

  before(async () => {
    database = await Database.init(elasticConfig)
  })

  beforeEach(async () => {
    const client = await createElasticsearchClientWithRetry(elasticConfig)
    // nonce writes do not refresh; make them visible to the deleteByQuery search
    await client.indices.refresh({ index: elasticSchemas.nonceSchemas.index })
    await client.deleteByQuery({
      index: elasticSchemas.nonceSchemas.index,
      query: { match_all: {} },
      refresh: true,
      conflicts: 'proceed'
    })
  })

  it('nonce DB is the Elasticsearch store', () => {
    expect(database.nonce).to.be.instanceOf(ElasticsearchNonceDatabase)
  })

  it('create nonce', async () => {
    const result = await database.nonce.create('0x123', 0)
    expect(result?.id).to.equal('0x123')
    expect(result?.nonce).to.equal(0)
  })

  it('retrieve nonce', async () => {
    expect(await database.nonce.retrieve('0x123')).to.deep.equal({
      id: '0x123',
      nonce: null
    })
    await database.nonce.create('0x123', 0)
    const result = await database.nonce.retrieve('0x123')
    expect(result?.id).to.equal('0x123')
    expect(result?.nonce).to.equal(0)
  })

  it('update nonce', async () => {
    await database.nonce.create('0x456', 0)
    const result = await database.nonce.update('0x456', 1)
    expect(result?.id).to.equal('0x456')
    expect(result?.nonce).to.equal(1)
    expect((await database.nonce.retrieve('0x456'))?.nonce).to.equal(1)
  })

  it('delete nonce', async () => {
    await database.nonce.create('0x456', 1)
    const result = await database.nonce.delete('0x456')
    expect(result?.id).to.equal('0x456')
    expect(result?.nonce).to.equal(1)
    expect((await database.nonce.retrieve('0x456'))?.nonce).to.equal(null)
    expect(await database.nonce.delete('0x456')).to.deep.equal({
      id: '0x456',
      nonce: null
    })
  })

  it('keys rows by the checksummed address and reads them back in any casing', async () => {
    // One address = one nonce row. If casing forked the key, a client alternating between
    // the lowercase and checksummed forms would carry two independent nonce counters.
    const checksummed = '0x7C8226E267Cd509bCBE12B4e69fbE07052422Dbd'
    const created = await database.nonce.create(checksummed.toLowerCase(), 7)
    expect(created?.id).to.equal(checksummed)
    expect((await database.nonce.retrieve(checksummed))?.nonce).to.equal(7)
    expect((await database.nonce.retrieve(checksummed.toLowerCase()))?.nonce).to.equal(7)
    const upper = '0x' + checksummed.slice(2).toUpperCase()
    expect((await database.nonce.retrieve(upper))?.nonce).to.equal(7)
    await database.nonce.delete(checksummed)
  })
})

describe('**********         IndexerDatabase CRUD', () => {
  let database: Database
  let existsPrevious: any = {}

  before(async () => {
    database = await Database.init(elasticConfig)
  })

  it('create indexer', async () => {
    // sometimes it exists already, locally at least, so check that first
    const exists = await database.indexer.retrieve(1)
    if (!exists) {
      const result = await database.indexer.create(1, 0)
      expect(result?.id).to.equal('1')
      expect(result?.lastIndexedBlock).to.equal(0)
    } else {
      existsPrevious = exists
      expect(existsPrevious?.lastIndexedBlock).to.be.a('number')
    }
  })

  // retrieve returns the stored document, which has no id field
  it('retrieve indexer', async () => {
    const result = await database.indexer.retrieve(1)
    if (existsPrevious?.lastIndexedBlock !== undefined) {
      expect(result?.lastIndexedBlock).to.equal(existsPrevious.lastIndexedBlock)
    } else {
      expect(result?.lastIndexedBlock).to.equal(0)
    }
  })

  it('update indexer', async () => {
    const result = await database.indexer.update(1, 1)
    expect(result?.id).to.equal('1')
    expect(result?.lastIndexedBlock).to.equal(1)
  })

  it('delete indexer', async () => {
    const result = await database.indexer.delete(1)
    expect(result).to.deep.equal({ id: '1' })
    expect(await database.indexer.retrieve(1)).to.equal(null)
  })
})

describe('**********         OrderDatabase CRUD', () => {
  let database: Database

  before(async () => {
    database = await Database.init(elasticConfig)
  })

  it('create order', async () => {
    const result = await database.order.create(
      'order1.0',
      'startOrder',
      1678593728,
      '0x1234',
      '0x4567',
      '0x1111',
      '0x1',
      'did'
    )
    expect(result?.orderId).to.equal('order1.0')
    expect(result?.consumer).to.equal('0x1234')
    expect(result?.payer).to.equal('0x4567')
    expect(result?.type).to.equal('startOrder')
    expect(result?.timestamp).to.equal(1678593728)
    expect(result?.datatokenAddress).to.equal('0x1111')
  })

  it('retrieve order', async () => {
    const result = await database.order.retrieve('order1.0')
    expect(result?.id).to.equal('order1.0')
    expect(result?.consumer).to.equal('0x1234')
    expect(result?.payer).to.equal('0x4567')
    expect(result?.type).to.equal('startOrder')
    expect(result?.timestamp).to.equal(1678593728)
  })

  it('update order', async () => {
    const result = await database.order.update(
      'order1.0',
      'startOrder',
      1678593730,
      '0x1235',
      '0x4567'
    )
    // update returns the changed fields only
    expect(result?.consumer).to.equal('0x1235')
    expect(result?.payer).to.equal('0x4567')
    expect(result?.type).to.equal('startOrder')
    expect(result?.timestamp).to.equal(1678593730)
  })

  it('delete order', async () => {
    const before = await database.order.retrieve('order1.0')
    expect(before?.consumer).to.equal('0x1235')
    expect(before?.timestamp).to.equal(1678593730)
    const result = await database.order.delete('order1.0')
    expect(result).to.deep.equal({ id: 'order1.0' })
    expect(await database.order.retrieve('order1.0')).to.equal(null)
  })
})

describe('**********         Elasticsearch OrderDatabase CRUD', () => {
  let database: AbstractOrderDatabase

  before(async () => {
    database = await DatabaseFactory.createOrderDatabase(elasticConfig)
  })

  it('creates an order in Elasticsearch', async () => {
    const result = await database.create(
      'orderElastic1',
      'startOrder',
      1678593728,
      '0x1234',
      '0x4567',
      '0x1111',
      '0x1',
      'did:'
    )
    expect(result?.orderId).to.equal('orderElastic1')
    expect(result?.consumer).to.equal('0x1234')
  })

  it('retrieves an order from Elasticsearch', async () => {
    const result = await database.retrieve('orderElastic1')
    expect(result?.orderId).to.equal('orderElastic1')
    expect(result?.consumer).to.equal('0x1234')
    expect(result?.payer).to.equal('0x4567')
    expect(result?.type).to.equal('startOrder')
  })

  it('updates an order in Elasticsearch', async () => {
    const result = await database.update(
      'orderElastic1',
      'startOrder',
      1678593730,
      '0x1235',
      '0x4567',
      '0x1111'
    )
    expect(result?.consumer).to.equal('0x1235')
  })

  it('deletes an order from Elasticsearch', async () => {
    const result = await database.delete('orderElastic1')
    expect(result?.id).to.equal('orderElastic1')
  })
})

describe('**********         DdoStateQuery', () => {
  it('should build Elasticsearch query for did', async () => {
    const query = (await DatabaseFactory.createDdoStateQuery(elasticConfig)).buildQuery(
      'did:op:abc123'
    )
    expect(query.term.did).to.equal('did:op:abc123')
  })

  it('should build Elasticsearch query for nft', async () => {
    const query = (await DatabaseFactory.createDdoStateQuery(elasticConfig)).buildQuery(
      undefined,
      'nft:op:abc123'
    )
    expect(query.term.nft).to.equal('nft:op:abc123')
  })

  it('should build Elasticsearch query for txId', async () => {
    const query = (await DatabaseFactory.createDdoStateQuery(elasticConfig)).buildQuery(
      undefined,
      undefined,
      'txId123'
    )
    expect(query.term.txId).to.equal('txId123')
  })
})

describe('**********         MetadataQuery', () => {
  it('should convert a filter_by query to an Elasticsearch query', async () => {
    const filterByQuery = {
      q: '*',
      filter_by:
        'author:=Ocean && metadata.type:=[dataset,algorithm] && purgatory_state:!=true',
      num_hits: 10,
      start: 0,
      sort_by: 'name:asc'
    }

    const query = (await DatabaseFactory.createMetadataQuery(elasticConfig)).buildQuery(
      filterByQuery
    )
    expect(query.size).to.equal(10)
    expect(query.from).to.equal(0)
    expect(query.query.bool.filter[0].term.author).to.equal('Ocean')
    expect(query.query.bool.filter[1].terms['metadata.type']).to.eql([
      'dataset',
      'algorithm'
    ])
    expect(query.query.bool.must_not[0].term.purgatory_state).to.equal('true')
    expect(query.sort[0].name.order).to.equal('asc')
  })

  it('should return an Elasticsearch query when DB is Elasticsearch and an Elasticsearch query is passed', async () => {
    const searchQuery: SearchQuery = {
      query: {
        bool: {
          filter: [
            { term: { author: 'Ocean' } },
            { terms: { 'metadata.type': ['dataset', 'algorithm'] } }
          ],
          must_not: [{ term: { purgatory_state: true } }]
        }
      },
      size: 10,
      from: 0,
      sort: { name: 'asc' }
    }

    const query = (await DatabaseFactory.createMetadataQuery(elasticConfig)).buildQuery(
      searchQuery
    )

    expect(query.size).to.equal(10)
    expect(query.from).to.equal(0)
    expect(query.query.bool.filter[0].term.author).to.equal('Ocean')
    expect(query.query.bool.filter[1].terms['metadata.type']).to.eql([
      'dataset',
      'algorithm'
    ])
    expect(query.query.bool.must_not[0].term.purgatory_state).to.equal(true)
    expect(query.sort.name).to.equal('asc')
  })
})
