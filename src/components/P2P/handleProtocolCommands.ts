import { pipe } from 'it-pipe'
import { Readable } from 'stream'
import { toString as uint8ArrayToString } from 'uint8arrays/to-string'

import { P2P_LOGGER } from '../../utils/logging/common.js'
import { Command } from '../../@types/commands.js'
import { P2PCommandResponse } from '../../@types/OceanNode'
import { GENERIC_EMOJIS, LOG_LEVELS_STR } from '../../utils/logging/Logger.js'
import StreamConcat from 'stream-concat'
import { Handler } from '../core/handler/handler.js'
import { getConfiguration } from '../../utils/index.js'
import { checkConnectionsRateLimit } from '../httpRoutes/requestValidator.js'
import { CONNECTIONS_RATE_INTERVAL } from '../../utils/constants.js'
import { RequestLimiter } from '../../OceanNode.js'

// hold data about last request made
const connectionsData: RequestLimiter = {
  lastRequestTime: Date.now(),
  requester: '',
  numRequests: 0
}

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

export async function handleProtocolCommands(otherPeerConnection: any) {
  const { remotePeer, remoteAddr } = otherPeerConnection.connection

  // only write if stream is in 'open' status
  const connectionStatus = otherPeerConnection.connection.status
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
        statusStream = new ReadableString(
          JSON.stringify(buildWrongCommandStatus(403, 'Unauthorized request'))
        )
        try {
          await pipe(statusStream, otherPeerConnection.stream.sink)
        } catch (e) {
          P2P_LOGGER.error(e)
        }
      }
      await closeStreamConnection(otherPeerConnection.connection, remotePeer)
      return
    }
  }
  // check connections rate limit
  const requestTime = Date.now()
  if (requestTime - connectionsData.lastRequestTime > CONNECTIONS_RATE_INTERVAL) {
    // last one was more than 1 minute ago? reset counter
    connectionsData.numRequests = 0
  }
  // always increment counter
  connectionsData.numRequests += 1
  // update time and requester information
  connectionsData.lastRequestTime = requestTime
  connectionsData.requester = remoteAddr

  // check global rate limits (not ip related)
  const requestRateValidation = checkConnectionsRateLimit(configuration, connectionsData)
  if (!requestRateValidation.valid) {
    P2P_LOGGER.warn(
      `Incoming request denied to peer: ${remotePeer} (rate limit exceeded)`
    )
    if (connectionStatus === 'open') {
      statusStream = new ReadableString(
        JSON.stringify(buildWrongCommandStatus(403, 'Rate limit exceeded'))
      )
      try {
        await pipe(statusStream, otherPeerConnection.stream.sink)
      } catch (e) {
        P2P_LOGGER.error(e)
      }
    }
    await closeStreamConnection(otherPeerConnection.connection, remotePeer)
    return
  }

  try {
    // eslint-disable-next-line no-unreachable-loop
    for await (const chunk of otherPeerConnection.stream.source) {
      try {
        const str = uint8ArrayToString(chunk.subarray())
        task = JSON.parse(str) as Command
      } catch (e) {
        if (connectionStatus === 'open') {
          statusStream = new ReadableString(
            JSON.stringify(buildWrongCommandStatus(400, 'Invalid command'))
          )
          await pipe(statusStream, otherPeerConnection.stream.sink)
        }

        await closeStreamConnection(otherPeerConnection.connection, remotePeer)
        return
      }
    }
    if (!task) {
      P2P_LOGGER.error('Invalid or missing task/command data!')
      if (connectionStatus === 'open') {
        statusStream = new ReadableString(
          JSON.stringify(buildWrongCommandStatus(400, 'Invalid command'))
        )
        await pipe(statusStream, otherPeerConnection.stream.sink)
      }

      await closeStreamConnection(otherPeerConnection.connection, remotePeer)
      return
    }
  } catch (err) {
    P2P_LOGGER.log(
      LOG_LEVELS_STR.LEVEL_ERROR,
      `Unable to process P2P command: ${err.message}`
    )
    await closeStreamConnection(otherPeerConnection.connection, remotePeer)
    return
  }

  P2P_LOGGER.logMessage('Performing P2P task: ' + JSON.stringify(task), true)
  // we get the handler from the running instance
  // no need to create a new instance of Handler on every request
  const handler: Handler = this.getCoreHandlers().getHandler(task.command)
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
          await pipe(statusStream, otherPeerConnection.stream.sink)
        } else {
          const combinedStream = new StreamConcat([statusStream, sendStream], {
            highWaterMark: JSON.stringify(status).length // important for reading chunks correctly on sink!
          })
          await pipe(combinedStream, otherPeerConnection.stream.sink)
        }
      }

      await closeStreamConnection(otherPeerConnection.connection, remotePeer)
    } catch (err) {
      P2P_LOGGER.logMessageWithEmoji(
        'handleProtocolCommands Error: ' + err.message,
        true,
        GENERIC_EMOJIS.EMOJI_CROSS_MARK,
        LOG_LEVELS_STR.LEVEL_ERROR
      )
      await closeStreamConnection(otherPeerConnection.connection, remotePeer)
    }
  }
}
