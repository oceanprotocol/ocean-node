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
import { lpStream } from '@libp2p/utils'
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

/** Serialize any thrown value for debugging (Error, Event, plain object). */
function serializeErrorForDebug(err: unknown): Record<string, unknown> {
  try {
    if (err instanceof Error) {
      return { name: err.name, message: err.message, stack: err.stack }
    }
    if (err != null && typeof err === 'object') {
      const o = err as Record<string, unknown>
      const out: Record<string, unknown> = {}
      for (const key of Object.keys(o)) {
        try {
          const v = o[key]
          if (v === null || typeof v !== 'object' || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
            out[key] = v
          } else {
            out[key] = String(v)
          }
        } catch {
          out[key] = '[unserializable]'
        }
      }
      return out
    }
    return { value: err }
  } catch {
    return { raw: String(err) }
  }
}

export async function handleProtocolCommands(stream: Stream, connection: Connection) {
  const { remotePeer, remoteAddr } = connection

  // Pause the stream. We do async operations here before writing.
  stream.pause()

  P2P_LOGGER.logMessage('Incoming connection from peer ' + remotePeer, true)
  P2P_LOGGER.logMessage('Using ' + remoteAddr, true)

  // Resume and use length-prefixed messages (libp2p v3 byteStream migration)
  stream.resume()
  const lp = lpStream(stream)
  const readWriteSignal = () => AbortSignal.timeout(30_000)

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
      const status = errorDebug ? { httpStatus, error, errorDebug } : { httpStatus, error }
      await lp.write(uint8ArrayFromString(JSON.stringify(status)), {
        signal: readWriteSignal()
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

  let task: Command
  try {
    const cmdBytes = await lp.read({ signal: readWriteSignal() })
    const str = uint8ArrayToString(cmdBytes.subarray())
    task = JSON.parse(str) as Command
  } catch (err) {
    P2P_LOGGER.log(
      LOG_LEVELS_STR.LEVEL_ERROR,
      `Unable to process P2P command: ${err?.message ?? err}`
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

    // Send status first (length-prefixed)
    await lp.write(uint8ArrayFromString(JSON.stringify(response.status)), {
      signal: readWriteSignal()
    })

    // Stream data chunks as length-prefixed messages
    if (response.stream) {
      for await (const chunk of response.stream as Readable) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        await lp.write(bytes, { signal: readWriteSignal() })
      }
    }

    await stream.close()
  } catch (err) {
    const errMessage = (() => {
      if (err instanceof Error) return err.message
      if (err != null && typeof err === 'object' && 'type' in err) {
        const e = err as { type?: string; message?: string }
        return e.message ?? `Event: ${e.type ?? 'unknown'}`
      }
      return err != null ? String(err) : 'Unknown error'
    })()
    const errorDebug = serializeErrorForDebug(err)
    P2P_LOGGER.logMessageWithEmoji(
      'handleProtocolCommands Error: ' + errMessage,
      true,
      GENERIC_EMOJIS.EMOJI_CROSS_MARK,
      LOG_LEVELS_STR.LEVEL_ERROR
    )
    P2P_LOGGER.error('handleProtocolCommands error object (debug): ' + JSON.stringify(errorDebug))
    await sendErrorAndClose(500, errMessage, errorDebug)
  }
}
