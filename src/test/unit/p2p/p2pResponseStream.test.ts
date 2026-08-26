import { expect } from 'chai'
import { Readable } from 'stream'
import { streamPair } from '@libp2p/utils'
import type { Connection, Stream } from '@libp2p/interface'
import {
  LP_MAX_BUFFER_BYTES,
  LP_MAX_FRAME_BYTES,
  LP_MAX_LENGTH_PREFIX_BYTES,
  LP_PAUSE_BUFFER_BYTES,
  LP_RESUME_BELOW_BYTES,
  handleProtocolCommands,
  lpFramedStream
} from '../../../components/P2P/handleProtocolCommands.js'
import { OceanP2P } from '../../../components/P2P/index.js'
import { P2PCommandResponse } from '../../../@types/OceanNode.js'
import { sleep } from './lpTestUtils.js'

/**
 * Both ends of the command protocol, over a real `streamPair`: the shipped responder on one
 * side and the shipped client on the other. No framing, no transport and no response iteration
 * is re-implemented here, so what these tests exercise is what runs on the wire.
 */

let peerCounter = 0

/** A responder whose only interesting part is the handler under test. */
function responderFor(handle: () => Promise<P2PCommandResponse>): OceanP2P {
  return {
    getConfig: () => ({
      denyList: { peers: [] as string[], ips: [] as string[] },
      // deliberately far above anything the suite can accumulate: these tests are about the
      // response body, not about rate limiting
      rateLimit: 1_000_000,
      maxConnections: 1_000_000
    }),
    getCoreHandlers: () => ({ getHandler: () => ({ handle }) })
  } as unknown as OceanP2P
}

/** A distinct remote address per exchange, so the shared rate-limit table cannot bleed. */
function incomingConnection(): Connection {
  peerCounter++
  return {
    remotePeer: { toString: () => `12D3KooTestPeer${peerCounter}` },
    remoteAddr: {
      toString: () => `/ip4/10.255.0.${peerCounter % 250}/tcp/${peerCounter}`
    }
  } as unknown as Connection
}

async function exchange(
  handle: () => Promise<P2PCommandResponse>
): Promise<{ client: Stream; response: Awaited<ReturnType<OceanP2P['send']>> }> {
  const [client, server] = await streamPair()
  void handleProtocolCommands.call(responderFor(handle), server, incomingConnection())
  const response = await OceanP2P.prototype.send.call(
    {} as OceanP2P,
    client,
    JSON.stringify({ command: 'testCommand' }),
    { signal: AbortSignal.timeout(15_000) }
  )
  return { client, response }
}

describe('P2P response body: a consumer slower than the peer must still get all of it', () => {
  /**
   * 64 KiB is the frame size real transfers arrive at (a source stream's high-water mark), and
   * 80 of them is 5 MiB: the smallest round payload that clears the 4 MiB read-buffer ceiling
   * the library defaults to, with enough margin that scheduling jitter cannot leave the run
   * under it. Past that ceiling the transport used to discard its whole backlog silently, which
   * desynchronised the frame parser and delivered corrupt out-of-sequence frames. Going bigger
   * would only make the test slower, not the mechanism clearer.
   */
  const CHUNK_BYTES = 64 * 1024
  const CHUNK_COUNT = 80

  it('delivers a body past the read-buffer ceiling complete and in order', async () => {
    const { response } = await exchange(() =>
      Promise.resolve({
        status: { httpStatus: 200 },
        stream: Readable.from(
          (function* () {
            for (let index = 0; index < CHUNK_COUNT; index++) {
              const chunk = Buffer.alloc(CHUNK_BYTES)
              // every chunk carries its own sequence number, so a reordered or corrupt frame is
              // caught rather than being hidden by a byte total that happens to add up
              chunk.writeUInt32BE(index, 0)
              yield chunk
            }
          })()
        )
      })
    )

    expect(response.status.httpStatus).to.equal(200)

    let received = 0
    let expectedIndex = 0
    for await (const chunk of response.stream) {
      const bytes = Buffer.from(chunk)
      expect(bytes.byteLength).to.equal(CHUNK_BYTES)
      expect(bytes.readUInt32BE(0)).to.equal(expectedIndex)
      expectedIndex++
      received += bytes.byteLength
      // consume slower than the responder produces, which is the condition under which the
      // backlog builds up at all
      await sleep(5)
    }

    expect(expectedIndex).to.equal(CHUNK_COUNT)
    expect(received).to.equal(CHUNK_BYTES * CHUNK_COUNT)
  })
})

describe('The limits that keep a paused stream from dropping its backlog stay coordinated', () => {
  /**
   * Four limits have to agree for a slow consumer to be safe, and three of them are only ever
   * reached under backpressure - which is why the transfer above cannot exercise the fourth.
   * The relations below are what make the arrangement sound, so they are asserted directly:
   * loosening any one of them silently reintroduces the discard that hands out corrupt frames.
   */
  it('lets a resume flush land without overrunning the read-buffer ceiling', () => {
    // a resume can flush a full pause buffer on top of a backlog already at the resume mark
    expect(LP_MAX_BUFFER_BYTES).to.be.at.least(
      LP_PAUSE_BUFFER_BYTES + LP_RESUME_BELOW_BYTES
    )
  })

  it('leaves a paused reader able to complete a frame out of the backlog it already holds', () => {
    // while paused the only way to make progress is to finish a frame already buffered, so the
    // mark cannot sit below one maximum-size frame and its prefix
    expect(LP_RESUME_BELOW_BYTES).to.be.at.least(
      LP_MAX_FRAME_BYTES + LP_MAX_LENGTH_PREFIX_BYTES
    )
    expect(LP_PAUSE_BUFFER_BYTES).to.be.at.least(LP_MAX_FRAME_BYTES)
  })

  it('raises the transport buffer of every stream it wraps', async () => {
    const [, local] = await streamPair()
    // the library default stops at 4 MiB while the muxer window grows to 16 MiB, so pausing a
    // stream that had been going fast reset it
    expect(local.maxReadBufferLength).to.be.lessThan(LP_PAUSE_BUFFER_BYTES)
    lpFramedStream(local)
    expect(local.maxReadBufferLength).to.equal(LP_PAUSE_BUFFER_BYTES)
  })
})

describe('P2P response body: a failure mid-body must never read as a complete 200', () => {
  it('reaches the client as an error when the source fails after the status frame', async () => {
    const { response } = await exchange(() =>
      Promise.resolve({
        status: { httpStatus: 200 },
        stream: Readable.from(
          (async function* () {
            yield Buffer.from('part-one')
            yield Buffer.from('part-two')
            throw new Error('source exploded mid-body')
          })()
        )
      })
    )

    // the status is already committed at this point - it went out before the body started
    expect(response.status.httpStatus).to.equal(200)

    let body = ''
    let failure: Error | undefined
    try {
      for await (const chunk of response.stream) {
        body += Buffer.from(chunk).toString()
      }
    } catch (err) {
      failure = err as Error
    }

    // The responder must reset the stream rather than write one more well-formed frame: an
    // error frame here is indistinguishable from body, so the client would return a short
    // payload with a JSON error glued onto it under the 200 that was already sent.
    expect(
      failure,
      'a mid-body failure was reported as a complete response'
    ).to.be.instanceOf(Error)
    expect(body).to.equal('part-onepart-two')
  })

  it('still answers with a proper error response when the failure precedes the status frame', async () => {
    const { response } = await exchange(() =>
      Promise.reject(new Error('handler refused the command'))
    )

    expect(response.status.httpStatus).to.equal(500)
    expect(response.status.error).to.equal('handler refused the command')

    // and the error response itself is a clean, complete exchange - not a reset
    let failure: Error | undefined
    try {
      for await (const chunk of response.stream) {
        expect(chunk).to.equal(undefined, 'an error response must carry no body frames')
      }
    } catch (err) {
      failure = err as Error
    }
    expect(failure).to.equal(undefined)
  })
})
