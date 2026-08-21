import { expect } from 'chai'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { SqliteClient } from '../../components/database/sqliteClient.js'

describe('SqliteClient', () => {
  let tmpDir: string
  let client: SqliteClient

  before(() => {
    // Nested subdir on purpose: exercises the client's eager mkdir of the parent dir.
    tmpDir = path.join(
      os.tmpdir(),
      `ocean-node-sqliteclient-${process.pid}-${Date.now()}`,
      'nested'
    )
    client = new SqliteClient(path.join(tmpDir, 'test.sqlite'))
    client.exec(`
      CREATE TABLE IF NOT EXISTS kv (
        id TEXT PRIMARY KEY,
        n INTEGER,
        flag INTEGER,
        blob BLOB
      );
    `)
  })

  after(() => {
    // best-effort cleanup of the temp DB dir (incl. any -wal/-shm siblings)
    fs.rmSync(path.dirname(tmpDir), { recursive: true, force: true })
  })

  it('creates the parent directory eagerly', () => {
    expect(fs.existsSync(tmpDir)).to.equal(true)
  })

  it('run() reports changes: 1 on a hit, 0 on a miss', () => {
    const inserted = client.run('INSERT INTO kv (id, n) VALUES (?, ?)', ['a', 1])
    expect(inserted.changes).to.equal(1)
    expect(inserted.changes).to.be.a('number')

    const hit = client.run('UPDATE kv SET n = ? WHERE id = ?', [2, 'a'])
    expect(hit.changes).to.equal(1)

    const miss = client.run('UPDATE kv SET n = ? WHERE id = ?', [9, 'does-not-exist'])
    expect(miss.changes).to.equal(0)
  })

  it('get() returns undefined when no row matches', () => {
    const row = client.get('SELECT * FROM kv WHERE id = ?', ['missing'])
    expect(row).to.equal(undefined)
  })

  it('all() always returns an array', () => {
    const rows = client.all('SELECT * FROM kv WHERE id = ?', ['still-missing'])
    expect(rows).to.be.an('array').with.lengthOf(0)
  })

  it('sanitizes undefined -> NULL and boolean -> 1/0 bindings', () => {
    // undefined would otherwise throw ERR_INVALID_ARG_TYPE in node:sqlite
    client.run('INSERT INTO kv (id, n, flag) VALUES (?, ?, ?)', [
      'sanitize',
      undefined,
      true
    ])
    const row = client.get<{ n: number | null; flag: number }>(
      'SELECT n, flag FROM kv WHERE id = ?',
      ['sanitize']
    )
    expect(row?.n).to.equal(null)
    expect(row?.flag).to.equal(1)

    client.run('INSERT INTO kv (id, flag) VALUES (?, ?)', ['sanitize-false', false])
    const row2 = client.get<{ flag: number }>('SELECT flag FROM kv WHERE id = ?', [
      'sanitize-false'
    ])
    expect(row2?.flag).to.equal(0)
  })

  it('round-trips a BLOB written as Buffer (comes back as Uint8Array)', () => {
    const original = JSON.stringify({ hello: 'world', n: 123 })
    client.run('INSERT INTO kv (id, blob) VALUES (?, ?)', ['blob', Buffer.from(original)])
    const row = client.get<{ blob: Uint8Array }>('SELECT blob FROM kv WHERE id = ?', [
      'blob'
    ])
    expect(row?.blob).to.be.an.instanceOf(Uint8Array)
    // This is exactly the decode the compute provider must do: Buffer.from(blob).toString()
    expect(Buffer.from(row!.blob).toString()).to.equal(original)
    expect(JSON.parse(Buffer.from(row!.blob).toString())).to.deep.equal({
      hello: 'world',
      n: 123
    })
  })

  it('supports INSERT ... ON CONFLICT upsert (nonce/config pattern)', () => {
    const sql = `
      INSERT INTO kv (id, n) VALUES (?, ?)
      ON CONFLICT(id) DO UPDATE SET n = excluded.n;
    `
    client.run(sql, ['upsert', 10])
    expect(
      client.get<{ n: number }>('SELECT n FROM kv WHERE id = ?', ['upsert'])?.n
    ).to.equal(10)
    client.run(sql, ['upsert', 20])
    expect(
      client.get<{ n: number }>('SELECT n FROM kv WHERE id = ?', ['upsert'])?.n
    ).to.equal(20)
  })
})
