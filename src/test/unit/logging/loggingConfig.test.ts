import { expect } from 'chai'
import path from 'path'
import {
  normalizeLogLevel,
  parseBoolEnv,
  parseLogLevel,
  resolveLoggingConfig
} from '../../../utils/logging/Logger.js'

describe('Logging config resolution', () => {
  describe('outputs (LOG_DB x LOG_FILES x LOG_CONSOLE)', () => {
    // [LOG_DB, LOG_FILES, file, db, console, exceptionsFile]
    const matrix: [string, string, boolean, boolean, boolean, boolean][] = [
      [undefined, undefined, true, false, true, true],
      [undefined, 'true', true, false, true, true],
      [undefined, 'false', false, false, true, false],
      ['false', undefined, true, false, true, true],
      ['true', undefined, false, true, true, true],
      ['true', 'true', true, true, true, true],
      ['true', 'false', false, true, true, false]
    ]
    for (const [logDb, logFiles, file, db, consoleOn, exceptionsFile] of matrix) {
      it(`LOG_DB=${logDb} LOG_FILES=${logFiles}`, () => {
        const cfg = resolveLoggingConfig({ LOG_DB: logDb, LOG_FILES: logFiles })
        expect(cfg.file).to.equal(file)
        expect(cfg.db).to.equal(db)
        expect(cfg.console).to.equal(consoleOn)
        expect(cfg.exceptionsFile).to.equal(exceptionsFile)
        expect(cfg.filesDisabled).to.equal(logFiles === 'false')
        expect(cfg.warnings).to.deep.equal([])
      })
    }

    it('LOG_CONSOLE=false turns the console off when another output exists', () => {
      expect(resolveLoggingConfig({ LOG_CONSOLE: 'false' }).console).to.equal(false)
      expect(
        resolveLoggingConfig({ LOG_CONSOLE: 'false', LOG_DB: 'true', LOG_FILES: 'false' })
          .console
      ).to.equal(false)
    })

    it('keeps the console on when it would be the only output turned off (safety rule)', () => {
      const cfg = resolveLoggingConfig({ LOG_CONSOLE: 'false', LOG_FILES: 'false' })
      expect(cfg.console).to.equal(true)
      expect(cfg.warnings).to.have.length(1)
      expect(cfg.warnings[0]).to.contain('LOG_CONSOLE')
    })

    it('LOG_CONSOLE=true keeps the console on in every setup', () => {
      expect(
        resolveLoggingConfig({ LOG_CONSOLE: 'true', LOG_DB: 'true', LOG_FILES: 'true' })
          .console
      ).to.equal(true)
    })

    it('treats 0 / no / off / FALSE as false and empty as unset', () => {
      expect(resolveLoggingConfig({ LOG_FILES: '0' }).file).to.equal(false)
      expect(resolveLoggingConfig({ LOG_FILES: 'FALSE' }).file).to.equal(false)
      expect(resolveLoggingConfig({ LOG_DB: 'no' }).file).to.equal(true)
      expect(resolveLoggingConfig({ LOG_DB: 'off' }).db).to.equal(false)
      expect(resolveLoggingConfig({ LOG_DB: 'yes' }).db).to.equal(true)
      expect(resolveLoggingConfig({ LOG_FILES: '' }).file).to.equal(true)
      expect(resolveLoggingConfig({ LOG_FILES: ' ', LOG_DB: '1' }).file).to.equal(false)
    })
  })

  describe('levels', () => {
    it('console level follows LOG_LEVEL, else debug in development and info otherwise', () => {
      expect(resolveLoggingConfig({ LOG_LEVEL: 'WARN' }).consoleLevel).to.equal('warn')
      expect(resolveLoggingConfig({}).consoleLevel).to.equal('debug')
      expect(resolveLoggingConfig({ NODE_ENV: 'development' }).consoleLevel).to.equal(
        'debug'
      )
      expect(resolveLoggingConfig({ NODE_ENV: 'production' }).consoleLevel).to.equal(
        'info'
      )
    })

    it('file level defaults to info and follows LOG_FILES_LEVEL', () => {
      expect(resolveLoggingConfig({ NODE_ENV: 'production' }).fileLevel).to.equal('info')
      expect(resolveLoggingConfig({ LOG_FILES_LEVEL: 'Debug' }).fileLevel).to.equal(
        'debug'
      )
    })

    it('logger level is the more verbose of console and file levels', () => {
      expect(
        resolveLoggingConfig({ LOG_LEVEL: 'warn', NODE_ENV: 'production' }).loggerLevel
      ).to.equal('info')
      expect(
        resolveLoggingConfig({ LOG_LEVEL: 'debug', LOG_FILES_LEVEL: 'error' }).loggerLevel
      ).to.equal('debug')
      expect(
        resolveLoggingConfig({ LOG_LEVEL: 'error', LOG_FILES_LEVEL: 'verbose' })
          .loggerLevel
      ).to.equal('verbose')
      // no file output: console level only
      expect(
        resolveLoggingConfig({ LOG_LEVEL: 'warn', LOG_FILES: 'false' }).loggerLevel
      ).to.equal('warn')
    })

    it('invalid levels fall back to the defaults with a warning', () => {
      const cfg = resolveLoggingConfig({
        NODE_ENV: 'production',
        LOG_LEVEL: 'loud',
        LOG_FILES_LEVEL: 'everything'
      })
      expect(cfg.consoleLevel).to.equal('info')
      expect(cfg.fileLevel).to.equal('info')
      expect(cfg.warnings).to.have.length(2)
      expect(cfg.warnings.join(' '))
        .to.contain('LOG_LEVEL')
        .and.contain('LOG_FILES_LEVEL')
    })
  })

  describe('files', () => {
    it('defaults: logs/ directory, 30 days, 20m', () => {
      const cfg = resolveLoggingConfig({})
      expect(cfg.dir).to.equal(path.resolve('logs'))
      expect(cfg.retentionDays).to.equal(30)
      expect(cfg.maxSize).to.equal('20m')
    })

    it('reads LOG_FILES_DIR, LOG_FILES_RETENTION_DAYS and LOG_FILES_MAX_SIZE', () => {
      const cfg = resolveLoggingConfig({
        LOG_FILES_DIR: '/var/log/ocean',
        LOG_FILES_RETENTION_DAYS: '90',
        LOG_FILES_MAX_SIZE: '500K'
      })
      expect(cfg.dir).to.equal(path.resolve('/var/log/ocean'))
      expect(cfg.retentionDays).to.equal(90)
      expect(cfg.maxSize).to.equal('500k')
      expect(resolveLoggingConfig({ LOG_FILES_MAX_SIZE: '1g' }).maxSize).to.equal('1g')
      expect(
        resolveLoggingConfig({ LOG_FILES_RETENTION_DAYS: '1' }).retentionDays
      ).to.equal(1)
    })

    for (const value of ['0', '-5', '1.5', 'abc', '30d']) {
      it(`rejects LOG_FILES_RETENTION_DAYS=${value}`, () => {
        const cfg = resolveLoggingConfig({ LOG_FILES_RETENTION_DAYS: value })
        expect(cfg.retentionDays).to.equal(30)
        expect(cfg.warnings).to.have.length(1)
      })
    }

    for (const value of ['20', '10mb', '0m', '1t', 'big']) {
      it(`rejects LOG_FILES_MAX_SIZE=${value}`, () => {
        const cfg = resolveLoggingConfig({ LOG_FILES_MAX_SIZE: value })
        expect(cfg.maxSize).to.equal('20m')
        expect(cfg.warnings).to.have.length(1)
      })
    }
  })

  describe('helpers', () => {
    it('parseBoolEnv', () => {
      expect(parseBoolEnv(undefined)).to.equal(undefined)
      expect(parseBoolEnv('')).to.equal(undefined)
      expect(parseBoolEnv('true')).to.equal(true)
      expect(parseBoolEnv('1')).to.equal(true)
      expect(parseBoolEnv('Off')).to.equal(false)
    })

    it('parseLogLevel / normalizeLogLevel', () => {
      expect(parseLogLevel('ERROR')).to.equal('error')
      expect(parseLogLevel('nope')).to.equal(null)
      expect(normalizeLogLevel('LEVEL_ERROR')).to.equal('error')
      expect(normalizeLogLevel('level_warn')).to.equal('warn')
      expect(normalizeLogLevel('Debug')).to.equal('debug')
      expect(normalizeLogLevel('bogus')).to.equal('info')
      expect(normalizeLogLevel(undefined)).to.equal('info')
    })
  })
})
