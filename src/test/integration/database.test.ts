import { SearchQuery } from '../../@types/DDO/SearchQuery.js'
import { AbstractOrderDatabase } from '../../components/database/BaseDatabase.js'
import { DatabaseFactory } from '../../components/database/DatabaseFactory.js'
import { Database } from '../../components/database/index.js'
import { expect, assert } from 'chai'
import { DB_TYPES } from '../../utils/constants.js'
import { OceanNodeDBConfig } from '../../@types/OceanNode.js'
import { isDefined } from '../../utils/util.js'
import { SQLLiteNonceDatabase } from '../../components/database/SQLLiteNonceDatabase.js'

const typesenseConfig: OceanNodeDBConfig = {
  url: 'http://localhost:8108/?apiKey=xyz',
  dbType: DB_TYPES.TYPESENSE
}

const elasticConfig: OceanNodeDBConfig = {
  url: 'http://localhost:9200',
  dbType: DB_TYPES.ELASTIC_SEARCH
}

const emptyDBConfig: OceanNodeDBConfig = {
  url: '',
  dbType: null
}

describe('Database', () => {
  let database: Database

  before(async () => {
    database = await new Database(typesenseConfig)
  })

  it('instance Database', () => {
    expect(database).to.be.instanceOf(Database)
  })
})

describe('DdoDatabase CRUD', () => {
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
    database = await new Database(typesenseConfig)
  })

  it('creates ddo schema as an array', () => {
    const ddoSchemas = database.ddo.getSchemas()
    // check if it is an array
    assert(Array.isArray(ddoSchemas))
    assert(ddoSchemas.length > 1)
    for (const ddoSchema of ddoSchemas) {
      if (database.ddo.isTypesenseSchema(ddoSchema)) {
        assert(ddoSchema.name)
        assert(ddoSchema.fields)
        assert(ddoSchema.fields.length > 0)
      }
    }
  })

  it('Database will not create ddo when did is invalid', async () => {
    const result = await database.ddo.create(ddoWithInvalidDid)
    expect(isDefined(result?.id)).to.equal(false)
  })
})

describe('NonceDatabase CRUD - SQL lite (With typesense DB config)', () => {
  let database: Database

  before(async () => {
    database = await new Database(typesenseConfig)
  })

  it('check nonce DB instance of SQL Lite', () => {
    expect(database.nonce).to.be.instanceOf(SQLLiteNonceDatabase)
  })

  it('create nonce', async () => {
    const result = await database.nonce.create('0x123', 0)
    expect(result?.id).to.equal('0x123')
    expect(result?.nonce).to.equal(0)
  })

  it('retrieve nonce', async () => {
    const result = await database.nonce.retrieve('0x123')
    expect(result?.id).to.equal('0x123')
    expect(result?.nonce).to.equal(0)
  })

  it('update nonce', async () => {
    const result = await database.nonce.update('0x123', 1)
    expect(result?.id).to.equal('0x123')
    expect(result?.nonce).to.equal(1)
  })

  it('delete nonce', async () => {
    const result = await database.nonce.delete('0x123')
    expect(result?.id).to.equal('0x123')
    expect(result?.nonce).to.equal(1)
  })
})

describe('NonceDatabase CRUD (without Elastic or Typesense config)', () => {
  let database: Database

  before(async () => {
    database = await new Database(emptyDBConfig)
  })

  it('check nonce DB instance of SQL Lite', () => {
    expect(database.nonce).to.be.instanceOf(SQLLiteNonceDatabase)
  })

  it('create nonce', async () => {
    const result = await database.nonce.create('0x456', 0)
    expect(result?.id).to.equal('0x456')
    expect(result?.nonce).to.equal(0)
  })

  it('retrieve nonce', async () => {
    const result = await database.nonce.retrieve('0x456')
    expect(result?.id).to.equal('0x456')
    expect(result?.nonce).to.equal(0)
  })

  it('update nonce', async () => {
    const result = await database.nonce.update('0x456', 1)
    expect(result?.id).to.equal('0x456')
    expect(result?.nonce).to.equal(1)
  })

  it('delete nonce', async () => {
    const result = await database.nonce.delete('0x456')
    expect(result?.id).to.equal('0x456')
    expect(result?.nonce).to.equal(1)
  })
})

describe('IndexerDatabase CRUD', () => {
  let database: Database
  let existsPrevious: any = {}

  before(async () => {
    database = await new Database(typesenseConfig)
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
      expect(existsPrevious?.id).to.equal('1')
    }
  })

  it('retrieve indexer', async () => {
    const result = await database.indexer.retrieve(1)
    expect(result?.id).to.equal('1')
    if (existsPrevious?.id) {
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
    expect(result?.id).to.equal('1')
    expect(result?.lastIndexedBlock).to.equal(1)
  })

  describe('Node Version Management', () => {
    it('should have null version initially', async () => {
      const result = await database.indexer.getNodeVersion()
      assert(result === null)
    })

    it('sets and retrieves node version', async () => {
      const testVersion = '0.2.2'

      // Create a document first to ensure the collection exists
      await database.indexer.create(999, 0)

      // Now set the version
      await database.indexer.setNodeVersion(testVersion)
      const result = await database.indexer.getNodeVersion()
      assert(result === testVersion)

      // Clean up
      await database.indexer.delete(999)
    })

    it('updates node version', async () => {
      const initialVersion = '0.2.3'
      const updatedVersion = '0.2.4'

      await database.indexer.setNodeVersion(initialVersion)
      let result = await database.indexer.getNodeVersion()
      assert(result === initialVersion)

      await database.indexer.setNodeVersion(updatedVersion)
      result = await database.indexer.getNodeVersion()
      assert(result === updatedVersion)
    })
  })
})

describe('OrderDatabase CRUD', () => {
  let database: Database

  before(async () => {
    database = await new Database(typesenseConfig)
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
    expect(result?.id).to.equal('order1.0')
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
    expect(result?.id).to.equal('order1.0')
    expect(result?.consumer).to.equal('0x1235')
    expect(result?.payer).to.equal('0x4567')
    expect(result?.type).to.equal('startOrder')
    expect(result?.timestamp).to.equal(1678593730)
  })

  it('delete order', async () => {
    const result = await database.order.delete('order1.0')
    expect(result?.id).to.equal('order1.0')
    expect(result?.consumer).to.equal('0x1235')
    expect(result?.payer).to.equal('0x4567')
    expect(result?.type).to.equal('startOrder')
    expect(result?.timestamp).to.equal(1678593730)
  })
})

describe('Typesense OrderDatabase CRUD', () => {
  let database: AbstractOrderDatabase

  before(async () => {
    database = await DatabaseFactory.createOrderDatabase(typesenseConfig)
  })

  it('creates an order in Typesense', async () => {
    const result = await database.create(
      'orderTypesense1',
      'startOrder',
      1678593728,
      '0x1234',
      '0x4567',
      '0x1111',
      '0x2',
      'did:'
    )
    expect(result?.id).to.equal('orderTypesense1')
    expect(result?.consumer).to.equal('0x1234')
  })

  it('retrieves an order from Typesense', async () => {
    const result = await database.retrieve('orderTypesense1')
    expect(result?.id).to.equal('orderTypesense1')
    expect(result?.consumer).to.equal('0x1234')
  })

  it('updates an order in Typesense', async () => {
    const result = await database.update(
      'orderTypesense1',
      'startOrder',
      1678593730,
      '0x1235',
      '0x4567'
    )
    expect(result?.consumer).to.equal('0x1235')
  })

  it('deletes an order from Typesense', async () => {
    const result = await database.delete('orderTypesense1')
    expect(result?.id).to.equal('orderTypesense1')
  })
})

describe('Elasticsearch OrderDatabase CRUD', () => {
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

describe('DdoStateQuery', () => {
  it('should build Typesense query for did', async () => {
    const query = (await DatabaseFactory.createDdoStateQuery(typesenseConfig)).buildQuery(
      'did:op:abc123'
    )
    expect(query.q).to.equal('did:op:abc123')
    expect(query.query_by).to.equal('did')
  })

  it('should build Typesense query for nft', async () => {
    const query = (await DatabaseFactory.createDdoStateQuery(typesenseConfig)).buildQuery(
      undefined,
      'nft:op:abc123'
    )
    expect(query.q).to.equal('nft:op:abc123')
    expect(query.query_by).to.equal('nft')
  })

  it('should build Typesense query for txId', async () => {
    const query = (await DatabaseFactory.createDdoStateQuery(typesenseConfig)).buildQuery(
      undefined,
      undefined,
      'txId123'
    )
    expect(query.q).to.equal('txId123')
    expect(query.query_by).to.equal('txId')
  })

  it('should build Elasticsearch query for did', async () => {
    const query = (await DatabaseFactory.createDdoStateQuery(elasticConfig)).buildQuery(
      'did:op:abc123'
    )
    expect(query.match.did).to.equal('did:op:abc123')
  })

  it('should build Elasticsearch query for nft', async () => {
    const query = (await DatabaseFactory.createDdoStateQuery(elasticConfig)).buildQuery(
      undefined,
      'nft:op:abc123'
    )
    expect(query.match.nft).to.equal('nft:op:abc123')
  })

  it('should build Elasticsearch query for txId', async () => {
    const query = (await DatabaseFactory.createDdoStateQuery(elasticConfig)).buildQuery(
      undefined,
      undefined,
      'txId123'
    )
    expect(query.match.txId).to.equal('txId123')
  })
})

describe('MetadataQuery', () => {
  it('should return a Typesense query when DB is Typesense and a Typesense query is passed', async () => {
    const typesenseQuery = {
      q: '*',
      filter_by:
        'author:=Ocean && metadata.type:=[dataset,algorithm] && purgatory_state:!=true',
      num_hits: 10,
      start: 0,
      sort_by: 'name:asc'
    }

    const query = (await DatabaseFactory.createMetadataQuery(typesenseConfig)).buildQuery(
      typesenseQuery
    )
    expect(query.q).to.equal('*')
    expect(query.num_hits).to.equal(10)
    expect(query.start).to.equal(0)
    expect(query.filter_by).to.equal(
      'author:=Ocean && metadata.type:=[dataset,algorithm] && purgatory_state:!=true'
    )
    expect(query.sort_by).to.equal('name:asc')
  })

  it('should convert an Elasticsearch query to a Typesense query when DB is Typesense', async () => {
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

    const query = (await DatabaseFactory.createMetadataQuery(typesenseConfig)).buildQuery(
      searchQuery
    )
    expect(query.q).to.equal('*')
    expect(query.num_hits).to.equal(10)
    expect(query.start).to.equal(0)
    expect(query.filter_by).to.contain('author:=Ocean')
    expect(query.filter_by).to.contain('metadata.type:=[dataset,algorithm]')
    expect(query.filter_by).to.contain('purgatory_state:!=true')
    expect(query.sort_by).to.equal('name:asc')
  })

  it('should convert a Typesense query to an Elasticsearch query when DB is Elasticsearch', async () => {
    const typesenseQuery = {
      q: '*',
      filter_by:
        'author:=Ocean && metadata.type:=[dataset,algorithm] && purgatory_state:!=true',
      num_hits: 10,
      start: 0,
      sort_by: 'name:asc'
    }

    const query = (await DatabaseFactory.createMetadataQuery(elasticConfig)).buildQuery(
      typesenseQuery
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
