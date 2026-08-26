import { Readable } from 'stream'
import { toString as uint8ArrayToString } from 'uint8arrays/to-string'
import { fromString as uint8ArrayFromString } from 'uint8arrays/from-string'

import { P2P_LOGGER } from '../../utils/logging/common.js'
import { Command } from '../../@types/commands.js'
import { P2PCommandResponse } from '../../@types/OceanNode'
import { GENERIC_EMOJIS, LOG_LEVELS_STR } from '../../utils/logging/Logger.js'
import { BaseHandler } from '../core/handler/handler.js'
import {
  checkGlobalConnectionsRateLimit,
  checkRequestsRateLimit
} from '../../utils/validators.js'
import type { Connection, Stream } from '@libp2p/interface'
import {
  LP_RESUME_BELOW_BYTES,
  LpFrameReader,
  lpFramedStream,
  pauseReads,
  resumeReads
} from './lpFraming.js'
// type-only, so this does not create a runtime cycle with index.ts
import type { OceanP2P } from './index.js'

export class ReadableString extends Readable {
  private sent = false

  constructor(private str: string) {
    super()
  }

  _read() {
    if (!this.sent) {
      this.push(Buffer.from(this.str))
      this.sent = true
    } else {
      this.push(null)
    }
  }
}

// `this` is the OceanP2P instance: libp2p receives this as
// `handleProtocolCommands.bind(this)` (see index.ts, createNode)
export async function handleProtocolCommands(
  this: OceanP2P,
  stream: Stream,
  connection: Connection
) {
  const { remotePeer, remoteAddr } = connection

  // Pause the stream. We do async operations here before writing.
  stream.pause()

  P2P_LOGGER.logMessage('Incoming connection from peer ' + remotePeer, true)
  P2P_LOGGER.logMessage('Using ' + remoteAddr, true)

  stream.resume()
  const lp = lpFramedStream(stream)
  // Same tick as `lpStream`, so the reader's byte accounting cannot miss a message: nothing can
  // be dispatched between the two `message` listeners attaching. Reads go through this rather
  // than through `lp` directly so that the request-body loop below can see how large a backlog
  // it is holding and throttle the peer accordingly.
  const frames = new LpFrameReader(lp, stream)
  const handshakeSignal = () => AbortSignal.timeout(30_000)
  const dataWriteSignal = () => AbortSignal.timeout(30 * 60_000)

  const sendErrorAndClose = async (
    httpStatus: number,
    error: string,
    errorDebug?: Record<string, unknown>
  ) => {
    try {
      if (stream.status === 'closed' || stream.status === 'closing') {
        P2P_LOGGER.warn('Stream already closed, cannot send error response')
        return
      }
      const status = errorDebug
        ? { httpStatus, error, errorDebug }
        : { httpStatus, error }
      await lp.write(uint8ArrayFromString(JSON.stringify(status)), {
        signal: handshakeSignal()
      })
      await stream.close()
    } catch (e) {
      const msg = e instanceof Error ? e.message : e != null ? String(e) : 'Unknown error'
      P2P_LOGGER.error(`Error sending error response: ${msg}`)
      try {
        stream.abort(e as Error)
      } catch {}
    }
  }

  // Read the command first so the client always gets a response after writing.
  // Rate limiting checks happen after reading to maintain the write→read protocol order.
  let task: Command
  try {
    const cmdBytes = await frames.read({ signal: handshakeSignal() })
    const str = uint8ArrayToString(cmdBytes)
    task = JSON.parse(str) as Command
  } catch (err) {
    P2P_LOGGER.log(
      LOG_LEVELS_STR.LEVEL_ERROR,
      `Unable to process P2P command: ${err?.message ?? err}`
    )
    await sendErrorAndClose(400, 'Invalid command')
    return
  }

  // Rate limiting and deny list checks (after reading command)
  const configuration = this.getConfig()
  const { denyList } = configuration

  if (denyList.peers.includes(remotePeer.toString())) {
    P2P_LOGGER.warn(`Incoming request denied to peer: ${remotePeer} (peer on deny list)`)
    await sendErrorAndClose(403, 'Unauthorized request')
    return
  }

  const now = Date.now()
  const rateLimitCheck = checkRequestsRateLimit(remoteAddr.toString(), configuration, now)
  if (!rateLimitCheck.valid) {
    P2P_LOGGER.warn(
      `Incoming request denied to peer: ${remotePeer} (rate limit exceeded)`
    )
    await sendErrorAndClose(403, 'Rate limit exceeded')
    return
  }

  const connectionsRateValidation = checkGlobalConnectionsRateLimit(configuration, now)
  if (!connectionsRateValidation.valid) {
    P2P_LOGGER.warn(
      `Exceeded limit of connections per minute ${configuration.maxConnections}: ${connectionsRateValidation.error}`
    )
    await sendErrorAndClose(403, 'Rate limit exceeded')
    return
  }

  if (!task) {
    P2P_LOGGER.error('Invalid or missing task/command data!')
    await sendErrorAndClose(400, 'Invalid command')
    return
  }

  const taskRecord = task as unknown as Record<string, unknown>
  if (taskRecord.p2pStreamBody === true) {
    delete taskRecord.p2pStreamBody

    // Nothing reads this stream between here and the handler's first pull, and that gap is
    // asynchronous - the handler may do database or chain work first - so hold the transport
    // until the generator actually asks for a frame. Otherwise a whole request body can pile
    // up unread in the meantime and be dropped.
    pauseReads(stream)

    // True streaming: expose an async Readable that reads LP frames lazily
    // as the handler consumes it. Frames are terminated by an empty chunk.
    taskRecord.stream = Readable.from(
      (async function* () {
        try {
          while (true) {
            // Flow control. Reads are held while the handler is busy with a frame, and are only
            // let go again once the backlog we are already holding has drained below the mark -
            // see `LP_RESUME_BELOW_BYTES`. Without this the backlog grows at the sender's pace
            // and is silently discarded past `maxBufferSize`; and because the frame parser then
            // desynchronises, garbage that happens to decode as a zero length terminates this
            // loop as if the body had ended, so the handler sees a short body and no error at
            // all.
            if (frames.pendingBytes <= LP_RESUME_BELOW_BYTES) {
              resumeReads(stream)
            }
            const frame = await frames.read({ signal: handshakeSignal() })
            pauseReads(stream)
            const buf = Buffer.from(frame)

            if (buf.length === 0) {
              break
            }

            yield buf
          }
        } finally {
          // Whatever ended the loop - terminator, error, or a handler that stopped consuming -
          // the read side must not be left paused.
          resumeReads(stream)
        }
      })()
    )
  }

  const logPayload = { ...taskRecord }
  // Avoid JSON-stringifying the request stream itself.
  if (logPayload.stream) {
    logPayload.stream = '[request stream]'
  }
  if (Buffer.isBuffer(logPayload.rawData)) {
    logPayload.rawData = `[${logPayload.rawData.length} bytes]`
  }
  P2P_LOGGER.logMessage('Performing P2P task: ' + JSON.stringify(logPayload), true)

  // Get and execute handler
  const handler: BaseHandler = this.getCoreHandlers().getHandler(task.command)
  if (!handler) {
    await sendErrorAndClose(501, `No handler found for command: ${task.command}`)
    return
  }

  // Once we have started writing the status frame the response is committed: the client has
  // been told the outcome and everything after it is body. An error frame written at that point
  // lands as one more well-formed body frame followed by a clean close, which no client can
  // distinguish from a complete response - the payload comes out short with a JSON error object
  // appended to it, under the `httpStatus: 200` that was already sent. Unlike the request
  // direction, the response direction has no terminator frame and no declared length, so byte
  // accounting cannot see it either. After this point a failure must reset the stream.
  let statusWritten = false
  try {
    task.caller = remotePeer.toString()
    const response: P2PCommandResponse = await handler.handle(task)

    // Send status first (length-prefixed)
    statusWritten = true
    await lp.write(uint8ArrayFromString(JSON.stringify(response.status)), {
      signal: handshakeSignal()
    })

    // Stream data chunks as length-prefixed messages
    if (response.stream) {
      for await (const chunk of response.stream as Readable) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        await lp.write(bytes, { signal: dataWriteSignal() })
      }
    }

    await stream.close()
  } catch (err) {
    P2P_LOGGER.logMessageWithEmoji(
      'handleProtocolCommands Error: ' +
        (err instanceof Error ? err.message : String(err)),
      true,
      GENERIC_EMOJIS.EMOJI_CROSS_MARK,
      LOG_LEVELS_STR.LEVEL_ERROR
    )
    const httpStatus =
      typeof (err as any)?.status === 'number' ? (err as any).status : 500
    const msg = err instanceof Error ? err.message : String(err)
    if (statusWritten) {
      try {
        stream.abort(err instanceof Error ? err : new Error(msg))
      } catch {}
      return
    }
    // Still before the status frame, so a proper error response is exactly right here.
    await sendErrorAndClose(httpStatus, msg)
  }
}
