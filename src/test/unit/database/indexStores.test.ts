import { expect } from 'chai'
import { createHash } from 'node:crypto'
import { getAddress } from 'ethers'
import type { EscrowEvent } from '../../../@types/Escrow.js'
import { UnsupportedQueryError } from '../../../components/database/BaseDatabase.js'
import type { SqlClient } from '../../../components/database/sql/SqlClient.js'
import { SQL_DB_CONFIG, makeSqlClient } from '../../utils/sqlClient.js'
import {
  SqlIndexStores,
  buildSqlIndexStores
} from '../../../components/database/sql/SqlStores.js'
import { DDOExample, ddov5 as ddov5Example } from '../../data/ddo.js'

// The contract of the index stores on a SQL database. Each test gets a new, empty database.
const CONTRACT = '0xAbC0000000000000000000000000000000000001'
const WALLET = '0xDeF0000000000000000000000000000000000002'
// The two example DDOs have the same id. A valid id is the hash of the NFT address and the
// chain, so the second DDO goes to another chain.
const V5_CHAIN = 8996
const ddov5 = {
  ...ddov5Example,
  chainId: V5_CHAIN,
  id:
    'did:op:' +
    createHash('sha256')
      .update(getAddress(ddov5Example.nftAddress) + V5_CHAIN)
      .digest('hex')
}

describe('SQL index stores', () => {
  let db: SqlClient
  let stores: SqlIndexStores

  beforeEach(async () => {
    db = await makeSqlClient()
    stores = await buildSqlIndexStores(SQL_DB_CONFIG, db)
  })
  afterEach(() => db.close())

  describe('indexer', () => {
    it('keeps the last indexed block of a chain', async () => {
      expect(await stores.indexer.retrieve(8996)).to.equal(null)
      expect(await stores.indexer.create(8996, 10)).to.deep.equal({
        id: '8996',
        lastIndexedBlock: 10
      })
      await stores.indexer.update(8996, 20)
      expect(await stores.indexer.retrieve(8996)).to.deep.equal({ lastIndexedBlock: 20 })
      await stores.indexer.update(137, 5)
      expect(await stores.indexer.retrieve(137)).to.deep.equal({ lastIndexedBlock: 5 })
    })

    it('deletes the entry of a chain; null when there is none', async () => {
      await stores.indexer.create(8996, 10)
      expect(await stores.indexer.delete(8996)).to.deep.equal({ id: '8996' })
      expect(await stores.indexer.delete(8996)).to.equal(null)
    })
  })

  describe('ddo state', () => {
    it('creates a state and finds it by did, nft and txId', async () => {
      const created = await stores.ddoState.create(
        8996,
        'did:op:1',
        '0xNft',
        '0xTx',
        true
      )
      expect(created).to.deep.equal({
        id: 'did:op:1',
        chainId: 8996,
        nft: '0xNft',
        txId: '0xTx',
        valid: true,
        error: ' '
      })
      expect((await stores.ddoState.retrieve('did:op:1')).did).to.equal('did:op:1')
      for (const query of [
        { term: { did: 'did:op:1' } },
        { term: { nft: '0xNft' } },
        { term: { txId: '0xTx' } }
      ]) {
        const found = await stores.ddoState.search(query)
        expect(found.map((state: any) => state.id)).to.deep.equal(['did:op:1'])
      }
      expect(await stores.ddoState.search({ term: { did: 'none' } })).to.deep.equal([])
    })

    it('an update replaces the state, and creates it when absent', async () => {
      await stores.ddoState.update(8996, 'did:op:1', '0xNft', '0xTx', false, 'bad ddo')
      const state = await stores.ddoState.retrieve('did:op:1')
      expect(state.valid).to.equal(false)
      expect(state.error).to.equal('bad ddo')
      expect(await stores.ddoState.delete('did:op:1')).to.deep.equal({ id: 'did:op:1' })
      expect(await stores.ddoState.retrieve('did:op:1')).to.equal(null)
    })

    it('throws for a query clause that SQL cannot run', async () => {
      let error: Error
      await stores.ddoState.search({ wildcard: { did: 'did*' } }).catch((err: Error) => {
        error = err
      })
      expect(error).to.be.instanceOf(UnsupportedQueryError)
    })
  })

  describe('order', () => {
    const create = (orderId: string, consumer: string, timestamp: number) =>
      stores.order.create(
        orderId,
        'startOrder',
        timestamp,
        consumer,
        '0xPayer',
        '0xDatatoken',
        '0xNft',
        'did:op:1'
      )

    it('creates an order and reads it back with its id', async () => {
      const order = await create('0xorder1', '0xConsumer', 100)
      expect(order.orderId).to.equal('0xorder1')
      expect(await stores.order.retrieve('0xorder1')).to.deep.equal({
        orderId: '0xorder1',
        type: 'startOrder',
        timestamp: 100,
        consumer: '0xConsumer',
        payer: '0xPayer',
        datatokenAddress: '0xDatatoken',
        nftAddress: '0xNft',
        did: 'did:op:1',
        id: '0xorder1'
      })
      expect(await stores.order.retrieve('none')).to.equal(null)
    })

    it('an update changes the given fields only', async () => {
      await create('0xorder1', '0xConsumer', 100)
      await stores.order.update('0xorder1', 'reuseOrder', 200, '0xConsumer', '0xPayer2')
      const order = await stores.order.retrieve('0xorder1')
      expect(order.type).to.equal('reuseOrder')
      expect(order.payer).to.equal('0xPayer2')
      expect(order.datatokenAddress).to.equal('0xDatatoken')
      expect(order.did).to.equal('did:op:1')
    })

    it('runs a node query, as the market sends it for the orders of a user', async () => {
      await create('0xorder1', '0xConsumer', 100)
      await create('0xorder2', '0xOther', 200)
      await create('0xorder3', '0xConsumer', 300)
      const orders = await stores.order.search({
        query: { bool: { filter: [{ term: { 'consumer.keyword': '0xConsumer' } }] } },
        sort: { timestamp: 'desc' },
        size: 1000
      })
      expect(orders.map((order) => order.orderId)).to.deep.equal(['0xorder3', '0xorder1'])
    })

    it('deletes an order; null when there is none', async () => {
      await create('0xorder1', '0xConsumer', 100)
      expect(await stores.order.delete('0xorder1')).to.deep.equal({ id: '0xorder1' })
      expect(await stores.order.delete('0xorder1')).to.equal(null)
    })
  })

  describe('escrow', () => {
    const event = (id: string, overrides: Partial<EscrowEvent> = {}): EscrowEvent => ({
      id,
      eventType: 'Lock',
      chainId: 8996,
      contract: '0xEscrow',
      block: 100,
      txHash: `0xtx-${id}`,
      payer: '0xPayer',
      amount: '1000000000000000000000',
      ...overrides
    })
    const search = async (filters: Record<string, any>, offset?: number, size?: number) =>
      (await stores.escrow.search(filters, offset, size)).map((e) => e.id).sort()

    beforeEach(async () => {
      await stores.escrow.create(event('a'))
      await stores.escrow.create(event('b', { block: 200, payer: '0xOther' }))
      await stores.escrow.create(event('c', { block: 1000, eventType: 'Claimed' }))
    })

    it('reads an event back, and deletes it', async () => {
      expect(await stores.escrow.retrieve('a')).to.deep.equal(event('a'))
      expect(await stores.escrow.delete('a')).to.deep.equal({ id: 'a' })
      expect(await stores.escrow.retrieve('a')).to.equal(null)
      expect(await stores.escrow.delete('a')).to.equal(null)
    })

    it('filters by equality, and by several values for one field', async () => {
      expect(await search({})).to.deep.equal(['a', 'b', 'c'])
      expect(await search({ payer: '0xPayer' })).to.deep.equal(['a', 'c'])
      expect(await search({ payer: '0xPayer', eventType: 'Claimed' })).to.deep.equal([
        'c'
      ])
      expect(await search({ payer: undefined, eventType: '' })).to.deep.equal([
        'a',
        'b',
        'c'
      ])
    })

    it('filters a block range as a number', async () => {
      // the bounds come as text; as text, '1000' is below '200'
      expect(await search({ block: { min: '150', max: '1000' } })).to.deep.equal([
        'b',
        'c'
      ])
      expect(await search({ block: { gt: '100', lt: '1000' } })).to.deep.equal(['b'])
      expect(await search({ chainId: [8996, { min: '1' }] })).to.deep.equal([
        'a',
        'b',
        'c'
      ])
    })

    it('gives one page of the result', async () => {
      expect(await search({}, 0, 2)).to.have.length(2)
      expect(await search({}, 2, 2)).to.have.length(1)
    })
  })

  describe('access list', () => {
    const user = (tokenId: number, wallet = WALLET) => ({
      wallet,
      tokenId,
      block: 10,
      txId: '0xtx'
    })

    it('creates a list and reads it back under the lower-case contract address', async () => {
      const created = await stores.accessList.create(
        8996,
        CONTRACT,
        true,
        5,
        '0xdeploy',
        'L'
      )
      expect(created).to.deep.equal({ id: `8996-${CONTRACT.toLowerCase()}` })
      expect(await stores.accessList.retrieve(8996, CONTRACT)).to.deep.equal({
        id: `8996-${CONTRACT.toLowerCase()}`,
        chainId: 8996,
        contractAddress: CONTRACT.toLowerCase(),
        users: [],
        transferable: true,
        deploymentBlock: 5,
        deploymentTxId: '0xdeploy',
        name: 'L'
      })
      expect(await stores.accessList.retrieve(8996, WALLET)).to.equal(null)
    })

    it('adds a token id one time, with the wallet in lower case', async () => {
      await stores.accessList.create(8996, CONTRACT, true, 5, '0xdeploy')
      await stores.accessList.addUser(8996, CONTRACT, user(1))
      await stores.accessList.addUser(8996, CONTRACT, user(1))
      await stores.accessList.addUser(8996, CONTRACT, user(2))
      const list = await stores.accessList.retrieve(8996, CONTRACT)
      expect(list.users).to.deep.equal([
        user(1, WALLET.toLowerCase()),
        user(2, WALLET.toLowerCase())
      ])
    })

    it('a user that comes before the deployment makes the list, and the deployment keeps the user', async () => {
      await stores.accessList.addUser(8996, CONTRACT, user(1))
      await stores.accessList.create(8996, CONTRACT, true, 5, '0xdeploy', 'L', 'S')
      const list = await stores.accessList.retrieve(8996, CONTRACT)
      expect(list.users).to.have.length(1)
      expect(list.transferable).to.equal(true)
      expect(list.symbol).to.equal('S')
    })

    it('keeps all the users that make a new list at the same time', async () => {
      const tokenIds = Array.from({ length: 20 }, (_, tokenId) => tokenId)
      await Promise.all(
        tokenIds.map((tokenId) =>
          stores.accessList.addUser(8996, CONTRACT, user(tokenId))
        )
      )
      const list = await stores.accessList.retrieve(8996, CONTRACT)
      expect(list.users).to.have.length(20)
    })

    it('removes a user by token id; null for a list that does not exist', async () => {
      await stores.accessList.addUser(8996, CONTRACT, user(1))
      await stores.accessList.addUser(8996, CONTRACT, user(2))
      await stores.accessList.removeUserByTokenId(8996, CONTRACT, 1)
      const list = await stores.accessList.retrieve(8996, CONTRACT)
      expect(list.users.map((u: any) => u.tokenId)).to.deep.equal([2])
      expect(await stores.accessList.removeUserByTokenId(137, CONTRACT, 1)).to.equal(null)
    })

    it('finds the lists of a wallet, on all chains or on one', async () => {
      await stores.accessList.addUser(8996, CONTRACT, user(1))
      await stores.accessList.addUser(137, CONTRACT, user(1))
      await stores.accessList.addUser(137, WALLET, user(1, CONTRACT))
      expect(await stores.accessList.searchByWallet(WALLET)).to.have.length(2)
      const onChain = await stores.accessList.searchByWallet(WALLET.toUpperCase(), 137)
      expect(onChain.map((list) => list.chainId)).to.deep.equal([137])
      expect(await stores.accessList.delete(137, CONTRACT)).to.deep.equal({
        id: `137-${CONTRACT.toLowerCase()}`
      })
      expect(await stores.accessList.searchByWallet(WALLET, 137)).to.deep.equal([])
    })
  })

  describe('logs', () => {
    const DAY_MS = 24 * 60 * 60 * 1000
    const everything = () => [new Date(0), new Date(Date.now() + DAY_MS)] as const

    it('stores a log and reads it back with an id and a timestamp', async () => {
      const inserted = await stores.logs.insertLog({
        level: 'info',
        message: 'hello',
        moduleName: 'HTTP'
      })
      const log = await stores.logs.retrieveLog(inserted.id)
      expect(log.message).to.equal('hello')
      expect(log.id).to.equal(inserted.id)
      expect(new Date(log.timestamp).getTime()).to.be.closeTo(Date.now(), 5000)
      expect(await stores.logs.retrieveLog('none')).to.equal(null)
    })

    it('lists the logs, newest first, by module and level, in pages', async () => {
      for (const [level, moduleName] of [
        ['info', 'HTTP'],
        ['error', 'HTTP'],
        ['info', 'P2P']
      ]) {
        await stores.logs.insertLog({
          level,
          moduleName,
          message: `${moduleName}-${level}`
        })
        await new Promise((resolve) => setTimeout(resolve, 2))
      }
      const messages = async (...args: [number, string?, string?, number?]) =>
        (await stores.logs.retrieveMultipleLogs(...everything(), ...args)).map(
          (log) => log.message
        )
      expect(await messages(10)).to.deep.equal(['P2P-info', 'HTTP-error', 'HTTP-info'])
      expect(await messages(2)).to.deep.equal(['P2P-info', 'HTTP-error'])
      expect(await messages(10, 'http')).to.deep.equal(['HTTP-error', 'HTTP-info'])
      expect(await messages(10, 'HTTP', 'error')).to.deep.equal(['HTTP-error'])
      expect(await messages(2, undefined, undefined, 1)).to.deep.equal(['HTTP-info'])
      expect(await stores.logs.getLogsCount()).to.equal(3)
    })

    it('deletes one log, and the logs that are older than the retention time', async () => {
      const first = await stores.logs.insertLog({ level: 'info', message: 'first' })
      await stores.logs.insertLog({ level: 'info', message: 'second' })
      await stores.logs.delete(first.id)
      expect(await stores.logs.getLogsCount()).to.equal(1)
      expect(await stores.logs.deleteOldLogs()).to.equal(0)
      await db.run('UPDATE logs SET "timestamp" = ?', ['2020-01-01T00:00:00.000Z'])
      expect(await stores.logs.deleteOldLogs()).to.equal(1)
      expect(await stores.logs.getLogsCount()).to.equal(0)
    })
  })

  describe('ddo', () => {
    const copy = (ddo: Record<string, any>) => structuredClone(ddo)
    const firstPage = async (query: Record<string, any>) =>
      ((await stores.ddo.search(query))[0] ?? []).map((ddo: any) => ddo.id)

    beforeEach(async () => {
      await stores.ddo.create(copy(DDOExample))
      await stores.ddo.create(copy(ddov5))
    })

    it('stores a valid DDO and reads it back', async () => {
      const ddo = await stores.ddo.retrieve(DDOExample.id)
      expect(ddo.id).to.equal(DDOExample.id)
      expect(ddo.metadata).to.deep.equal(DDOExample.metadata)
      expect(await stores.ddo.retrieve('did:op:none')).to.equal(null)
    })

    it('refuses a DDO that is not valid, and a DDO with an unknown version', async () => {
      const noMetadata = { ...copy(DDOExample), id: 'did:op:invalid', metadata: {} }
      expect(await stores.ddo.create(noMetadata)).to.equal(null)
      expect(await stores.ddo.retrieve('did:op:invalid')).to.equal(null)
      expect(() => stores.ddo.create({ id: 'did:op:x', version: '0.0.1' })).to.throw(
        'Unsupported DDO version: 0.0.1'
      )
    })

    it('gives the search result as one array of DDOs, or no array', async () => {
      const result = await stores.ddo.search({ query: { match_all: {} } })
      expect(result).to.have.length(1)
      expect(result[0]).to.have.length(2)
      expect(await stores.ddo.search({ query: { term: { chainId: 1 } } })).to.deep.equal(
        []
      )
    })

    it('`index` selects the DDOs of one schema', async () => {
      const all = { query: { match_all: {} } }
      expect(await firstPage({ ...all, index: 'op_ddo_v4.1.0' })).to.deep.equal([
        DDOExample.id
      ])
      expect(await firstPage({ ...all, index: 'op_ddo_v4.5.0' })).to.deep.equal([
        ddov5.id
      ])
      expect(await firstPage({ ...all, index: 'op_ddo_short' })).to.deep.equal([])
    })

    it('`from` is a page number that starts at 1', async () => {
      const page = (from?: number) =>
        firstPage({ query: { match_all: {} }, sort: { id: 'asc' }, size: 1, from })
      const sortedIds = [DDOExample.id, ddov5.id].sort()
      expect(await page()).to.deep.equal([sortedIds[0]])
      expect(await page(1)).to.deep.equal([sortedIds[0]])
      expect(await page(2)).to.deep.equal([sortedIds[1]])
    })

    it('accepts aggs, and refuses a part of the query that it does not know', async () => {
      const aggs = { tags: { terms: { field: 'metadata.tags.keyword' } } }
      expect(await firstPage({ query: { match_all: {} }, aggs })).to.have.length(2)
      let error: Error
      await stores.ddo.search({ q: '*' }).catch((err: Error) => {
        error = err
      })
      expect(error).to.be.instanceOf(UnsupportedQueryError)
      expect(error.message).to.contain("'q'")
    })

    it('an update replaces the DDO, and a state change moves it to the short schema', async () => {
      const deprecated = copy(DDOExample)
      deprecated.indexedMetadata = { ...deprecated.indexedMetadata }
      deprecated.indexedMetadata.nft = { ...deprecated.indexedMetadata?.nft, state: 5 }
      await stores.ddo.update(deprecated)
      const all = { query: { match_all: {} } }
      expect(await firstPage({ ...all, index: 'op_ddo_short' })).to.deep.equal([
        DDOExample.id
      ])
      expect(await firstPage({ ...all, index: 'op_ddo_v4.1.0' })).to.deep.equal([])
    })

    it('deletes one DDO, and all the DDOs of a chain', async () => {
      expect(await stores.ddo.delete(ddov5.id)).to.deep.equal({ id: ddov5.id })
      expect(await stores.ddo.delete(ddov5.id)).to.equal(undefined)
      expect(await stores.ddo.deleteAllAssetsFromChain(DDOExample.chainId)).to.equal(1)
      expect(await stores.ddo.search({ query: { match_all: {} } })).to.deep.equal([])
    })
  })
})
