import { ddo } from '../data/ddo.js'
import { expect } from 'chai'
import { Database } from '../../components/database/index.js'
import {
  ElasticsearchDdoDatabase,
  ElasticsearchDdoStateDatabase,
  ElasticsearchIndexerDatabase,
  ElasticsearchLogDatabase,
  ElasticsearchOrderDatabase
} from '../../components/database/ElasticSearchDatabase.js'
import { DB_TYPES } from '../../utils/index.js'
import { SQLLiteNonceDatabase } from '../../components/database/SQLLiteNonceDatabase.js'

const dbConfig = {
  url: 'http://localhost:9200',
  dbType: DB_TYPES.ELASTIC_SEARCH,
  username: 'elastic',
  password: 'changeme'
}
const elasticsearch: Database = await Database.init(dbConfig)

describe('Elastic Search', () => {
  it('Get instances of Elastic Search', () => {
    expect(elasticsearch.ddo).to.be.instanceOf(ElasticsearchDdoDatabase)
    expect(elasticsearch.indexer).to.be.instanceOf(ElasticsearchIndexerDatabase)
    expect(elasticsearch.ddoState).to.be.instanceOf(ElasticsearchDdoStateDatabase)
    expect(elasticsearch.order).to.be.instanceOf(ElasticsearchOrderDatabase)
    expect(elasticsearch.nonce).to.be.instanceOf(SQLLiteNonceDatabase)
    expect(elasticsearch.logs).to.be.instanceOf(ElasticsearchLogDatabase)
  })
})

describe('Elastic Search DDO collections', () => {
  it('create document in ddo collection', async () => {
    const result = await elasticsearch.ddo.create(ddo)
    expect(result.result).to.equal('created')
    expect(result._id).to.equal(ddo.id)
    // expect(result.metadata).to.not.be.an('undefined')
    // expect(result.metadata.name).to.be.equal(ddo.metadata.name)
  })

  it('retrieve document in ddo collection', async () => {
    const result = await elasticsearch.ddo.retrieve(ddo.id)
    expect(result.id).to.equal(ddo.id)
    expect(result.metadata).to.not.be.an('undefined')
    expect(result.metadata.name).to.be.equal(ddo.metadata.name)
  })

  it('update document in ddo collection', async () => {
    const newMetadataName = 'new metadata name'
    const updatedData = ddo
    updatedData.metadata.name = newMetadataName
    const result = await elasticsearch.ddo.update(updatedData)
    expect(result.result).to.equal('updated')
    expect(result._id).to.equal(updatedData.id)
  })

  it('delete document in ddo collection', async () => {
    const result = await elasticsearch.ddo.delete(ddo.id)
    expect(result.result).to.equal('deleted')
    expect(result._id).to.equal(ddo.id)
  })
})
