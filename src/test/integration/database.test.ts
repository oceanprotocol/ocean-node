import { DatabaseError } from '../../components/database/error.js'
import { Database } from '../../components/database/index.js'
import { expect } from 'chai'

describe('Database', () => {
  let database: Database

  before(async () => {
    const dbConfig = {
      url: 'http://localhost:8108/?apiKey=xyz'
    }
    database = await new Database(dbConfig)
  })

  it('instance Database', async () => {
    expect(database).to.be.instanceOf(Database)
  })
})

describe('DdoDatabase CRUD', () => {
  let database: Database
  const ddo = {
    hashType: 'sha256',
    '@context': ['https://w3id.org/did/v1'],
    id: 'did:op:fa0e8fa9550e8eb13392d6eeb9ba9f8111801b332c8d2345b350b3bc66b379d7',
    nftAddress: '0xBB1081DbF3227bbB233Db68f7117114baBb43656',
    version: '4.1.0',
    chainId: 137,
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

  it('create ddo', async () => {
    const result = await database.ddo.create(ddo)
    expect(result?.id).to.equal(ddo.id)
  })

  it('retrieve ddo', async () => {
    const result = await database.ddo.retrieve(ddo.id)
    expect(result?.id).to.equal(ddo.id)
  })

  it('update ddo', async () => {
    const newMetadataName = 'new metadata name'
    const result = await database.ddo.update({
      metadata: {
        name: newMetadataName
      }
    })
    expect(result?.metadata.name).to.equal(newMetadataName)
  })

  it('delete ddo', async () => {
    const result = await database.ddo.delete(ddo.id)
    expect(result?.id).to.equal(ddo.id)
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
    if (!(result instanceof DatabaseError)) {
      expect(result?.id).to.equal('0x123')
      expect(result?.nonce).to.equal(0)
    }
  })

  it('retrieve nonce', async () => {
    const result = await database.nonce.retrieve('0x123')
    if (!(result instanceof DatabaseError)) {
      expect(result?.id).to.equal('0x123')
      expect(result?.nonce).to.equal(0)
    }
  })

  it('update nonce', async () => {
    const result = await database.nonce.update('0x123', 1)
    if (!(result instanceof DatabaseError)) {
      expect(result?.id).to.equal('0x123')
      expect(result?.nonce).to.equal(1)
    }
  })

  it('delete nonce', async () => {
    const result = await database.nonce.delete('0x123')
    if (!(result instanceof DatabaseError)) {
      expect(result?.id).to.equal('0x123')
      expect(result?.nonce).to.equal(1)
    }
  })
})

describe('IndexerDatabase CRUD', () => {
  let database: Database

  before(async () => {
    const dbConfig = {
      url: 'http://localhost:8108/?apiKey=xyz'
    }
    database = await new Database(dbConfig)
  })

  it('create indexer', async () => {
    const result = await database.indexer.create(1, 0)
    expect(result?.id).to.equal('1')
    expect(result?.lastIndexedBlock).to.equal(0)
  })

  it('retrieve indexer', async () => {
    const result = await database.indexer.retrieve(1)
    expect(result?.id).to.equal('1')
    expect(result?.lastIndexedBlock).to.equal(0)
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
