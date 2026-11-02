import { expect } from 'chai'
import sinon from 'sinon'
import crypto from 'crypto'
import fs from 'fs'
import os from 'os'
import path from 'path'
import winston from 'winston'
import DailyRotateFile from 'winston-daily-rotate-file'
import {
  CustomNodeLogger,
  FILE_RECOVERY_DELAY_MS,
  LOG_LEVELS_NUM,
  LOGGER_MODULE_NAMES,
  buildRotatingFileTransport,
  closeFileTransport,
  defaultConsoleTransport,
  getDefaultLoggerTransports,
  getModuleFileTransport,
  getModuleLogBasename,
  getModuleLogBasenames,
  pruneExpiredLogFiles,
  resolveLoggingConfig
} from '../../../utils/logging/Logger.js'

const DAY_MS = 24 * 60 * 60 * 1000
// file names the logs reader accepts
const READER_PATTERN = /^([a-z0-9]+)-(\d{4}-\d{2}-\d{2})(?:\.(\d+))?\.log(\.gz)?$/

function utcDay(daysAgo: number = 0): string {
  return new Date(Date.now() - daysAgo * DAY_MS).toISOString().slice(0, 10)
}

function readLines(file: string): any[] {
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line))
}

function plainLogger(transport: winston.transport): winston.Logger {
  return winston.createLogger({
    level: 'debug',
    levels: LOG_LEVELS_NUM,
    transports: [transport]
  })
}

describe('Rotating log file transports', () => {
  let tmpRoot: string
  const opened: DailyRotateFile[] = []

  function tmpDir(): string {
    return fs.mkdtempSync(path.join(tmpRoot, 'logs-'))
  }

  function build(dir: string, basename: string = 'core', level: string = 'info') {
    const transport = buildRotatingFileTransport({
      dir,
      basename,
      level,
      retentionDays: 30,
      maxSize: '20m'
    })
    opened.push(transport)
    return transport
  }

  before(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ocean-node-logging-'))
  })

  afterEach(() => sinon.restore())

  after(async () => {
    await Promise.all(opened.map((t) => closeFileTransport(t)))
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  })

  it('writes timestamped JSON lines at the transport level only', async () => {
    const dir = tmpDir()
    const transport = build(dir)
    const logger = plainLogger(transport)
    logger.log('debug', 'dropped at info', { moduleName: 'CORE' })
    logger.log('info', 'kept info', { moduleName: 'CORE' })
    logger.log('error', 'kept error', { moduleName: 'CORE' })
    await closeFileTransport(transport)

    const file = path.join(dir, `core-${utcDay()}.log`)
    const lines = readLines(file)
    expect(lines.map((l) => l.message)).to.deep.equal(['kept info', 'kept error'])
    for (const line of lines) {
      expect(line.moduleName).to.equal('CORE')
      expect(new Date(line.timestamp).toISOString()).to.equal(line.timestamp)
    }
    // keys are sorted, so readers can pre-filter on '"level":"x"'
    const raw = fs.readFileSync(file, 'utf8').split('\n')[0]
    expect(raw).to.contain('"level":"info"')
    expect(Object.keys(JSON.parse(raw))).to.deep.equal(
      [...Object.keys(JSON.parse(raw))].sort()
    )
  })

  it('names files for the reader, with an explicit audit file and a current symlink', async () => {
    const dir = tmpDir()
    const transport = build(dir, 'p2p')
    plainLogger(transport).info('hello')
    await closeFileTransport(transport)

    const names = fs.readdirSync(dir)
    const logFiles = names.filter((n) => READER_PATTERN.test(n))
    expect(logFiles).to.deep.equal([`p2p-${utcDay()}.log`])
    expect(names).to.include('.p2p-audit.json')
    // no hashed default audit file
    expect(names.filter((n) => n.endsWith('-audit.json'))).to.deep.equal([
      '.p2p-audit.json'
    ])
    const audit = JSON.parse(fs.readFileSync(path.join(dir, '.p2p-audit.json'), 'utf8'))
    expect(audit.files.map((f: any) => path.basename(f.name))).to.include(logFiles[0])
    const link = path.join(dir, 'p2p-current.log')
    expect(fs.lstatSync(link).isSymbolicLink()).to.equal(true)
    expect(fs.readlinkSync(link)).to.equal(logFiles[0])
  })

  it('shares one transport (and one audit file) per module file', async () => {
    const dir = tmpDir()
    const cfg = resolveLoggingConfig({ LOG_FILES_DIR: dir, LOG_CONSOLE: 'false' })
    const core = getModuleFileTransport(LOGGER_MODULE_NAMES.CORE, cfg)
    const p2p = getModuleFileTransport(LOGGER_MODULE_NAMES.P2P, cfg)
    opened.push(core, p2p)
    expect(getModuleFileTransport('CORE', cfg)).to.equal(core)
    expect(getDefaultLoggerTransports(LOGGER_MODULE_NAMES.CORE, cfg)).to.deep.equal([
      core
    ])
    expect(p2p).to.not.equal(core)

    // two loggers for the same module write through the same rotator
    plainLogger(core).info('from the first core logger')
    plainLogger(getModuleFileTransport(LOGGER_MODULE_NAMES.CORE, cfg)).info(
      'from the second core logger'
    )
    plainLogger(p2p).info('from p2p')
    await Promise.all([closeFileTransport(core), closeFileTransport(p2p)])

    const names = fs.readdirSync(dir)
    expect(names.filter((n) => n.endsWith('-audit.json')).sort()).to.deep.equal([
      '.core-audit.json',
      '.p2p-audit.json'
    ])
    expect(
      readLines(path.join(dir, `core-${utcDay()}.log`)).map((l) => l.message)
    ).to.deep.equal(['from the first core logger', 'from the second core logger'])
    expect(readLines(path.join(dir, `p2p-${utcDay()}.log`))).to.have.length(1)
  })

  it('maps module names to file basenames', () => {
    expect(getModuleLogBasename(LOGGER_MODULE_NAMES.OCEAN_NODE)).to.equal('oceannode')
    expect(getModuleLogBasename('HTTP')).to.equal('http')
    expect(getModuleLogBasename('somethingElse')).to.equal('all')
    expect(getModuleLogBasenames()).to.include.members([
      'oceannode',
      'core',
      'database',
      'http',
      'indexer',
      'p2p',
      'provider',
      'config'
    ])
    for (const name of getModuleLogBasenames()) {
      expect(READER_PATTERN.test(`${name}-2026-01-01.log`)).to.equal(true)
    }
  })

  describe('retention', () => {
    it('prunes audited files older than the retention on startup', async () => {
      const dir = tmpDir()
      const old = Date.now() - 31 * DAY_MS
      const recent = Date.now() - 2 * DAY_MS
      const oldFile = path.join(dir, `core-${utcDay(31)}.log`)
      // not date-named: only the rotator's audit can remove it
      const orphan = path.join(dir, 'core-orphan.log')
      const recentFile = path.join(dir, `core-${utcDay(2)}.log`)
      const entry = (name: string, date: number) => ({
        date,
        name,
        hash: crypto
          .createHash('sha256')
          .update(name + 'LOG_FILE' + date)
          .digest('hex')
      })
      for (const file of [oldFile, orphan, recentFile]) fs.writeFileSync(file, '{}\n')
      fs.writeFileSync(
        path.join(dir, '.core-audit.json'),
        JSON.stringify({
          keep: { days: true, amount: 30 },
          auditLog: path.join(dir, '.core-audit.json'),
          files: [entry(oldFile, old), entry(orphan, old), entry(recentFile, recent)],
          hashType: 'sha256'
        })
      )

      build(dir)
      await new Promise((resolve) => setImmediate(resolve))

      expect(fs.existsSync(oldFile)).to.equal(false)
      expect(fs.existsSync(orphan)).to.equal(false)
      expect(fs.existsSync(recentFile)).to.equal(true)
      const audit = JSON.parse(
        fs.readFileSync(path.join(dir, '.core-audit.json'), 'utf8')
      )
      const audited = audit.files.map((f: any) => f.name)
      expect(audited).to.not.include(oldFile)
      expect(audited).to.not.include(orphan)
      expect(audited).to.include(recentFile)
    })

    it('prunes expired gzipped archives the audit no longer tracks', () => {
      const dir = tmpDir()
      const expired = [`core-${utcDay(31)}.log.gz`, `core-${utcDay(40)}.1.log.gz`]
      const kept = [
        `core-${utcDay(29)}.log.gz`,
        `p2p-${utcDay(31)}.log.gz`, // another module's file
        'core.log', // legacy file
        `core-${utcDay(31)}.json` // not a log file
      ]
      for (const name of [...expired, ...kept]) fs.writeFileSync(path.join(dir, name), '')

      build(dir)

      const names = fs.readdirSync(dir)
      for (const name of expired) expect(names).to.not.include(name)
      for (const name of kept) expect(names).to.include(name)
    })

    it('pruneExpiredLogFiles keeps the last N days', () => {
      const dir = tmpDir()
      const now = Date.UTC(2026, 2, 31, 12)
      for (const day of ['2026-03-01', '2026-02-28', '2026-03-31']) {
        fs.writeFileSync(path.join(dir, `core-${day}.log`), '')
      }
      expect(pruneExpiredLogFiles(dir, 'core', 30, now)).to.deep.equal([
        'core-2026-02-28.log'
      ])
      expect(
        pruneExpiredLogFiles(path.join(dir, 'missing'), 'core', 30, now)
      ).to.deep.equal([])
    })
  })

  describe('failures never crash the node', () => {
    it('throws on an unwritable directory, which the module factory turns into console only', () => {
      const consoleError = sinon.stub(console, 'error')
      const file = path.join(tmpDir(), 'not-a-dir')
      fs.writeFileSync(file, '')
      const badDir = path.join(file, 'logs')
      expect(() => build(badDir)).to.throw()

      const cfg = resolveLoggingConfig({ LOG_FILES_DIR: badDir, LOG_CONSOLE: 'false' })
      expect(getModuleFileTransport(LOGGER_MODULE_NAMES.CORE, cfg)).to.equal(null)
      // safety rule: no file and no DB, so the console stays on
      expect(getDefaultLoggerTransports(LOGGER_MODULE_NAMES.CORE, cfg)).to.deep.equal([
        defaultConsoleTransport
      ])
      expect(consoleError.called).to.equal(true)
    })
  })

  describe('recovery after a disk error', () => {
    it('replaces a module transport whose stream failed, after a delay', () => {
      const consoleError = sinon.stub(console, 'error')
      const clock = sinon.useFakeTimers({ now: Date.now(), toFake: ['setTimeout'] })
      try {
        const cfg = resolveLoggingConfig({ LOG_FILES_DIR: tmpDir() })
        const failed = getModuleFileTransport(LOGGER_MODULE_NAMES.INDEXER, cfg)
        const enospc = Object.assign(new Error('no space left on device'), {
          code: 'ENOSPC'
        })
        ;(failed.logStream as any).emit('error', enospc)
        expect(failed.silent).to.equal(true)
        // still the dead one until the retry fires
        expect(getModuleFileTransport(LOGGER_MODULE_NAMES.INDEXER, cfg)).to.equal(failed)

        clock.tick(FILE_RECOVERY_DELAY_MS + 1)
        const fresh = getModuleFileTransport(LOGGER_MODULE_NAMES.INDEXER, cfg)
        expect(fresh).to.not.equal(failed)
        expect(fresh.silent).to.not.equal(true)
        expect(consoleError.called).to.equal(true)
      } finally {
        clock.restore()
      }
    })
  })

  describe('CustomNodeLogger', () => {
    let logger: CustomNodeLogger
    let transport: DailyRotateFile

    before(() => {
      const cfg = resolveLoggingConfig({ LOG_FILES_DIR: tmpDir() })
      transport = getModuleFileTransport(LOGGER_MODULE_NAMES.CORE, cfg)
      opened.push(transport)
      // the only extra CustomNodeLogger of this suite (8 global ones, max 10)
      logger = new CustomNodeLogger({
        moduleName: LOGGER_MODULE_NAMES.CORE,
        level: 'info',
        levels: LOG_LEVELS_NUM,
        transports: [transport]
      })
    })

    it('logMessage defaults to info and prefixes the module name once', async () => {
      const spy = sinon.spy()
      logger.getLogger().on('data', spy)
      logger.logMessage('plain message', true)
      logger.logMessageWithEmoji('with emoji')
      logger.debug('below the threshold')
      logger.log('LEVEL_WARN', 'level by constant name')
      await new Promise((resolve) => setImmediate(resolve))
      logger.getLogger().off('data', spy)

      const lines: any[] = spy.args.map((a) => a[0])
      expect(lines.map((l) => l.level)).to.deep.equal(['info', 'info', 'warn'])
      expect(lines[0].message).to.equal('CORE:\tplain message')
      expect(lines[1].message).to.match(/^\S+ with emoji$/)
      expect(lines[2].message).to.equal('level by constant name')
      expect(lines.every((l) => l.moduleName === 'CORE')).to.equal(true)
    })

    it('logByStatus logs client errors at debug and node errors at error', () => {
      const log = sinon.spy(logger, 'log')
      logger.logByStatus(400, 'bad request')
      logger.logByStatus(404, 'not found')
      logger.logByStatus(500, 'boom')
      logger.logByStatus(undefined, 'no status')
      logger.logByStatus(null, 'null status')
      expect(log.args.map((a) => a[0])).to.deep.equal([
        'debug',
        'debug',
        'error',
        'error',
        'error'
      ])
    })

    it('throttled logs once per interval and reports what it suppressed', () => {
      const clock = sinon.useFakeTimers({ now: Date.now(), toFake: ['Date'] })
      const log = sinon.spy(logger, 'log')
      logger.throttled('k', 'warn', 'cleanup failed', 1000)
      logger.throttled('k', 'warn', 'cleanup failed', 1000)
      logger.throttled('k', 'warn', 'cleanup failed', 1000)
      logger.throttled('other', 'error', 'other key', 1000)
      clock.tick(1001)
      logger.throttled('k', 'warn', 'cleanup failed', 1000)
      logger.resetThrottle('k')
      logger.throttled('k', 'warn', 'cleanup failed', 1000)
      expect(log.args.map((a) => [a[0], a[1]])).to.deep.equal([
        ['warn', 'cleanup failed'],
        ['error', 'other key'],
        ['warn', 'cleanup failed (2 similar suppressed)'],
        ['warn', 'cleanup failed']
      ])
    })

    it('never removes a shared file transport', () => {
      logger.removeTransport(transport)
      expect(logger.getTransports()).to.include(transport)
    })

    it("handles 'error' events from the transport and its stream", () => {
      const consoleError = sinon.stub(console, 'error')
      const extra = build(tmpDir(), 'p2p')
      logger.addTransport(extra)
      expect(() => extra.emit('error', new Error('gzip failed'))).to.not.throw()
      // a maintenance error neither silences nor detaches the transport
      expect(extra.silent).to.not.equal(true)
      expect(logger.getTransports()).to.include(extra)

      const enospc = Object.assign(new Error('ENOSPC: no space left on device'), {
        code: 'ENOSPC'
      })
      expect(() => (extra.logStream as any).emit('error', enospc)).to.not.throw()
      expect(extra.silent).to.equal(true)
      expect(() => logger.error('still fine')).to.not.throw()
      expect(consoleError.called).to.equal(true)
      logger.getLogger().remove(extra)
    })
  })
})
