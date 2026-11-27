import { expect } from 'chai'
import { SqliteClient } from '../../../components/database/sql/SqliteClient.js'

describe('SqliteClient', () => {
  let db: SqliteClient

  beforeEach(async () => {
    db = new SqliteClient(':memory:')
    await db.exec('CREATE TABLE items ("name" TEXT, "count" BIGINT)')
  })

  afterEach(async () => {
    await db.close()
  })

  const names = async () =>
    (await db.all<{ name: string }>('SELECT "name" FROM items')).map((row) => row.name)

  it('run returns the number of changed rows', async () => {
    await db.run('INSERT INTO items VALUES (?, ?)', ['a', 1])
    await db.run('INSERT INTO items VALUES (?, ?)', ['b', 1])
    const { changes } = await db.run(
      'UPDATE items SET "count" = ? WHERE "count" = ?',
      [2, 1]
    )
    expect(changes).to.equal(2)
  })

  it('get returns undefined when no row matches', async () => {
    expect(await db.get('SELECT * FROM items WHERE "name" = ?', ['none'])).to.equal(
      undefined
    )
  })

  it('binds undefined as null and booleans as 0 and 1', async () => {
    await db.run('INSERT INTO items VALUES (?, ?)', [undefined, true])
    expect(await db.get('SELECT * FROM items')).to.deep.equal({ name: null, count: 1 })
  })

  it('rejects a failed statement instead of throwing', async () => {
    let error: Error
    await db.run('INSERT INTO no_such_table VALUES (1)').catch((err) => {
      error = err
    })
    expect(error?.message).to.match(/no such table/)
  })

  it('transaction commits the work', async () => {
    await db.transaction(async (tx) => {
      await tx.run('INSERT INTO items VALUES (?, ?)', ['a', 1])
    })
    expect(await names()).to.deep.equal(['a'])
  })

  it('transaction rolls back when the work throws', async () => {
    let error: Error
    await db
      .transaction(async (tx) => {
        await tx.run('INSERT INTO items VALUES (?, ?)', ['a', 1])
        throw new Error('stop')
      })
      .catch((err) => {
        error = err
      })
    expect(error?.message).to.equal('stop')
    expect(await names()).to.deep.equal([])
  })

  it('two concurrent transactions do not interleave', async () => {
    const insertPair = (prefix: string) =>
      db.transaction(async (tx) => {
        await tx.run('INSERT INTO items VALUES (?, ?)', [`${prefix}1`, 1])
        // give the other transaction a chance to run between the two statements
        await new Promise((resolve) => setTimeout(resolve, 5))
        await tx.run('INSERT INTO items VALUES (?, ?)', [`${prefix}2`, 1])
      })
    await Promise.all([insertPair('a'), insertPair('b')])
    expect(await names()).to.deep.equal(['a1', 'a2', 'b1', 'b2'])
  })

  it('a statement outside a transaction waits for the transaction to end', async () => {
    const transaction = db.transaction(async (tx) => {
      await tx.run('INSERT INTO items VALUES (?, ?)', ['a', 1])
      await new Promise((resolve) => setTimeout(resolve, 5))
      throw new Error('stop')
    })
    const outside = db.run('INSERT INTO items VALUES (?, ?)', ['b', 1])
    await transaction.catch(() => {})
    await outside
    // "b" is not in the rolled back transaction
    expect(await names()).to.deep.equal(['b'])
  })
})
