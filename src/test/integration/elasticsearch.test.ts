import { describeOnElasticsearch } from '../utils/utils.js'
import { ddo } from '../data/ddo.js'
import { expect } from 'chai'
import { Database } from '../../components/database/index.js'
import type { OceanNodeDBConfig } from '../../@types/OceanNode.js'
import {
  ElasticsearchDdoDatabase,
  ElasticsearchDdoStateDatabase,
  ElasticsearchIndexerDatabase,
  ElasticsearchLogDatabase,
  ElasticsearchNonceDatabase,
  ElasticsearchOrderDatabase
} from '../../components/database/ElasticSearchDatabase.js'

const dbConfig: OceanNodeDBConfig = {
  dbType: 'elasticsearch',
  url: 'http://localhost:9200',
  username: 'elastic',
  password: 'changeme'
}
let elasticsearch: Database
// the suites of this file share one connection; it is made when the first suite runs
const connect = async () => {
  elasticsearch ??= await Database.init(dbConfig)
}

describeOnElasticsearch('**********         Elastic Search', () => {
  before(connect)

  it('Get instances of Elastic Search', () => {
    expect(elasticsearch.ddo).to.be.instanceOf(ElasticsearchDdoDatabase)
    expect(elasticsearch.indexer).to.be.instanceOf(ElasticsearchIndexerDatabase)
    expect(elasticsearch.ddoState).to.be.instanceOf(ElasticsearchDdoStateDatabase)
    expect(elasticsearch.order).to.be.instanceOf(ElasticsearchOrderDatabase)
    expect(elasticsearch.nonce).to.be.instanceOf(ElasticsearchNonceDatabase)
    expect(elasticsearch.logs).to.be.instanceOf(ElasticsearchLogDatabase)
  })
})

describeOnElasticsearch('**********         Elastic Search DDO collections', () => {
  before(connect)

  it('create document in ddo collection', async () => {
    const result = await elasticsearch.ddo.create(ddo)
    expect(result.id).to.equal(ddo.id)
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
    expect(result.id).to.equal(updatedData.id)
    expect(result.metadata.name).to.equal(newMetadataName)
  })

  it('delete document in ddo collection', async () => {
    expect(await elasticsearch.ddo.delete(ddo.id)).to.deep.equal({ id: ddo.id })
  })
})
