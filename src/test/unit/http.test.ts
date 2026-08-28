import { expect } from 'chai'
import http, { Server } from 'http'
import { AddressInfo } from 'net'
import { Readable } from 'stream'
import { gzipSync } from 'zlib'
import { fetchStream, fetchHeadersTimeout, headersToObject } from '../../utils/http.js'

// spin up a throwaway local http server on an ephemeral port
function startServer(handler: http.RequestListener): Promise<Server> {
  return new Promise((resolve) => {
    const server = http.createServer(handler)
    server.listen(0, () => resolve(server))
  })
}

function baseUrl(server: Server): string {
  const { port } = server.address() as AddressInfo
  return `http://127.0.0.1:${port}`
}

function stopServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    // drop any hung/keep-alive sockets so close() actually resolves
    server.closeAllConnections()
    server.close(() => resolve())
  })
}

async function collect(stream: Readable): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk))
  }
  return Buffer.concat(chunks).toString('utf8')
}

describe('utils/http', () => {
  describe('headersToObject', () => {
    it('produces a plain object with lowercase keys (Object.entries-friendly)', () => {
      const headers = new Headers({
        'X-Foo': 'bar',
        'Content-Type': 'application/json'
      })
      const obj = headersToObject(headers)
      expect(obj).to.deep.equal({
        'x-foo': 'bar',
        'content-type': 'application/json'
      })
      // consumers (downloadHandler) iterate with Object.entries — must work
      expect(Object.entries(obj)).to.have.length(2)
    })
  })

  describe('fetchStream', () => {
    let server: Server
    afterEach(async () => {
      if (server) await stopServer(server)
    })

    it('returns a working Node Readable and a plain headers object on 2xx', async () => {
      server = await startServer((req, res) => {
        res.writeHead(200, { 'content-type': 'text/plain', 'x-custom': 'yes' })
        res.end('hello world')
      })
      const { httpStatus, stream, headers } = await fetchStream(baseUrl(server))
      expect(httpStatus).to.equal(200)
      expect(stream).to.be.instanceOf(Readable)
      expect(headers['content-type']).to.equal('text/plain')
      expect(headers['x-custom']).to.equal('yes')
      const body = await collect(stream)
      expect(body).to.equal('hello world')
    })

    it('decodes a gzip body and strips the stale content-encoding/length headers', async () => {
      const payload = 'the quick brown fox '.repeat(50)
      const gz = gzipSync(Buffer.from(payload))
      server = await startServer((req, res) => {
        res.writeHead(200, {
          'content-type': 'text/plain',
          'content-encoding': 'gzip',
          'content-length': String(gz.length)
        })
        res.end(gz)
      })
      const { stream, headers } = await fetchStream(baseUrl(server))
      // undici already decoded the body — the re-served headers must not still
      // advertise gzip, or a downstream client double-decompresses and fails
      expect(headers).to.not.have.property('content-encoding')
      expect(headers).to.not.have.property('content-length')
      const body = await collect(stream)
      expect(body).to.equal(payload)
    })

    it('throws on a non-2xx status (axios throw-on-non-2xx contract)', async () => {
      server = await startServer((req, res) => {
        res.writeHead(404, { 'content-type': 'text/plain' })
        res.end('nope')
      })
      let threw = false
      try {
        await fetchStream(baseUrl(server))
      } catch (err: any) {
        threw = true
        expect(err.message).to.contain('404')
      }
      expect(threw).to.equal(true)
    })
  })

  describe('fetchHeadersTimeout', () => {
    let server: Server
    afterEach(async () => {
      if (server) await stopServer(server)
    })

    it('aborts when headers never arrive within the timeout', async () => {
      // handler intentionally never responds
      server = await startServer(() => {})
      let threw = false
      try {
        await fetchHeadersTimeout(baseUrl(server), { method: 'GET' }, 150)
      } catch (err: any) {
        threw = true
        // undici surfaces the abort as an AbortError / "aborted"
        expect(String(err.name + err.message).toLowerCase()).to.match(
          /abort|headers timeout/
        )
      }
      expect(threw).to.equal(true)
    })

    it('does NOT abort a slow body once headers have arrived', async () => {
      // headers flush immediately, then the body drips out over ~250ms,
      // which is well past the 100ms headers timeout — the full body must
      // still arrive because the timer is cleared once headers resolve.
      server = await startServer((req, res) => {
        res.writeHead(200, { 'content-type': 'text/plain' })
        res.flushHeaders()
        let i = 0
        const iv = setInterval(() => {
          if (i >= 5) {
            clearInterval(iv)
            res.end()
            return
          }
          res.write(`chunk${i}`)
          i++
        }, 50)
      })
      const response = await fetchHeadersTimeout(baseUrl(server), { method: 'GET' }, 100)
      expect(response.status).to.equal(200)
      const body = await collect(Readable.fromWeb(response.body as any))
      expect(body).to.equal('chunk0chunk1chunk2chunk3chunk4')
    })
  })
})
