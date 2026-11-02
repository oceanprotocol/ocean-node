import { expect } from 'chai'
import {
  SENSITIVE_LOG_FIELDS,
  errorSummary,
  redactSensitiveFields,
  redactUrls,
  safeStringify
} from '../../../utils/logging/redact.js'

const TOKEN = 'eyJhbGciOiJIUzI1NiJ9.fake.token'
const ERC20 = '0x0000000000000000000000000000000000000abc'

describe('Log redaction', () => {
  describe('redactSensitiveFields', () => {
    it('covers the credential and payload fields', () => {
      expect(SENSITIVE_LOG_FIELDS).to.include.members([
        'authorization',
        'signature',
        'nonce',
        'aes_encrypted_key',
        'encryptedDockerRegistryAuth',
        'userData',
        'userdata',
        'files',
        'headers',
        'envs',
        'algocustomdata',
        'dockerRegistryAuth',
        'password',
        'secretAccessKey',
        'accessKeyId',
        'privateKey',
        'rawcode'
      ])
      expect(SENSITIVE_LOG_FIELDS).to.not.include('token')
    })

    it('redacts every sensitive field at any depth, case-insensitively', () => {
      const input = {
        command: 'download',
        documentId: 'did:op:1234',
        Authorization: TOKEN,
        signature: '0xsig',
        nonce: '17',
        userData: { secret: 'u' },
        files: [{ type: 'url', url: 'https://secret.example.com/file' }],
        nested: {
          deeper: [
            { headers: { Authorization: 'Bearer x' } },
            { password: 'p', secretAccessKey: 's', accessKeyId: 'a' },
            { privateKey: '0xkey', rawCode: 'print(1)', encryptedDockerRegistryAuth: 'e' }
          ]
        }
      }
      const out = redactSensitiveFields(input)
      const text = JSON.stringify(out)
      for (const secret of [
        TOKEN,
        '0xsig',
        '"17"',
        '"u"',
        'secret.example.com',
        'Bearer x',
        '"p"',
        '"s"',
        '"a"',
        '0xkey',
        'print(1)',
        '"e"'
      ]) {
        expect(text).to.not.contain(secret)
      }
      expect(out.documentId).to.equal('did:op:1234')
      expect(out.Authorization).to.equal('[REDACTED]')
      expect(out.nested.deeper[2].rawCode).to.equal('[REDACTED]')
    })

    it('redacts "token" only when asked to', () => {
      const payload = { payment: { token: ERC20 }, token: TOKEN }
      expect(redactSensitiveFields(payload).payment.token).to.equal(ERC20)
      const redacted = redactSensitiveFields(payload, { redactToken: true })
      expect(redacted.token).to.equal('[REDACTED]')
      expect(redacted.payment.token).to.equal('[REDACTED]')
    })

    it('keeps null / undefined values and non-plain objects as they are', () => {
      const buffer = Buffer.from('abc')
      const date = new Date(0)
      const out = redactSensitiveFields({
        signature: null,
        nonce: undefined,
        buffer,
        date
      })
      expect(out.signature).to.equal(null)
      expect(out.nonce).to.equal(undefined)
      expect(out.buffer).to.equal(buffer)
      expect(out.date).to.equal(date)
      expect(redactSensitiveFields('text')).to.equal('text')
      expect(redactSensitiveFields(null)).to.equal(null)
    })

    it('does not mutate its input', () => {
      const nested = { authorization: TOKEN }
      const input = { nested, list: [nested] }
      redactSensitiveFields(input)
      expect(nested.authorization).to.equal(TOKEN)
      expect(input.list[0]).to.equal(nested)
    })

    it('survives circular structures', () => {
      const blob: any = { authorization: TOKEN, list: [] }
      blob.self = blob
      blob.list.push(blob)
      const out = redactSensitiveFields(blob)
      expect(out.self).to.equal('[CIRCULAR]')
      expect(out.list[0]).to.equal('[CIRCULAR]')
      expect(out.authorization).to.equal('[REDACTED]')
    })
  })

  describe('safeStringify', () => {
    it('redacts by default, including tokens', () => {
      const text = safeStringify({ token: TOKEN, signature: '0xsig', chainId: 8996 })
      expect(text).to.not.contain(TOKEN)
      expect(text).to.not.contain('0xsig')
      expect(text).to.contain('8996')
      expect(safeStringify({ token: ERC20 }, { redact: false })).to.contain(ERC20)
    })

    it('handles BigInt, cycles, errors and undefined', () => {
      const value: any = { amount: 10n ** 20n, nested: { ok: true } }
      value.nested.parent = value
      // the same object twice is not a cycle
      const shared = { a: 1 }
      value.left = shared
      value.right = shared
      value.err = new Error('failed to fetch https://user:pw@host.example/secret?k=1')
      const text = safeStringify(value)
      const parsed = JSON.parse(text)
      expect(parsed.amount).to.equal('100000000000000000000')
      expect(parsed.nested.parent).to.equal('[CIRCULAR]')
      expect(parsed.left).to.deep.equal({ a: 1 })
      expect(parsed.right).to.deep.equal({ a: 1 })
      expect(parsed.err.message).to.equal('failed to fetch https://host.example/…')
      expect(safeStringify(undefined)).to.equal('undefined')
      expect(text).to.not.contain('\n')
    })

    it('truncates long output', () => {
      const text = safeStringify({ data: 'x'.repeat(5000) })
      expect(text.length).to.be.lessThan(2100)
      expect(text).to.match(/…\(truncated \d+ chars\)$/)
      expect(safeStringify({ data: 'x'.repeat(50) }, { maxLength: 10 })).to.equal(
        '{"data":"x…(truncated 51 chars)'
      )
      expect(safeStringify('x'.repeat(3000), { maxLength: 0 })).to.have.length(3002)
    })
  })

  it('redacts algorithm envs/custom data, file credentials and URLs under any key', () => {
    const fileInfo = {
      command: 'fileInfo',
      file: {
        type: 'url',
        url: 'https://host.example.com/data.csv?apikey=K1',
        headers: { Authorization: 'Bearer z' }
      }
    }
    const compute = {
      command: 'startCompute',
      algorithm: {
        documentId: 'did:op:algo',
        fileObject: { type: 's3', s3Access: { bucket: 'b' } },
        envs: { API_KEY: 'k2' },
        algocustomdata: { password: 'p2', note: 'n' },
        meta: { url: 'ftp://user:pw@ftp.example.org/pub/x' }
      },
      dockerRegistryAuth: 'creds'
    }
    const text = JSON.stringify(redactSensitiveFields([fileInfo, compute]))
    for (const secret of ['apikey=K1', 'Bearer z', 'k2', 'p2', 'user:pw', 'creds']) {
      expect(text).to.not.include(secret)
    }
    // single file objects keep their shape for debugging; only the URL origin remains
    expect(text).to.include('"type":"url"')
    expect(text).to.include('https://host.example.com/…')
    expect(text).to.include('did:op:algo')
    expect(text).to.include('ftp://ftp.example.org/…')
  })

  describe('redactUrls', () => {
    it('keeps only the origin of every URL', () => {
      expect(
        redactUrls(
          'GET https://user:pass@files.example.com:8443/a/b.csv?sig=abc#x failed, retry ftp://ftp.example.org/pub/data.'
        )
      ).to.equal(
        'GET https://files.example.com:8443/… failed, retry ftp://ftp.example.org/….'
      )
      expect(redactUrls('s3://bucket-name/private/key.parquet')).to.equal(
        's3://bucket-name/…'
      )
      expect(redactUrls('see (https://ipfs.io/ipfs/QmHash)')).to.equal(
        'see (https://ipfs.io/…)'
      )
      expect(redactUrls('http://localhost:8108/?apiKey=xyz')).to.equal(
        'http://localhost:8108/…'
      )
    })

    it('stays linear on long punctuation runs', () => {
      const hostile = 'http://a.example' + '!'.repeat(200000) + 'x'
      const started = Date.now()
      redactUrls(hostile)
      expect(Date.now() - started).to.be.lessThan(500)
      expect(redactUrls('see https://example.com/a/b).')).to.equal(
        'see https://example.com/…).'
      )
    })

    it('leaves bare origins and plain text alone', () => {
      expect(redactUrls('node https://example.com is up')).to.equal(
        'node https://example.com is up'
      )
      expect(redactUrls('https://example.com/')).to.equal('https://example.com/')
      expect(redactUrls('no url here: 0xabc, did:op:1')).to.equal(
        'no url here: 0xabc, did:op:1'
      )
      expect(redactUrls('')).to.equal('')
    })
  })

  describe('errorSummary', () => {
    it('never quotes the input of a JSON parse error', () => {
      let err: unknown
      try {
        JSON.parse('{"url":"https://secret.example.com/data.csv", oops')
      } catch (e) {
        err = e
      }
      const summary = errorSummary(err)
      expect(summary).to.equal('invalid JSON (SyntaxError)')
    })

    it('reduces URLs in error messages to their origin', () => {
      expect(
        errorSummary(
          new Error('fetch https://secret.example.com/a/b?token=1 returned 403')
        )
      ).to.equal('fetch https://secret.example.com/… returned 403')
      expect(errorSummary('timeout calling https://rpc.example.com/v1/KEY')).to.equal(
        'timeout calling https://rpc.example.com/…'
      )
    })

    it('handles other values', () => {
      expect(errorSummary(undefined)).to.equal('unknown error')
      expect(errorSummary(null)).to.equal('unknown error')
      expect(errorSummary({ code: 42, signature: '0xsig' })).to.equal(
        '{"code":42,"signature":"[REDACTED]"}'
      )
      expect(errorSummary(new TypeError(''))).to.equal('TypeError')
      expect(errorSummary(new Error('x'.repeat(2000))).length).to.be.lessThan(600)
    })
  })
})
