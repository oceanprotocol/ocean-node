import { expect } from 'chai'
import http, { Server } from 'http'
import { AddressInfo } from 'net'
import { Readable } from 'stream'
import { Wallet, HDNodeWallet } from 'ethers'
import { getConfiguration } from '../../utils/config.js'
import { OceanNode } from '../../OceanNode.js'
import { Database } from '../../components/database/index.js'
import { KeyManager } from '../../components/KeyManager/index.js'
import { PROTOCOL_COMMANDS } from '../../utils/constants.js'
import { FileInfoHandler } from '../../components/core/handler/fileInfoHandler.js'
import { FileInfoCommand } from '../../@types/commands.js'
import { FileObjectType } from '../../@types/fileObject.js'
import { UrlStorage } from '../../components/storage/UrlStorage.js'
import { createHashForSignature, safeSign } from '../utils/signature.js'

// spin up a throwaway local http server on an ephemeral port that records the last request headers
function startServer(
  onHeaders: (headers: http.IncomingHttpHeaders) => void
): Promise<Server> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      onHeaders(req.headers)
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('hello')
    })
    server.listen(0, () => resolve(server))
  })
}

function baseUrl(server: Server): string {
  const { port } = server.address() as AddressInfo
  return `http://127.0.0.1:${port}/file.txt`
}

function stopServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.closeAllConnections()
    server.close(() => resolve())
  })
}

describe('FileInfoHandler ON-07 (auth, header allow-list, rate limit)', () => {
  let node: OceanNode
  let consumer: HDNodeWallet
  let consumerAddress: string
  // snapshot of the config fields this suite mutates
  let savedAllowUnauth: boolean
  let savedRateLimit: number
  let savedUnsafeURLs: string[]
  let savedAllowedHeaders: string[]

  const rawFileTask = (overrides: Partial<FileInfoCommand> = {}): FileInfoCommand => ({
    command: PROTOCOL_COMMANDS.FILE_INFO,
    file: { type: 'url', url: 'https://example.com/x', method: 'get' } as any,
    type: FileObjectType.URL,
    caller: '127.0.0.42',
    ...overrides
  })

  before(async () => {
    const config = await getConfiguration()
    const keyManager = new KeyManager(config)
    // This suite only needs the SQLite-backed nonce/auth DBs. Drop the metadata DB url so
    // Database.init() cannot depend on an Elasticsearch/Typesense being up: when the metadata DB
    // is configured but unreachable, init() returns null, OceanNode gets no Auth and every
    // signed request is rejected with 401 "Auth not configured" after a multi-second retry
    // (env-race dependent, hence the flake).
    const db = await Database.init({ ...config.dbConfig, url: '' })
    node = OceanNode.getInstance(config, db, null, null, null, keyManager, null, true)
    consumer = Wallet.createRandom()
    consumerAddress = await consumer.getAddress()
  })

  beforeEach(() => {
    const config = node.getConfig()
    savedAllowUnauth = config.fileInfoAllowUnauthenticated
    savedRateLimit = config.fileInfoRateLimit
    savedUnsafeURLs = config.unsafeURLs
    savedAllowedHeaders = config.fileInfoAllowedHeaders
    // start each test from the secure defaults
    config.fileInfoAllowUnauthenticated = false
    config.fileInfoRateLimit = 0
  })

  afterEach(() => {
    const config = node.getConfig()
    config.fileInfoAllowUnauthenticated = savedAllowUnauth
    config.fileInfoRateLimit = savedRateLimit
    config.unsafeURLs = savedUnsafeURLs
    config.fileInfoAllowedHeaders = savedAllowedHeaders
  })

  it('raw-file fileInfo with NO signature is rejected with 401', async () => {
    const res = await new FileInfoHandler(node).handle(rawFileTask())
    expect(res.status.httpStatus).to.equal(401)
  })

  it('raw-file fileInfo with an INVALID signature is rejected with 401', async () => {
    const res = await new FileInfoHandler(node).handle(
      rawFileTask({
        address: consumerAddress,
        nonce: Date.now().toString(),
        signature: '0xdeadbeef'
      })
    )
    expect(res.status.httpStatus).to.equal(401)
  })

  it('raw-file fileInfo with a VALID signature passes the auth gate (200)', async () => {
    const config = node.getConfig()
    config.unsafeURLs = [] // allow the local 127.0.0.1 test server
    const server = await startServer(() => {})
    try {
      const nonce = Date.now().toString()
      const messageHashBytes = createHashForSignature(
        consumerAddress,
        nonce,
        PROTOCOL_COMMANDS.FILE_INFO
      )
      const signature = await safeSign(consumer, messageHashBytes)
      const res = await new FileInfoHandler(node).handle(
        rawFileTask({
          file: { type: 'url', url: baseUrl(server), method: 'get' } as any,
          address: consumerAddress,
          nonce,
          signature
        })
      )
      expect(res.status.httpStatus).to.equal(200)
    } finally {
      await stopServer(server)
    }
  })

  it('FILEINFO_ALLOW_UNAUTHENTICATED=true bypasses the auth gate', async () => {
    const config = node.getConfig()
    config.fileInfoAllowUnauthenticated = true
    config.unsafeURLs = []
    const server = await startServer(() => {})
    try {
      const res = await new FileInfoHandler(node).handle(
        rawFileTask({
          file: { type: 'url', url: baseUrl(server), method: 'get' } as any
        })
      )
      // no signature supplied, yet it is NOT a 401
      expect(res.status.httpStatus).to.not.equal(401)
      expect(res.status.httpStatus).to.equal(200)
    } finally {
      await stopServer(server)
    }
  })

  it('did + serviceId path is NOT subject to the new raw-file auth gate (no 401)', async () => {
    // No signature, but the did path must not be rejected by the raw-file auth gate.
    const res = await new FileInfoHandler(node).handle({
      command: PROTOCOL_COMMANDS.FILE_INFO,
      did: 'did:op:0000000000000000000000000000000000000000000000000000000000000000',
      serviceId: '0',
      caller: '127.0.0.42'
    })
    expect(res.status.httpStatus).to.not.equal(401)
  })

  it('dedicated rate-limit knob throttles the raw-file path on a separate bucket', async () => {
    const config = node.getConfig()
    config.fileInfoAllowUnauthenticated = true // isolate the rate-limit behaviour
    config.fileInfoRateLimit = 2
    config.unsafeURLs = []
    const server = await startServer(() => {})
    try {
      const task = () =>
        rawFileTask({
          file: { type: 'url', url: baseUrl(server), method: 'get' } as any,
          caller: '10.9.8.7'
        })
      const r1 = await new FileInfoHandler(node).handle(task())
      const r2 = await new FileInfoHandler(node).handle(task())
      const r3 = await new FileInfoHandler(node).handle(task())
      expect(r1.status.httpStatus).to.not.equal(403)
      expect(r2.status.httpStatus).to.not.equal(403)
      expect(r3.status.httpStatus).to.equal(403)
    } finally {
      await stopServer(server)
    }
  })

  describe('header allow-list filtering (storage layer)', () => {
    it('strips non-allow-listed headers and forwards allow-listed ones', async () => {
      let received: http.IncomingHttpHeaders = {}
      const server = await startServer((h) => {
        received = h
      })
      try {
        const storage = new UrlStorage(
          {
            type: 'url',
            url: baseUrl(server),
            method: 'get',
            headers: {
              range: 'bytes=0-10',
              authorization: 'Bearer secret-token',
              cookie: 'session=abc',
              'x-typesense-api-key': 'super-secret'
            }
          } as any,
          {
            unsafeURLs: [],
            fileInfoAllowedHeaders: [],
            allowedPrivateUrlRanges: ['127.0.0.1/32']
          } as any
        )
        storage.markHeadersUntrusted()
        await storage.fetchSpecificFileMetadata(storage.getFile(), false)
        // allow-listed header forwarded
        expect(received.range).to.equal('bytes=0-10')
        // everything else dropped
        expect(received.authorization).to.equal(undefined)
        expect(received.cookie).to.equal(undefined)
        expect(received['x-typesense-api-key']).to.equal(undefined)
      } finally {
        await stopServer(server)
      }
    })

    it('FILEINFO_ALLOWED_HEADERS widens the allow-list', async () => {
      let received: http.IncomingHttpHeaders = {}
      const server = await startServer((h) => {
        received = h
      })
      try {
        const storage = new UrlStorage(
          {
            type: 'url',
            url: baseUrl(server),
            method: 'get',
            headers: {
              'x-custom-pass': 'let-me-in',
              authorization: 'Bearer secret-token'
            }
          } as any,
          {
            unsafeURLs: [],
            fileInfoAllowedHeaders: ['x-custom-pass'],
            allowedPrivateUrlRanges: ['127.0.0.1/32']
          } as any
        )
        storage.markHeadersUntrusted()
        await storage.fetchSpecificFileMetadata(storage.getFile(), false)
        expect(received['x-custom-pass']).to.equal('let-me-in')
        // the default drops still apply
        expect(received.authorization).to.equal(undefined)
      } finally {
        await stopServer(server)
      }
    })

    it('strips non-allow-listed headers on the download (getReadableStream) path too', async () => {
      let received: http.IncomingHttpHeaders = {}
      const server = await startServer((h) => {
        received = h
      })
      try {
        const storage = new UrlStorage(
          {
            type: 'url',
            url: baseUrl(server),
            method: 'get',
            headers: { range: 'bytes=0-5', authorization: 'Bearer leak' }
          } as any,
          {
            unsafeURLs: [],
            fileInfoAllowedHeaders: [],
            allowedPrivateUrlRanges: ['127.0.0.1/32']
          } as any
        )
        storage.markHeadersUntrusted()
        const { stream } = await storage.getReadableStream()
        // drain so the request completes
        await new Promise<void>((resolve) => {
          ;(stream as Readable).on('data', () => {})
          ;(stream as Readable).on('end', () => resolve())
          ;(stream as Readable).on('error', () => resolve())
        })
        expect(received.range).to.equal('bytes=0-5')
        expect(received.authorization).to.equal(undefined)
      } finally {
        await stopServer(server)
      }
    })

    it('does NOT filter trusted (DDO-sourced, unmarked) headers', async () => {
      // Regression for the review finding: download / compute-input / did+serviceId paths
      // carry publisher-set headers from a decrypted DDO (e.g. an Authorization for a
      // protected URL asset). Those must pass through untouched — only the raw-`file`
      // fileInfo path marks headers untrusted.
      let received: http.IncomingHttpHeaders = {}
      const server = await startServer((h) => {
        received = h
      })
      try {
        const storage = new UrlStorage(
          {
            type: 'url',
            url: baseUrl(server),
            method: 'get',
            headers: { authorization: 'Bearer legit-asset-token', range: 'bytes=0-5' }
          } as any,
          {
            unsafeURLs: [],
            fileInfoAllowedHeaders: [],
            allowedPrivateUrlRanges: ['127.0.0.1/32']
          } as any
        )
        // NOT marked untrusted -> headers forwarded as-is
        const { stream } = await storage.getReadableStream()
        await new Promise<void>((resolve) => {
          ;(stream as Readable).on('data', () => {})
          ;(stream as Readable).on('end', () => resolve())
          ;(stream as Readable).on('error', () => resolve())
        })
        expect(received.authorization).to.equal('Bearer legit-asset-token')
        expect(received.range).to.equal('bytes=0-5')
      } finally {
        await stopServer(server)
      }
    })
  })
})
