import { ddo } from '../data/ddo.js'
import { expect } from 'chai'
import { Database } from '../../components/database/index.js'
import { DB_TYPES } from '../../utils/constants.js'
import {
  ElasticsearchDdoDatabase,
  ElasticsearchDdoStateDatabase,
  ElasticsearchIndexerDatabase,
  ElasticsearchLogDatabase,
  ElasticsearchNonceDatabase,
  ElasticsearchOrderDatabase
} from '../../components/database/ElasticSearchDatabase.js'

const elasticsearch: Database = await new Database({
  url: 'http://localhost:9200',
  dbType: DB_TYPES.ELASTIC_SEARCH
})

describe('Elastic Search', () => {
  it('Get instances of Elastic Search', () => {
    expect(elasticsearch.ddo).to.be.instanceOf(ElasticsearchDdoDatabase)
    expect(elasticsearch.indexer).to.be.instanceOf(ElasticsearchIndexerDatabase)
    expect(elasticsearch.ddoState).to.be.instanceOf(ElasticsearchDdoStateDatabase)
    expect(elasticsearch.order).to.be.instanceOf(ElasticsearchOrderDatabase)
    expect(elasticsearch.nonce).to.be.instanceOf(ElasticsearchNonceDatabase)
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
    console.log('retrive result: ', result)
    expect(result.id).to.equal(ddo.id)
    expect(result.metadata).to.not.be.an('undefined')
    expect(result.metadata.name).to.be.equal(ddo.metadata.name)
  })

  it('update document in ddo collection', async () => {
    const newMetadataName = 'new metadata name'
    const updatedData = ddo
    updatedData.metadata.name = newMetadataName
    const result = await elasticsearch.ddo.update(updatedData)
    console.log('update result: ', result)
    expect(result.id).to.equal(ddo.id)
    expect(result.metadata).to.not.be.an('undefined')
    expect(result.metadata.name).to.be.equal(newMetadataName)
  })

  // it('search document in ddo collection', async () => {
  //   const result = await elasticsearch.ddo.search({
  //     q: 'DEX',
  //     query_by: 'metadata.name',
  //     filter_by: 'chainId:<138',
  //     sort_by: 'version:desc'
  //   })

  //   const searchQuery: SearchQuery = {
  //     query: {
  //       bool: {
  //         filter: [
  //           { term: { author: 'Ocean' } },
  //           { terms: { 'metadata.type': ['dataset', 'algorithm'] } }
  //         ],
  //         must_not: [{ term: { purgatory_state: true } }]
  //       }
  //     },
  //     size: 10,
  //     from: 0,
  //     sort: { name: 'asc' }
  //   }
  //   expect(result.found).to.equal(1)
  //   expect(result.hits[0]).to.not.be.an('undefined')
  //   expect(result.hits[0].document).to.not.be.an('undefined')
  // })

  it('delete document in ddo collection', async () => {
    const newMetadataName = 'new metadata name'
    const result = await elasticsearch.ddo.delete(ddo.id)
    expect(result.id).to.equal(ddo.id)
    expect(result.metadata).to.not.be.an('undefined')
    expect(result.metadata.name).to.be.equal(newMetadataName)
  })
})
