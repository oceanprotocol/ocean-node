import { pipe } from 'it-pipe'
import { Readable } from 'stream'
import { toString as uint8ArrayToString } from 'uint8arrays/to-string'
import StreamConcat from 'stream-concat'
// export function handleProtocolCommands (sourceStream:any,sinkStream:any) {

import { DownloadHandler } from '../core/handlers/downloadHandler.js'
import { PROTOCOL_COMMANDS } from '../../utils/constants.js'
import { P2PCommandResponse } from '../../@types'
import { P2P_CONSOLE_LOGGER } from './index.js'

import {
  NonceHandler,
  FeesHandler,
  StatusHandler,
  EncryptHandler,
  QueryHandler,
  GetDdoHandler
} from '../core/handlers/handler.js'
import { GENERIC_EMOJIS, LOG_LEVELS_STR } from '../../utils/logging/Logger.js'
import { getConfig } from '../../utils/index.js'
import { Database } from '../database/index.js'
import { FindDdoHandler } from '../core/handlers/findDdoHandler.js'

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

const config = await getConfig()
const db = await new Database(config.dbConfig)

export async function handleProtocolCommands(connection: any) {
  P2P_CONSOLE_LOGGER.logMessage(
    'Incoming connection from peer ' + connection.connection.remotePeer,
    true
  )
  P2P_CONSOLE_LOGGER.logMessage('Using ' + connection.connection.remoteAddr, true)

  let status = null
  let task
  let statusStream
  let sendStream = null
  /* eslint no-unreachable-loop: ["error", { "ignore": ["ForInStatement", "ForOfStatement"] }] */
  for await (const chunk of connection.stream.source) {
    try {
      const str = uint8ArrayToString(chunk.subarray())
      task = JSON.parse(str)
    } catch (e) {
      status = { httpStatus: 400, error: 'Invalid command' }
      statusStream = new ReadableString(JSON.stringify(status))
      pipe(statusStream, connection.stream.sink)
      return
    }
    break
  }
  P2P_CONSOLE_LOGGER.logMessage('Performing task: ' + JSON.stringify(task), true)

  let response: P2PCommandResponse = null
  try {
    switch (task.command) {
      case PROTOCOL_COMMANDS.ECHO:
        status = { httpStatus: 200 }
        break
      case PROTOCOL_COMMANDS.DOWNLOAD:
        response = await new DownloadHandler(task, config, db).handle()
        break
      case PROTOCOL_COMMANDS.DOWNLOAD_URL:
        response = await new DownloadHandler(task, config, db).handleDownloadUrlCommand()
        break
      case PROTOCOL_COMMANDS.GET_DDO:
        response = await new GetDdoHandler(task, db).handle()
        break
      case PROTOCOL_COMMANDS.QUERY:
        response = await new QueryHandler(task, db).handle()
        break
      case PROTOCOL_COMMANDS.ENCRYPT:
        response = await new EncryptHandler(task).handle()
        break
      case PROTOCOL_COMMANDS.NONCE:
        response = await new NonceHandler(task, db).handle()
        break
      case PROTOCOL_COMMANDS.STATUS:
        response = await new StatusHandler(task, config).handle()
        break
      case PROTOCOL_COMMANDS.FIND_DDO:
        response = await new FindDdoHandler(task, config, db).handle()
        break
      case PROTOCOL_COMMANDS.GET_FEES:
        response = await new FeesHandler(task).handle()
        break
      default:
        status = { httpStatus: 501, error: 'Unknown command' }
    }

    if (response) {
      // eslint-disable-next-line prefer-destructuring
      status = response.status
      sendStream = response.stream
    }

    statusStream = new ReadableString(JSON.stringify(status))
    if (sendStream == null) pipe(statusStream, connection.stream.sink)
    else {
      const combinedStream = new StreamConcat([statusStream, sendStream], {
        highWaterMark: JSON.stringify(status).length // important for reading chunks correctly on sink!
      })
      pipe(combinedStream, connection.stream.sink)
    }
  } catch (err) {
    P2P_CONSOLE_LOGGER.logMessageWithEmoji(
      'handleProtocolCommands Error: ' + err.message,
      true,
      GENERIC_EMOJIS.EMOJI_CROSS_MARK,
      LOG_LEVELS_STR.LEVEL_ERROR
    )
  }
}
/**
 * Use this method to direct calls to the node as node cannot dial into itself
 * @param message command message
 * @param sink transform function
 */
export async function handleDirectProtocolCommand(message: string, sink: any) {
  P2P_CONSOLE_LOGGER.logMessage('Incoming direct command for peer self', true)
  let status = null
  const task = JSON.parse(message)
  // let statusStream
  let sendStream = null
  let response: P2PCommandResponse = null

  P2P_CONSOLE_LOGGER.logMessage('Performing task: ' + JSON.stringify(task), true)
  try {
    switch (task.command) {
      case PROTOCOL_COMMANDS.ECHO:
        status = { httpStatus: 200 }
        break
      case PROTOCOL_COMMANDS.DOWNLOAD:
        response = await new DownloadHandler(task, config, db).handle()
        break
      case PROTOCOL_COMMANDS.DOWNLOAD_URL:
        response = await new DownloadHandler(task, config, db).handleDownloadUrlCommand()
        break
      case PROTOCOL_COMMANDS.GET_DDO:
        response = await new GetDdoHandler(task, db).handle()
        break
      case PROTOCOL_COMMANDS.QUERY:
        response = await new QueryHandler(task, db).handle()
        break
      case PROTOCOL_COMMANDS.ENCRYPT:
        response = await new EncryptHandler(task).handle()
        break
      case PROTOCOL_COMMANDS.NONCE:
        response = await new NonceHandler(task, db).handle()
        break
      case PROTOCOL_COMMANDS.STATUS:
        response = await new StatusHandler(task, config).handle()
        break
      case PROTOCOL_COMMANDS.FIND_DDO:
        response = await new FindDdoHandler(task, config, db).handle()
        break
      case PROTOCOL_COMMANDS.GET_FEES:
        response = await new FeesHandler(task).handle()
        break
      default:
        status = { httpStatus: 501, error: 'Unknown command' }
        break
    }

    if (response) {
      // eslint-disable-next-line prefer-destructuring
      status = response.status
      sendStream = response.stream
    }

    const statusStream = new ReadableString(JSON.stringify(status))
    if (sendStream == null) {
      pipe(statusStream, sink)
    } else {
      const combinedStream = new StreamConcat([statusStream, sendStream], {
        highWaterMark: JSON.stringify(status).length
        // the size of the buffer is important!
      })
      pipe(combinedStream, sink)
    }
  } catch (err) {
    P2P_CONSOLE_LOGGER.logMessageWithEmoji(
      'handleDirectProtocolCommands Error: ' + err.message,
      true,
      GENERIC_EMOJIS.EMOJI_CROSS_MARK,
      LOG_LEVELS_STR.LEVEL_ERROR
    )
  }
}
