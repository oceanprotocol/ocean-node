import { expect } from 'chai'
import sinon from 'sinon'
import fs from 'fs'
import os from 'os'
import path from 'path'
import zlib from 'zlib'
import { readLogFiles, LogRecord } from '../../../utils/logging/logFiles.js'

// one JSON line as the file transport writes it (sorted keys, ISO timestamp)
function line(
  module: string,
  level: string,
  timestamp: string,
  message?: string
): string {
  return JSON.stringify({
    component: module.toUpperCase(),
    level,
    message: message ?? `${module} ${level} ${timestamp}`,
    moduleName: module.toUpperCase(),
    timestamp
  })
}

function exceptionLine(message: string, date: string, extra: object = {}): string {
  return JSON.stringify({
    component: 'CONFIG',
    date,
    exception: true,
    level: 'error',
    message: `uncaughtException: ${message}`,
    os: { loadavg: [0, 0, 0] },
    stack: `Error: ${message}\n    at somewhere`,
    trace: [{ function: 'somewhere' }],
    ...extra
  })
}

function writeLines(dir: string, name: string, lines: string[], tail: string = ''): void {
  fs.writeFileSync(path.join(dir, name), lines.join('\n') + '\n' + tail)
}

function buildFixtures(dir: string): void {
  // 2026-01-12: two core parts, p2p, exceptions; malformed and partially written lines
  writeLines(
    dir,
    'core-2026-01-12.log',
    [
      line('core', 'info', '2026-01-12T10:00:00.000Z'),
      'not json at all',
      line('core', 'info', '2026-01-12T12:00:00.000Z'),
      line('core', 'debug', '2026-01-12T13:00:00.000Z')
    ],
    '{"component":"CORE","level":"info","mess'
  )
  writeLines(dir, 'core-2026-01-12.1.log', [
    line('core', 'info', '2026-01-12T14:00:00.000Z'),
    line('core', 'error', '2026-01-12T15:00:00.000Z')
  ])
  writeLines(dir, 'p2p-2026-01-12.log', [
    line('p2p', 'info', '2026-01-12T11:00:00.000Z'),
    line('p2p', 'warn', '2026-01-12T12:30:00.000Z')
  ])
  writeLines(dir, 'exceptions-2026-01-12.log', [
    exceptionLine('boom', 'Mon Jan 12 2026 16:00:00 GMT+0000', {
      timestamp: '2026-01-12T16:00:00.000Z'
    })
  ])
  // 2026-01-11: gzipped archive + plain file
  fs.writeFileSync(
    path.join(dir, 'core-2026-01-11.log.gz'),
    zlib.gzipSync(
      [
        line('core', 'info', '2026-01-11T08:00:00.000Z'),
        line('core', 'error', '2026-01-11T20:00:00.000Z')
      ].join('\n') + '\n'
    )
  )
  writeLines(dir, 'p2p-2026-01-11.log', [line('p2p', 'info', '2026-01-11T09:00:00.000Z')])
  // 2026-01-10: corrupt archive, ends that file only
  fs.writeFileSync(path.join(dir, 'p2p-2026-01-10.log.gz'), 'this is not gzip')
  // out of the default test range
  writeLines(dir, 'core-2026-01-05.log', [
    line('core', 'info', '2026-01-05T10:00:00.000Z')
  ])
  // legacy exception files: one copy per module, dates without ms, no day in the name
  writeLines(dir, 'core_exceptions.log', [
    exceptionLine('legacy-a', 'Mon Dec 01 2025 10:00:00 GMT+0200 (EET)'),
    exceptionLine('legacy-b', 'Tue Dec 02 2025 10:00:00 GMT+0200 (EET)')
  ])
  writeLines(dir, 'OceanNode_exceptions.log', [
    exceptionLine('legacy-a', 'Mon Dec 01 2025 10:00:00 GMT+0200 (EET)')
  ])
  // ignored: audit file, symlink, legacy untimestamped file, unknown series
  fs.writeFileSync(path.join(dir, '.core-audit.json'), '{"files":[]}')
  fs.symlinkSync('core-2026-01-12.log', path.join(dir, 'core-current.log'))
  writeLines(dir, 'core.log', [JSON.stringify({ level: 'info', message: 'old' })])
  writeLines(dir, 'unknown-2026-01-12.log', [
    line('unknown', 'info', '2026-01-12T17:00:00.000Z')
  ])
}

const RANGE = {
  startTime: new Date('2026-01-10T00:00:00.000Z'),
  endTime: new Date('2026-01-12T23:59:59.999Z')
}

function times(records: LogRecord[]): string[] {
  return records.map((r) => new Date(r.timestamp).toISOString())
}

describe('readLogFiles', () => {
  let dir: string
  let createReadStream: sinon.SinonSpy

  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocean-logs-reader-'))
    buildFixtures(dir)
  })

  beforeEach(() => {
    createReadStream = sinon.spy(fs, 'createReadStream')
  })

  afterEach(() => {
    sinon.restore()
  })

  after(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  function openedFiles(): string[] {
    return createReadStream.getCalls().map((call) => path.basename(String(call.args[0])))
  }

  it('returns [] for a missing directory', async () => {
    const logs = await readLogFiles({
      ...RANGE,
      maxLogs: 10,
      dir: path.join(dir, 'does-not-exist')
    })
    expect(logs).to.deep.equal([])
  })

  it('returns [] for invalid ranges and maxLogs', async () => {
    expect(
      await readLogFiles({ ...RANGE, startTime: new Date('nope'), maxLogs: 10, dir })
    ).to.deep.equal([])
    expect(
      await readLogFiles({
        startTime: RANGE.endTime,
        endTime: RANGE.startTime,
        maxLogs: 10,
        dir
      })
    ).to.deep.equal([])
    expect(await readLogFiles({ ...RANGE, maxLogs: 0, dir })).to.deep.equal([])
    expect(await readLogFiles({ ...RANGE, maxLogs: NaN, dir })).to.deep.equal([])
  })

  it('merges every module newest first, skipping bad lines and ignored files', async () => {
    const logs = await readLogFiles({ ...RANGE, maxLogs: 100, dir })
    expect(times(logs)).to.deep.equal([
      '2026-01-12T16:00:00.000Z',
      '2026-01-12T15:00:00.000Z',
      '2026-01-12T14:00:00.000Z',
      '2026-01-12T13:00:00.000Z',
      '2026-01-12T12:30:00.000Z',
      '2026-01-12T12:00:00.000Z',
      '2026-01-12T11:00:00.000Z',
      '2026-01-12T10:00:00.000Z',
      '2026-01-11T20:00:00.000Z',
      '2026-01-11T09:00:00.000Z',
      '2026-01-11T08:00:00.000Z'
    ])
    expect(logs.map((r) => r.moduleName)).to.deep.equal([
      'OCEANNODE',
      'CORE',
      'CORE',
      'CORE',
      'P2P',
      'CORE',
      'P2P',
      'CORE',
      'CORE',
      'P2P',
      'CORE'
    ])
    // the range starts after the first rotated file: legacy files are not read
    expect(openedFiles()).to.not.include('core_exceptions.log')
    expect(openedFiles()).to.not.include('core-current.log')
    expect(openedFiles()).to.not.include('core-2026-01-05.log')
  })

  it('returns records shaped like the log DB', async () => {
    const logs = await readLogFiles({ ...RANGE, maxLogs: 100, dir })
    const regular = logs.find((r) => r.moduleName === 'CORE')
    expect(Object.keys(regular).sort()).to.deep.equal([
      'level',
      'message',
      'moduleName',
      'timestamp'
    ])
    expect(regular.timestamp).to.be.a('number')
    const exception = logs[0]
    expect(exception.level).to.equal('error')
    expect(exception.message).to.equal('uncaughtException: boom')
    const meta = JSON.parse(exception.meta)
    expect(meta.stack).to.contain('Error: boom')
    expect(meta.trace).to.be.an('array')
    expect(meta.os).to.be.an('object')
  })

  it('opens only the selected module files, case-insensitively', async () => {
    const logs = await readLogFiles({ ...RANGE, maxLogs: 100, moduleName: 'P2P', dir })
    expect(times(logs)).to.deep.equal([
      '2026-01-12T12:30:00.000Z',
      '2026-01-12T11:00:00.000Z',
      '2026-01-11T09:00:00.000Z'
    ])
    for (const name of openedFiles()) {
      expect(name).to.match(/^p2p-/)
    }
    const lower = await readLogFiles({ ...RANGE, maxLogs: 100, moduleName: 'p2p', dir })
    expect(lower).to.deep.equal(logs)
  })

  it('returns exception entries for the OCEANNODE module only', async () => {
    const node = await readLogFiles({
      ...RANGE,
      maxLogs: 100,
      moduleName: 'OceanNode',
      dir
    })
    expect(times(node)).to.deep.equal(['2026-01-12T16:00:00.000Z'])
    expect(node[0].moduleName).to.equal('OCEANNODE')
    expect(node[0].meta).to.be.a('string')
    for (const name of openedFiles()) {
      expect(name).to.match(/^exceptions-/)
    }
  })

  it('prefers the complete plain file when a gzipped copy of it also exists', async () => {
    const own = fs.mkdtempSync(path.join(os.tmpdir(), 'ocean-logs-gz-'))
    try {
      const lines = ['08', '09', '10'].map((h) =>
        JSON.stringify({
          component: 'CORE',
          level: 'info',
          message: `at ${h}`,
          moduleName: 'CORE',
          timestamp: `2026-03-01T${h}:00:00.000Z`
        })
      )
      fs.writeFileSync(path.join(own, 'core-2026-03-01.log'), lines.join('\n') + '\n')
      // an archive interrupted mid-gzip: only the first line made it
      fs.writeFileSync(
        path.join(own, 'core-2026-03-01.log.gz'),
        zlib.gzipSync(lines[0] + '\n').subarray(0, 20)
      )
      const logs = await readLogFiles({
        startTime: new Date('2026-03-01T00:00:00.000Z'),
        endTime: new Date('2026-03-01T23:59:59.000Z'),
        maxLogs: 10,
        dir: own
      })
      expect(logs.map((r) => r.message)).to.deep.equal(['at 10', 'at 09', 'at 08'])
    } finally {
      fs.rmSync(own, { recursive: true, force: true })
    }
  })

  it('returns [] for an unknown module', async () => {
    const logs = await readLogFiles({ ...RANGE, maxLogs: 100, moduleName: 'nope', dir })
    expect(logs).to.deep.equal([])
    expect(openedFiles()).to.deep.equal([])
  })

  it('filters on the exact level', async () => {
    const logs = await readLogFiles({ ...RANGE, maxLogs: 100, level: 'ERROR', dir })
    expect(times(logs)).to.deep.equal([
      '2026-01-12T16:00:00.000Z',
      '2026-01-12T15:00:00.000Z',
      '2026-01-11T20:00:00.000Z'
    ])
    expect(logs.every((r) => r.level === 'error')).to.equal(true)
    const debug = await readLogFiles({ ...RANGE, maxLogs: 100, level: 'debug', dir })
    expect(times(debug)).to.deep.equal(['2026-01-12T13:00:00.000Z'])
  })

  it('filters on the time range inside a day', async () => {
    const logs = await readLogFiles({
      startTime: new Date('2026-01-12T11:30:00.000Z'),
      endTime: new Date('2026-01-12T14:30:00.000Z'),
      maxLogs: 100,
      dir
    })
    expect(times(logs)).to.deep.equal([
      '2026-01-12T14:00:00.000Z',
      '2026-01-12T13:00:00.000Z',
      '2026-01-12T12:30:00.000Z',
      '2026-01-12T12:00:00.000Z'
    ])
  })

  it('stops after the newest day once the page is filled', async () => {
    const logs = await readLogFiles({ ...RANGE, maxLogs: 2, dir })
    expect(times(logs)).to.deep.equal([
      '2026-01-12T16:00:00.000Z',
      '2026-01-12T15:00:00.000Z'
    ])
    expect(openedFiles().length).to.be.greaterThan(0)
    for (const name of openedFiles()) {
      expect(name).to.contain('2026-01-12')
    }
  })

  it('pages with maxLogs and a 1-based page', async () => {
    const page1 = await readLogFiles({ ...RANGE, maxLogs: 4, page: 1, dir })
    const page2 = await readLogFiles({ ...RANGE, maxLogs: 4, page: 2, dir })
    const page3 = await readLogFiles({ ...RANGE, maxLogs: 4, page: 3, dir })
    const page4 = await readLogFiles({ ...RANGE, maxLogs: 4, page: 4, dir })
    const all = await readLogFiles({ ...RANGE, maxLogs: 100, dir })
    expect(page1).to.deep.equal(all.slice(0, 4))
    expect(page2).to.deep.equal(all.slice(4, 8))
    expect(page3).to.deep.equal(all.slice(8, 11))
    expect(page4).to.deep.equal([])
    // 0, NaN and undefined mean the first page
    expect(await readLogFiles({ ...RANGE, maxLogs: 4, page: 0, dir })).to.deep.equal(
      page1
    )
    expect(await readLogFiles({ ...RANGE, maxLogs: 4, page: NaN, dir })).to.deep.equal(
      page1
    )
  })

  it('reads legacy exception files once per exception when the range predates rotation', async () => {
    const logs = await readLogFiles({
      startTime: new Date('2025-11-01T00:00:00.000Z'),
      endTime: new Date('2025-12-31T00:00:00.000Z'),
      maxLogs: 100,
      dir
    })
    expect(logs.map((r) => r.message)).to.deep.equal([
      'uncaughtException: legacy-b',
      'uncaughtException: legacy-a'
    ])
    expect(logs[0].timestamp).to.equal(Date.parse('2025-12-02T08:00:00.000Z'))
    expect(logs.every((r) => r.moduleName === 'OCEANNODE')).to.equal(true)
    expect(JSON.parse(logs[0].meta).stack).to.contain('legacy-b')
  })

  it('merges legacy exceptions after rotated files in a range spanning both', async () => {
    const logs = await readLogFiles({
      startTime: new Date('2025-11-01T00:00:00.000Z'),
      endTime: RANGE.endTime,
      maxLogs: 100,
      level: 'error',
      dir
    })
    expect(logs.map((r) => r.message)).to.deep.equal([
      'uncaughtException: boom',
      'core error 2026-01-12T15:00:00.000Z',
      'core error 2026-01-11T20:00:00.000Z',
      'uncaughtException: legacy-b',
      'uncaughtException: legacy-a'
    ])
  })
})
