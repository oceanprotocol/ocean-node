import { Readable } from 'stream'
import { toString as uint8ArrayToString } from 'uint8arrays/to-string'
import { fromString as uint8ArrayFromString } from 'uint8arrays/from-string'

import { P2P_LOGGER } from '../../utils/logging/common.js'
import { Command } from '../../@types/commands.js'
import { P2PCommandResponse } from '../../@types/OceanNode'
import { GENERIC_EMOJIS, LOG_LEVELS_STR } from '../../utils/logging/Logger.js'
import { BaseHandler } from '../core/handler/handler.js'
import { getConfiguration } from '../../utils/index.js'
import {
  checkGlobalConnectionsRateLimit,
  checkRequestsRateLimit
} from '../../utils/validators.js'
import type { Connection, Stream } from '@libp2p/interface'

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

export async function handleProtocolCommands(stream: Stream, connection: Connection) {
  const { remotePeer, remoteAddr } = connection

  // Pause the stream. We do async operations here before writing.
  stream.pause()

  P2P_LOGGER.logMessage('Incoming connection from peer ' + remotePeer, true)
  P2P_LOGGER.logMessage('Using ' + remoteAddr, true)

  const sendErrorAndClose = async (httpStatus: number, error: string) => {
    try {
      // Check if stream is already closed
      if (stream.status === 'closed' || stream.status === 'closing') {
        P2P_LOGGER.warn('Stream already closed, cannot send error response')
        return
      }

      // Resume stream in case it's paused - we need to write
      stream.resume()
      const status = { httpStatus, error }
      stream.send(uint8ArrayFromString(JSON.stringify(status)))
      await stream.close()
    } catch (e) {
      P2P_LOGGER.error(`Error sending error response: ${e.message}`)
      try {
        stream.abort(e as Error)
      } catch {}
    }
  }

  // Rate limiting and deny list checks
  const configuration = await getConfiguration()
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

  // Resume the stream. We can now write.
  stream.resume()

  // v3 streams are AsyncIterable
  let task: Command
  try {
    for await (const chunk of stream) {
      try {
        const str = uint8ArrayToString(chunk.subarray())
        task = JSON.parse(str) as Command
      } catch (e) {
        await sendErrorAndClose(400, 'Invalid command')
        return
      }
    }
  } catch (err) {
    P2P_LOGGER.log(
      LOG_LEVELS_STR.LEVEL_ERROR,
      `Unable to process P2P command: ${err.message}`
    )
    await sendErrorAndClose(400, 'Invalid command')
    return
  }

  if (!task) {
    P2P_LOGGER.error('Invalid or missing task/command data!')
    await sendErrorAndClose(400, 'Invalid command')
    return
  }

  P2P_LOGGER.logMessage('Performing P2P task: ' + JSON.stringify(task), true)

  // Get and execute handler
  const handler: BaseHandler = this.getCoreHandlers().getHandler(task.command)
  if (!handler) {
    await sendErrorAndClose(501, `No handler found for command: ${task.command}`)
    return
  }

  try {
    task.caller = remotePeer.toString()
    const response: P2PCommandResponse = await handler.handle(task)

    // Send status first
    stream.send(uint8ArrayFromString(JSON.stringify(response.status)))

    // Stream data chunks without buffering, with backpressure support
    if (response.stream) {
      for await (const chunk of response.stream as Readable) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)

        // Handle backpressure - if send returns false, wait for drain
        if (!stream.send(bytes)) {
          await stream.onDrain({
            signal: AbortSignal.timeout(30000) // 30 second timeout for drain
          })
        }
      }
    }

    await stream.close()
  } catch (err) {
    P2P_LOGGER.logMessageWithEmoji(
      'handleProtocolCommands Error: ' + err.message,
      true,
      GENERIC_EMOJIS.EMOJI_CROSS_MARK,
      LOG_LEVELS_STR.LEVEL_ERROR
    )
    await sendErrorAndClose(500, err.message)
  }
}
