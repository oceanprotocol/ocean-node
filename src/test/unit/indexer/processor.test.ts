import { assert } from 'chai'
import { describe, it } from 'mocha'
import {
  MetadataEventProcessor,
  MetadataStateEventProcessor,
  OrderStartedEventProcessor,
  OrderReusedEventProcessor
} from '../../../components/Indexer/processor.js'
import {
  Database,
  DdoDatabase,
  IndexerDatabase,
  LogDatabase,
  NonceDatabase,
  OrderDatabase
} from '../../../components/database/index.js'
import { RPCS } from '../../../@types/blockchain.js'
import {
  Block,
  JsonRpcProvider,
  Log,
  OrphanFilter,
  TransactionReceipt,
  TransactionResponse
} from 'ethers'
import { EVENTS } from '../../../utils/constants.js'
import { stub } from 'sinon'
import { ddo } from '../../data/ddo.js'

class MockDatabase {
  ddo = {
    // eslint-disable-next-line no-undef
    retrieve: stub().resolves({
      '@context': ['https://w3id.org/did/v1'],
      id: 'did:op:12b17ee47536dc342f67a5fab2f014ddeb10be04018bc6bc53953655e2f7f8ff',
      version: '4.1.0',
      chainId: 8996,
      nftAddress: '0x181e8a7f8767808bea51F61044E27C5F8bf7C939',
      metadata: {
        created: '2021-12-20T14:35:20Z',
        updated: '2021-12-20T14:35:20Z',
        type: 'dataset',
        name: 'dataset-name',
        description: 'Ocean protocol test dataset description',
        author: 'oceanprotocol-team',
        license: 'MIT',
        tags: ['white-papers'],
        additionalInformation: { 'test-key': 'test-value' },
        links: ['http://data.ceda.ac.uk/badc/ukcp09/']
      },
      services: [
        {
          id: '0',
          type: 'access',
          description: 'Download service',
          files: [Array],
          datatokenAddress: '0x0',
          serviceEndpoint: 'http://172.15.0.4:8030',
          timeout: 0
        }
      ],
      credentials: { allow: [[Object]], deny: [[Object]] }
    }),
    search: stub(),
    update: stub().resolves({ id: 'didtest' }),
    create: stub(),
    delete: stub(),
    provider: stub(),
    schemas: stub(),
    config: stub()
  }

  order = {
    create: stub()
  }
}
let provider: JsonRpcProvider
let database: MockDatabase

describe('should test processor classes', () => {
  beforeEach(async () => {
    const dbConfig = {
      url: 'http://localhost:8108/?apiKey=xyz'
    }
    provider = new JsonRpcProvider('http://127.0.0.1:8545')
    database = new MockDatabase()
  })
  it('should process metadat created event', async () => {
    const processor = new MetadataEventProcessor(8996, database as any)
    const event: Log = {
      provider,
      transactionHash:
        '0x4fd20001e832156962586802bdc04cca87219e247581f42fbee1d0b9b949f033',
      blockHash: '0x79a82533981c38c743b94a9aa05d4215b565adf4bd6daa04b09b8af1934372fa',
      blockNumber: 1126,
      removed: false,
      address: '0x181e8a7f8767808bea51F61044E27C5F8bf7C939',
      data: '0x000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000e0000000000000000000000000000000000000000000000000000000000000014000000000000000000000000000000000000000000000000000000000000001800f2b0119d26de67e5a15abd91c15df34e93515bb0eb157b3cf0f7da48b3a632f0000000000000000000000000000000000000000000000000000000065aa63d900000000000000000000000000000000000000000000000000000000000004660000000000000000000000000000000000000000000000000000000000000024687474703a2f2f76342e70726f76696465722e6f6365616e70726f746f636f6c2e636f6d000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001020000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000003ed7b2240636f6e74657874223a5b2268747470733a2f2f773369642e6f72672f6469642f7631225d2c226964223a226469643a6f703a31326231376565343735333664633334326636376135666162326630313464646562313062653034303138626336626335333935333635356532663766386666222c2276657273696f6e223a22342e312e30222c22636861696e4964223a383939362c226e667441646472657373223a22307831383165386137663837363738303862656135314636313034344532374335463862663743393339222c226d65746164617461223a7b2263726561746564223a22323032312d31322d32305431343a33353a32305a222c2275706461746564223a22323032312d31322d32305431343a33353a32305a222c2274797065223a2264617461736574222c226e616d65223a22646174617365742d6e616d65222c226465736372697074696f6e223a224f6365616e2070726f746f636f6c20746573742064617461736574206465736372697074696f6e222c22617574686f72223a226f6365616e70726f746f636f6c2d7465616d222c226c6963656e7365223a224d4954222c2274616773223a5b2277686974652d706170657273225d2c226164646974696f6e616c496e666f726d6174696f6e223a7b22746573742d6b6579223a22746573742d76616c7565227d2c226c696e6b73223a5b22687474703a2f2f646174612e636564612e61632e756b2f626164632f756b637030392f225d7d2c227365727669636573223a5b7b226964223a2230222c2274797065223a22616363657373222c226465736372697074696f6e223a22446f776e6c6f61642073657276696365222c2266696c6573223a5b7b2275726c223a2268747470733a2f2f7261772e67697468756275736572636f6e74656e742e636f6d2f6f6365616e70726f746f636f6c2f746573742d616c676f726974686d2f6d61737465722f6a6176617363726970742f616c676f2e6a73222c22636f6e74656e7454797065223a22746578742f6a73222c22656e636f64696e67223a225554462d38227d5d2c2264617461746f6b656e41646472657373223a22307830222c2273657276696365456e64706f696e74223a22687474703a2f2f3137322e31352e302e343a38303330222c2274696d656f7574223a307d5d2c2263726564656e7469616c73223a7b22616c6c6f77223a5b7b2274797065223a2261646472657373222c2276616c756573223a5b22307842453534343961364139376144343663383535384133333536323637456535443237333161623565225d7d5d2c2264656e79223a5b7b2274797065223a2261646472657373222c2276616c756573223a5b223078313233225d7d5d7d7d00000000000000000000000000000000000000',
      topics: [
        '0x5463569dcc320958360074a9ab27e809e8a6942c394fb151d139b5f7b4ecb1bd',
        '0x000000000000000000000000e2dd09d719da89e5a3d0f2549c7e24566e947260'
      ],
      index: 0,
      transactionIndex: 0,
      toJSON: function () {
        throw new Error('Function not implemented.')
      },
      getBlock: function (): Promise<Block> {
        throw new Error('Function not implemented.')
      },
      getTransaction: function (): Promise<TransactionResponse> {
        throw new Error('Function not implemented.')
      },
      getTransactionReceipt: function (): Promise<TransactionReceipt> {
        throw new Error('Function not implemented.')
      },
      removedEvent: function (): OrphanFilter {
        throw new Error('Function not implemented.')
      }
    }

    const ddo = await processor.processEvent(
      event,
      8996,
      provider,
      EVENTS.METADATA_CREATED
    )
    assert(ddo, 'DDO not indexed')
  })

  it('should process metadata state event', async () => {
    const processor = new MetadataStateEventProcessor(8996, database as any)
    const event: Log = {
      provider,
      transactionHash:
        '0x469873c0e2edc59832e96b53d899358a21afd2fba02e229d19ea0106426c44c5',
      blockHash: '0xf62d51b3f9e7613620a9a81e9a9f568b4fad8d0c53869d9925166d5ac9f39749',
      blockNumber: 1128,
      removed: false,
      address: '0x181e8a7f8767808bea51F61044E27C5F8bf7C939',
      data: '0x00000000000000000000000000000000000000000000000000000000000000040000000000000000000000000000000000000000000000000000000065aa641d0000000000000000000000000000000000000000000000000000000000000468',
      topics: [
        '0xa8336411cc72db0e5bdc4dff989eeb35879bafaceffb59b54b37645c3395adb9',
        '0x000000000000000000000000e2dd09d719da89e5a3d0f2549c7e24566e947260'
      ],
      index: 0,
      transactionIndex: 0,
      toJSON: function () {
        throw new Error('Function not implemented.')
      },
      getBlock: function (): Promise<Block> {
        throw new Error('Function not implemented.')
      },
      getTransaction: function (): Promise<TransactionResponse> {
        throw new Error('Function not implemented.')
      },
      getTransactionReceipt: function (): Promise<TransactionReceipt> {
        throw new Error('Function not implemented.')
      },
      removedEvent: function (): OrphanFilter {
        throw new Error('Function not implemented.')
      }
    }
    const ddo = await processor.processEvent(event, 8996, provider)
    assert(ddo, 'DDO not indexed')
  })
  it('should process order started event', async () => {
    const processor = new OrderStartedEventProcessor(8996, database as any)
    const event: Log = {
      provider,
      transactionHash:
        '0xce2659a3877b0b9aeeb664c0f23d2a6c20a0f07e4e49f254e63fa3d1f13172af',
      blockHash: '0x9140a5c57fe612e7454759b58202208ef4ffdc5ddff2dc63164752859fa66da7',
      blockNumber: 1124,
      removed: false,
      address: '0x3cfE814D86e34d7af0B60f39C3B9463AaCB4910b',
      data: '0x000000000000000000000000be5449a6a97ad46c8558a3356267ee5d2731ab5e0000000000000000000000000000000000000000000000000de0b6b3a764000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000065aa5dfb0000000000000000000000000000000000000000000000000000000000000464',
      topics: [
        '0xe1c4fa794edfa8f619b8257a077398950357b9c6398528f94480307352f9afcc',
        '0x000000000000000000000000be5449a6a97ad46c8558a3356267ee5d2731ab5e',
        '0x0000000000000000000000000000000000000000000000000000000000000000'
      ],
      index: 0,
      transactionIndex: 0,
      toJSON: function () {
        throw new Error('Function not implemented.')
      },
      getBlock: function (): Promise<Block> {
        throw new Error('Function not implemented.')
      },
      getTransaction: function (): Promise<TransactionResponse> {
        throw new Error('Function not implemented.')
      },
      getTransactionReceipt: function (): Promise<TransactionReceipt> {
        throw new Error('Function not implemented.')
      },
      removedEvent: function (): OrphanFilter {
        throw new Error('Function not implemented.')
      }
    }
    const ddo = await processor.processEvent(event, 8996, provider)
    assert(ddo, 'DDO not indexed')
  })
})
