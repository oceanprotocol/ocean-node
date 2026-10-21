import { expect } from 'chai'
import sinon from 'sinon'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { Readable } from 'stream'
import { GetLogsHandler } from '../../components/core/admin/getLogsHandler.js'
import { AdminGetLogsCommand } from '../../@types/commands.js'
import { OceanNode } from '../../OceanNode.js'
import { PROTOCOL_COMMANDS } from '../../utils/constants.js'
import { streamToObject, streamToString } from '../../utils/util.js'

const FILE_LOGS = [
  { level: 'info', message: 'CORE:\tfirst', ts: '2026-02-01T10:00:00.000Z' },
  { level: 'error', message: 'CORE:\tsecond', ts: '2026-02-01T11:00:00.000Z' }
]

const DB_LOG = {
  id: 'db-1',
  level: 'info',
  message: 'from the db',
  moduleName: 'CORE',
  timestamp: Date.parse('2026-02-01T09:00:00.000Z')
}

function fakeNode(getDatabase: () => Promise<any>): OceanNode {
  return { getDatabase } as unknown as OceanNode
}

function fakeLogsDb(logs: Record<string, any>[]) {
  return {
    retrieveMultipleLogs: sinon.stub().resolves(logs),
    retrieveLog: sinon
      .stub()
      .callsFake((id: string) => Promise.resolve(id === DB_LOG.id ? DB_LOG : null))
  }
}

function command(fields: Partial<AdminGetLogsCommand> = {}): AdminGetLogsCommand {
  return {
    command: PROTOCOL_COMMANDS.GET_LOGS,
    signature: '0xsig',
    nonce: '1',
    address: '0x0000000000000000000000000000000000000001',
    startTime: '2026-02-01T00:00:00.000Z',
    endTime: '2026-02-01T23:59:59.999Z',
    ...fields
  } as AdminGetLogsCommand
}

describe('GetLogsHandler', () => {
  let dir: string
  const savedEnv = {
    LOG_DB: process.env.LOG_DB,
    LOG_FILES_DIR: process.env.LOG_FILES_DIR
  }

  function restoreEnv(name: keyof typeof savedEnv): void {
    if (savedEnv[name] === undefined) delete process.env[name]
    else process.env[name] = savedEnv[name]
  }

  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocean-logs-handler-'))
    fs.writeFileSync(
      path.join(dir, 'core-2026-02-01.log'),
      FILE_LOGS.map((l) =>
        JSON.stringify({
          component: 'CORE',
          level: l.level,
          message: l.message,
          moduleName: 'CORE',
          timestamp: l.ts
        })
      ).join('\n') + '\n'
    )
  })

  beforeEach(() => {
    sinon.stub(GetLogsHandler.prototype, 'validate').resolves({ valid: true })
    process.env.LOG_FILES_DIR = dir
    delete process.env.LOG_DB
  })

  afterEach(() => {
    sinon.restore()
    restoreEnv('LOG_DB')
    restoreEnv('LOG_FILES_DIR')
  })

  after(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  async function run(node: OceanNode, task: AdminGetLogsCommand) {
    const response = await new GetLogsHandler(node).handle(task)
    const body =
      response.status.httpStatus === 200
        ? await streamToObject(response.stream as Readable)
        : null
    return { response, body }
  }

  function expectFileLogs(body: any[]): void {
    expect(body.map((r) => r.message)).to.deep.equal(['CORE:\tsecond', 'CORE:\tfirst'])
    expect(body[0]).to.deep.equal({
      level: 'error',
      message: 'CORE:\tsecond',
      moduleName: 'CORE',
      timestamp: Date.parse('2026-02-01T11:00:00.000Z')
    })
  }

  it('reads log files when there is no database', async () => {
    const { response, body } = await run(
      fakeNode(() => Promise.resolve(null)),
      command()
    )
    expect(response.status.httpStatus).to.equal(200)
    expectFileLogs(body)
  })

  it('reads log files when the database has no log store', async () => {
    process.env.LOG_DB = 'true'
    const { response, body } = await run(
      fakeNode(() => Promise.resolve({})),
      command()
    )
    expect(response.status.httpStatus).to.equal(200)
    expectFileLogs(body)
  })

  it('reads log files when the database failed to initialize', async () => {
    const { response, body } = await run(
      fakeNode(() => Promise.reject(new Error('init failed'))),
      command()
    )
    expect(response.status.httpStatus).to.equal(200)
    expectFileLogs(body)
  })

  it('serves the database when LOG_DB is on', async () => {
    process.env.LOG_DB = 'true'
    const logs = fakeLogsDb([DB_LOG])
    const { response, body } = await run(
      fakeNode(() => Promise.resolve({ logs })),
      command({ maxLogs: 5000, moduleName: 'core', level: 'info', page: 1 })
    )
    expect(response.status.httpStatus).to.equal(200)
    expect(body).to.deep.equal([DB_LOG])
    const [start, end, maxLogs, moduleName, level, page] =
      logs.retrieveMultipleLogs.firstCall.args
    expect(start).to.be.instanceOf(Date)
    expect(start.toISOString()).to.equal('2026-02-01T00:00:00.000Z')
    expect(end.toISOString()).to.equal('2026-02-01T23:59:59.999Z')
    expect(maxLogs).to.equal(1000)
    expect([moduleName, level, page]).to.deep.equal(['core', 'info', 1])
  })

  it('ignores stale database logs when LOG_DB is off', async () => {
    const logs = fakeLogsDb([DB_LOG])
    const { body } = await run(
      fakeNode(() => Promise.resolve({ logs })),
      command()
    )
    expect(logs.retrieveMultipleLogs.called).to.equal(false)
    expectFileLogs(body)
  })

  it('falls back to log files when the database returns nothing', async () => {
    process.env.LOG_DB = 'true'
    const logs = fakeLogsDb([])
    const { body } = await run(
      fakeNode(() => Promise.resolve({ logs })),
      command()
    )
    expect(logs.retrieveMultipleLogs.calledOnce).to.equal(true)
    expectFileLogs(body)
  })

  it('returns [] past the last database page instead of reading files', async () => {
    process.env.LOG_DB = 'true'
    const logs = fakeLogsDb([])
    const { body } = await run(
      fakeNode(() => Promise.resolve({ logs })),
      command({ page: 2 })
    )
    expect(body).to.deep.equal([])
  })

  it('falls back to log files when the database query fails', async () => {
    process.env.LOG_DB = 'true'
    const logs = fakeLogsDb([])
    logs.retrieveMultipleLogs.rejects(new Error('db down'))
    const { response, body } = await run(
      fakeNode(() => Promise.resolve({ logs })),
      command()
    )
    expect(response.status.httpStatus).to.equal(200)
    expectFileLogs(body)
  })

  it('accepts epoch-ms strings for startTime and endTime', async () => {
    const { body } = await run(
      fakeNode(() => Promise.resolve(null)),
      command({
        startTime: String(Date.parse('2026-02-01T10:30:00.000Z')),
        endTime: String(Date.parse('2026-02-01T12:00:00.000Z'))
      })
    )
    expect(body.map((r: any) => r.message)).to.deep.equal(['CORE:\tsecond'])
  })

  it('rejects an invalid startTime or endTime with 400', async () => {
    const node = fakeNode(() => Promise.resolve(null))
    const start = await run(node, command({ startTime: 'yesterday-ish' }))
    expect(start.response.status.httpStatus).to.equal(400)
    expect(start.response.status.error).to.contain('startTime')
    const end = await run(node, command({ endTime: 'not a date' }))
    expect(end.response.status.httpStatus).to.equal(400)
    expect(end.response.status.error).to.contain('endTime')
  })

  it('rejects a non-string moduleName or level with 400', async () => {
    const node = fakeNode(() => Promise.resolve(null))
    const mod = await run(node, command({ moduleName: 123 as any }))
    expect(mod.response.status.httpStatus).to.equal(400)
    expect(mod.response.status.error).to.contain('moduleName')
    const lvl = await run(node, command({ level: {} as any }))
    expect(lvl.response.status.httpStatus).to.equal(400)
    expect(lvl.response.status.error).to.contain('level')
  })

  it('defaults a non-numeric maxLogs to 100 and ignores a NaN page', async () => {
    process.env.LOG_DB = 'true'
    const logs = fakeLogsDb([DB_LOG])
    await run(
      fakeNode(() => Promise.resolve({ logs })),
      command({ maxLogs: NaN, page: NaN })
    )
    const { args } = logs.retrieveMultipleLogs.firstCall
    expect(args[2]).to.equal(100)
    expect(args[5]).to.equal(undefined)
  })

  it('returns 404 for a logId lookup without a log database', async () => {
    const { response } = await run(
      fakeNode(() => Promise.resolve(null)),
      command({ logId: 'db-1' })
    )
    expect(response.status.httpStatus).to.equal(404)
    expect(response.status.error).to.contain('LOG_DB')
    expect(await streamToString(response.stream as Readable)).to.contain('LOG_DB')
  })

  it('looks a logId up in the log database', async () => {
    process.env.LOG_DB = 'true'
    const logs = fakeLogsDb([])
    const node = fakeNode(() => Promise.resolve({ logs }))
    const found = await run(node, command({ logId: 'db-1' }))
    expect(found.response.status.httpStatus).to.equal(200)
    expect(found.body).to.deep.equal(DB_LOG)
    const missing = await run(node, command({ logId: 'other' }))
    expect(missing.response.status.httpStatus).to.equal(404)
    expect(missing.response.status.error).to.equal('Log not found')
  })
})
