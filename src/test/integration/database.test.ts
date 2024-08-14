import { Database } from '../../components/database/index.js'
import { expect, assert } from 'chai'

describe('Database', () => {
  let database: Database

  before(async () => {
    const dbConfig = {
      url: 'http://localhost:8108/?apiKey=xyz'
    }
    database = await new Database(dbConfig)
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
    const dbConfig = {
      url: 'http://localhost:8108/?apiKey=xyz'
    }
    database = await new Database(dbConfig)
  })

  it('creates ddo schema as an array', () => {
    const ddoSchemas = database.ddo.getSchemas()
    // check if it is an array
    assert(Array.isArray(ddoSchemas))
    assert(ddoSchemas.length > 1)
    for (const ddoSchema of ddoSchemas) {
      assert(ddoSchema.name)
      assert(ddoSchema.fields)
      assert(ddoSchema.fields.length > 0)
    }
  })

  it('Database will not create ddo when did is invalid', async () => {
    const result = await database.ddo.create(ddoWithInvalidDid)
    expect(result?.id).to.equal(null || undefined)
  })
})

describe('NonceDatabase CRUD', () => {
  let database: Database

  before(async () => {
    const dbConfig = {
      url: 'http://localhost:8108/?apiKey=xyz'
    }
    database = await new Database(dbConfig)
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

describe('NonceDatabase CRUD with SQLite', () => {
  let database: Database

  before(async () => {
    const dbConfig = {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      url: ''
    }
    database = await new Database(dbConfig)
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
    console.log('Delete nonce result: ', result)
    expect(result?.id).to.equal('0x456')
    expect(result?.nonce).to.equal(1)
  })
})

describe('IndexerDatabase CRUD', () => {
  let database: Database
  let existsPrevious: any = {}

  before(async () => {
    const dbConfig = {
      url: 'http://localhost:8108/?apiKey=xyz'
    }
    database = await new Database(dbConfig)
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
})

describe('OrderDatabase CRUD', () => {
  let database: Database

  before(async () => {
    const dbConfig = {
      url: 'http://localhost:8108/?apiKey=xyz'
    }
    database = await new Database(dbConfig)
  })

  it('create order', async () => {
    const result = await database.order.create(
      'order1.0',
      'startOrder',
      1678593728,
      '0x1234',
      '0x4567'
    )
    expect(result?.id).to.equal('order1.0')
    expect(result?.consumer).to.equal('0x1234')
    expect(result?.payer).to.equal('0x4567')
    expect(result?.type).to.equal('startOrder')
    expect(result?.timestamp).to.equal(1678593728)
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
