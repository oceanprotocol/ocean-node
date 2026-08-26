import { expect } from 'chai'
import { LP_MAX_FRAME_BYTES } from '../../../components/P2P/handleProtocolCommands.js'
import {
  framedPair,
  lpFrame,
  readSignal,
  readUntilEnd,
  sleep,
  varintBytes
} from './lpTestUtils.js'

/**
 * The frame reader has one job that no error message can do for it: telling a peer that closed
 * on a frame boundary apart from a peer that closed in the middle of one. The library raises the
 * *same* error type for both, so if the reader gets this wrong a cut-short download or compute
 * result is handed back to the caller as a complete body under the status the peer already sent.
 *
 * Every case below runs over a real `streamPair`, writing raw bytes so the malformed shapes are
 * exactly what a hostile or crashing peer puts on the wire.
 */
describe('P2P length-prefixed frames: clean end of stream vs truncated transfer', () => {
  it('reports a clean end when the peer closes exactly on a frame boundary', async () => {
    const { peer, reader } = await framedPair()
    peer.send(lpFrame('hello'))
    peer.send(lpFrame('world'))
    await peer.close()

    const { frames, error, cleanEnd } = await readUntilEnd(reader)
    expect(frames.map((f) => Buffer.from(f).toString())).to.deep.equal(['hello', 'world'])
    expect(error.name).to.equal('UnexpectedEOFError')
    expect(reader.pendingBytes).to.equal(0)
    expect(cleanEnd).to.equal(true)
  })

  /**
   * The shape that defeated matching the error *message*: a single `0x01` byte declares a
   * one-byte frame, and the body read that follows is also a one-byte read, so the library
   * produces a message textually identical to the one it produces at a real frame boundary. Any
   * peer could truncate a response anywhere and have it accepted as complete by appending two
   * bytes.
   */
  it('rejects good frames followed by a stray length byte instead of accepting a short body', async () => {
    const { peer, reader } = await framedPair()
    peer.send(lpFrame('a complete frame'))
    peer.send(Uint8Array.from([0x01]))
    await peer.close()

    const { frames, error, cleanEnd } = await readUntilEnd(reader)
    expect(frames.map((f) => Buffer.from(f).toString())).to.deep.equal([
      'a complete frame'
    ])
    expect(error.name).to.equal('UnexpectedEOFError')
    expect(reader.pendingBytes).to.equal(1)
    expect(cleanEnd).to.equal(false)
  })

  it('rejects a frame that declares more bytes than it sends', async () => {
    const { peer, reader } = await framedPair()
    peer.send(Buffer.concat([Buffer.from(varintBytes(10)), Buffer.from('abc')]))
    await peer.close()

    const { frames, error, cleanEnd } = await readUntilEnd(reader)
    expect(frames).to.have.lengthOf(0)
    expect(error.name).to.equal('UnexpectedEOFError')
    expect(reader.pendingBytes).to.be.greaterThan(0)
    expect(cleanEnd).to.equal(false)
  })

  it('rejects a partial multi-byte length prefix followed by a close', async () => {
    const { peer, reader } = await framedPair()
    peer.send(lpFrame('ok'))
    // 0x80 is a varint continuation byte: the length is announced as unfinished and then the
    // peer vanishes, so no frame can ever complete.
    peer.send(Uint8Array.from([0x80]))
    await peer.close()

    const { frames, error, cleanEnd } = await readUntilEnd(reader)
    expect(frames.map((f) => Buffer.from(f).toString())).to.deep.equal(['ok'])
    expect(error.name).to.equal('UnexpectedEOFError')
    expect(reader.pendingBytes).to.equal(1)
    expect(cleanEnd).to.equal(false)
  })

  it('hands over a zero-length terminator frame and still reports a clean end after it', async () => {
    const { peer, reader } = await framedPair()
    peer.send(lpFrame('data'))
    peer.send(lpFrame(new Uint8Array(0)))
    await peer.close()

    const { frames, error, cleanEnd } = await readUntilEnd(reader)
    expect(frames).to.have.lengthOf(2)
    expect(Buffer.from(frames[0]).toString()).to.equal('data')
    // The request-body loop uses an empty frame as its terminator, so it has to arrive as a
    // frame rather than being mistaken for the end of the stream.
    expect(frames[1].byteLength).to.equal(0)
    expect(error.name).to.equal('UnexpectedEOFError')
    expect(reader.pendingBytes).to.equal(0)
    expect(cleanEnd).to.equal(true)
  })

  it('accounts for a frame delivered one byte at a time across many transport messages', async () => {
    const { peer, reader } = await framedPair()
    const bytes = lpFrame('split across events')
    const trickle = (async () => {
      for (const byte of bytes) {
        peer.send(Uint8Array.from([byte]))
        await sleep(2)
      }
      await peer.close()
    })()

    const frame = await reader.read({ signal: readSignal() })
    expect(Buffer.from(frame).toString()).to.equal('split across events')
    await trickle

    const { frames, error, cleanEnd } = await readUntilEnd(reader)
    expect(frames).to.have.lengthOf(0)
    expect(error.name).to.equal('UnexpectedEOFError')
    // The byte count is kept per transport message, so a frame spread over 21 of them has to
    // still come out exactly accounted for.
    expect(reader.pendingBytes).to.equal(0)
    expect(cleanEnd).to.equal(true)
  })

  // The bytes a varint length prefix occupies change at each of these sizes, and the reader
  // recomputes the prefix width itself to charge it against the transport byte count. A prefix
  // charged one byte short or long makes every subsequent clean end look like a truncation, or
  // the reverse.
  for (const size of [127, 128, 16383, 16384]) {
    it(`accounts for the length prefix of a ${size}-byte frame`, async () => {
      const { peer, reader } = await framedPair()
      peer.send(lpFrame(Buffer.alloc(size, 0x41)))
      await peer.close()

      const frame = await reader.read({ signal: readSignal() })
      expect(frame.byteLength).to.equal(size)
      expect(reader.pendingBytes).to.equal(0)

      const { error, cleanEnd } = await readUntilEnd(reader)
      expect(error.name).to.equal('UnexpectedEOFError')
      expect(cleanEnd).to.equal(true)
    })
  }

  it('rejects a stream reset in the middle of a frame', async () => {
    const { peer, reader } = await framedPair()
    peer.send(lpFrame('first'))
    expect(Buffer.from(await reader.read({ signal: readSignal() })).toString()).to.equal(
      'first'
    )
    peer.send(Buffer.concat([Buffer.from(varintBytes(100)), Buffer.from('partial')]))
    await sleep(20)
    peer.abort(new Error('peer died mid-frame'))

    const { frames, error, cleanEnd } = await readUntilEnd(reader)
    expect(frames).to.have.lengthOf(0)
    expect(error.name).to.equal('StreamResetError')
    expect(cleanEnd).to.equal(false)
  })

  /**
   * The failure that made a 40 MiB transfer look complete. A transport abort - here the read
   * buffer being exceeded while a slow consumer holds the stream paused - discards whatever the
   * stream had buffered without ever dispatching it, so no `message` event is ever seen for
   * those bytes: the byte counters agree, nothing is pending, and the end of file that follows
   * is indistinguishable from a clean one. Recording the close error is the only thing that
   * tells the two apart.
   */
  it('rejects a transfer the transport aborted even though every delivered byte was accounted for', async () => {
    const { peer, local, reader } = await framedPair()
    // The protocol raises this ceiling; putting it back to a small value is what lets the test
    // reach an overflow in a few kilobytes instead of tens of megabytes.
    local.maxReadBufferLength = 4096
    peer.send(lpFrame('first'))
    await sleep(10)
    expect(Buffer.from(await reader.read({ signal: readSignal() })).toString()).to.equal(
      'first'
    )

    local.pause()
    for (let index = 0; index < 20; index++) {
      peer.send(lpFrame(Buffer.alloc(1024, 0x41)))
    }
    await sleep(80)
    expect(local.status).to.equal('aborted')

    const { error, cleanEnd } = await readUntilEnd(reader)
    // the give-away: an end-of-file error with a byte count that balances perfectly
    expect(error.name).to.equal('UnexpectedEOFError')
    expect(reader.pendingBytes).to.equal(0)
    expect(cleanEnd, 'an aborted transfer was reported as a complete one').to.equal(false)
  })

  it('rejects a transfer whose stream was aborted locally between frames', async () => {
    const { peer, local, reader } = await framedPair()
    peer.send(lpFrame('first'))
    await sleep(10)
    expect(Buffer.from(await reader.read({ signal: readSignal() })).toString()).to.equal(
      'first'
    )
    local.abort(new Error('local failure while the body was still expected'))

    const { error, cleanEnd } = await readUntilEnd(reader)
    expect(error.name).to.equal('UnexpectedEOFError')
    expect(reader.pendingBytes).to.equal(0)
    expect(cleanEnd).to.equal(false)
  })

  it('refuses a frame declaring more than the largest frame this protocol accepts', async () => {
    const { peer, reader } = await framedPair()
    peer.send(Buffer.from(varintBytes(LP_MAX_FRAME_BYTES + 1)))
    peer.send(Buffer.alloc(64, 0x42))

    const { error, cleanEnd } = await readUntilEnd(reader)
    // An explicit maxDataLength is what turns this into a named error instead of a read that
    // keeps buffering towards a length nothing will ever satisfy.
    expect(error.name).to.equal('InvalidDataLengthError')
    expect(cleanEnd).to.equal(false)
  })
})
