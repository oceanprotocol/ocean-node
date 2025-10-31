import { pipe } from 'it-pipe'
import { Readable } from 'stream'
import { toString as uint8ArrayToString } from 'uint8arrays/to-string'

import { P2P_LOGGER } from '../../utils/logging/common.js'
import { Command } from '../../@types/commands.js'
import { P2PCommandResponse } from '../../@types/OceanNode'
import { GENERIC_EMOJIS, LOG_LEVELS_STR } from '../../utils/logging/Logger.js'
import StreamConcat from 'stream-concat'
import { BaseHandler } from '../core/handler/handler.js'
import { getConfiguration } from '../../utils/index.js'
import {
  checkGlobalConnectionsRateLimit,
  checkRequestsRateLimit
} from '../../utils/validators.js'

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

// close the stream after sending data, libp2p will handle stream status
async function closeStreamConnection(connection: any, remotePeer: string) {
  if (connection) {
    try {
      P2P_LOGGER.debug('Closing connection to remote peer:' + remotePeer)
      await connection.close()
    } catch (e) {
      P2P_LOGGER.error(`Error closing connection for peer ${remotePeer}: ${e.message}`)
    }
  }
}

export async function handleProtocolCommands(stream: any, connection: any) {
  console.log('handleProtocolCommands called')
  console.log(stream)
  console.log(connection)
  const { remotePeer, remoteAddr } = connection
  console.log('remotePeer: ' + remotePeer)
  console.log('remoteAddr: ' + remoteAddr)
  // only write if stream is in 'open' status
  const connectionStatus = connection.status
  P2P_LOGGER.logMessage('Incoming connection from peer ' + remotePeer, true)
  P2P_LOGGER.logMessage('Using ' + remoteAddr, true)

  let status = null
  let task: Command
  let statusStream
  let sendStream = null

  const buildWrongCommandStatus = function (errorCode: number, message: string) {
    status = {
      httpStatus: errorCode,
      error: message
    }
    return status
  }

  const configuration = await getConfiguration()
  // check deny list configs
  const { denyList } = configuration
  if (denyList.peers.length > 0) {
    if (denyList.peers.includes(remotePeer.toString())) {
      P2P_LOGGER.warn(
        `Incoming request denied to peer: ${remotePeer} (peer its on deny list)`
      )

      if (connectionStatus === 'open') {
        try {
          stream.send(
            new TextEncoder().encode(
              JSON.stringify(buildWrongCommandStatus(403, 'Unauthorized request'))
            )
          )
        } catch (e) {
          P2P_LOGGER.error(e)
        }
      }
      await closeStreamConnection(connection, remotePeer)
      return
    }
  }
  // check connections rate limit
  const now = Date.now()

  const rateLimitCheck = checkRequestsRateLimit(remoteAddr, configuration, now)
  if (!rateLimitCheck.valid) {
    P2P_LOGGER.warn(
      `Incoming request denied to peer: ${remotePeer} (rate limit exceeded)`
    )
    if (connectionStatus === 'open') {
      try {
        stream.send(
          new TextEncoder().encode(
            JSON.stringify(buildWrongCommandStatus(403, 'Rate limit exceeded'))
          )
        )
      } catch (e) {
        P2P_LOGGER.error(e)
      }
    }
    await closeStreamConnection(connection, remotePeer)
    return
  }

  // check global rate limits (not ip related)
  const connectionsRateValidation = checkGlobalConnectionsRateLimit(configuration, now)
  if (!connectionsRateValidation.valid) {
    P2P_LOGGER.warn(
      `Exceeded limit of connections per minute ${configuration.maxConnections}: ${connectionsRateValidation.error}`
    )
    if (connectionStatus === 'open') {
      try {
        stream.send(
          new TextEncoder().encode(
            JSON.stringify(buildWrongCommandStatus(403, 'Rate limit exceeded'))
          )
        )
      } catch (e) {
        P2P_LOGGER.error(e)
      }
    }
    await closeStreamConnection(connection, remotePeer)
    return
  }

  try {
    // eslint-disable-next-line no-unreachable-loop
    console.log('stream')
    console.log(stream)
    for await (const chunk of stream) {
      console.log('chunk  received')
      console.log(chunk)
      try {
        const str = uint8ArrayToString(chunk.subarray())
        console.log('stringified chunk' + str)
        task = JSON.parse(str) as Command
        console.log('parsed task')
        console.log(task)
      } catch (e) {
        console.log('error parsing chunk')
        console.log(e)
        if (connectionStatus === 'open') {
          statusStream = new ReadableString(
            JSON.stringify(buildWrongCommandStatus(400, 'Invalid command'))
          )
          await pipe(statusStream, stream.send)
        }

        await closeStreamConnection(connection, remotePeer)
        return
      }
    }
    if (!task) {
      P2P_LOGGER.error('Invalid or missing task/command data!')
      if (connectionStatus === 'open') {
        statusStream = new ReadableString(
          JSON.stringify(buildWrongCommandStatus(400, 'Invalid command'))
        )
        await pipe(statusStream, stream.send)
      }

      await closeStreamConnection(connection, remotePeer)
      return
    }
  } catch (err) {
    P2P_LOGGER.log(
      LOG_LEVELS_STR.LEVEL_ERROR,
      `Unable to process P2P command: ${err.message}`
    )
    await closeStreamConnection(connection, remotePeer)
    return
  }

  P2P_LOGGER.logMessage('Performing P2P task: ' + JSON.stringify(task), true)
  // we get the handler from the running instance
  // no need to create a new instance of Handler on every request
  const handler: BaseHandler = this.getCoreHandlers().getHandler(task.command)
  let response: P2PCommandResponse = null
  if (handler === null) {
    status = { httpStatus: 501, error: `No handler found for command: ${task.command}` }
  } else {
    try {
      // who is calling this handler?
      handler.getOceanNode().setRemoteCaller(remotePeer.toString())
      response = await handler.handle(task)
      if (response) {
        // eslint-disable-next-line prefer-destructuring
        status = response.status
        sendStream = response.stream
      }
      statusStream = new ReadableString(JSON.stringify(status))

      if (connectionStatus === 'open') {
        if (sendStream == null) {
          stream.send(new TextEncoder().encode(JSON.stringify(status)))
        } else {
          const combinedStream = new StreamConcat([statusStream, sendStream], {
            highWaterMark: JSON.stringify(status).length // important for reading chunks correctly on sink!
          })
          await pipe(combinedStream, stream.semd)
        }
      }

      await closeStreamConnection(connection, remotePeer)
    } catch (err) {
      P2P_LOGGER.logMessageWithEmoji(
        'handleProtocolCommands Error: ' + err.message,
        true,
        GENERIC_EMOJIS.EMOJI_CROSS_MARK,
        LOG_LEVELS_STR.LEVEL_ERROR
      )
      await closeStreamConnection(connection, remotePeer)
    }
  }
}
