import { OceanP2P } from './components/P2P/index.js'
import { OceanProvider } from './components/Provider/index.js'
import { OceanIndexer } from './components/Indexer/index.js'
import { OceanNodeConfig, P2PCommandResponse } from './@types/OceanNode.js'
import { Database } from './components/database/index.js'
import {
  Command,
  PROTOCOL_COMMANDS,
  SUPPORTED_PROTOCOL_COMMANDS
} from './utils/constants.js'
import {
  CustomNodeLogger,
  GENERIC_EMOJIS,
  LOGGER_MODULE_NAMES,
  LOG_LEVELS_STR,
  defaultConsoleTransport,
  getCustomLoggerForModule
} from './utils/logging/Logger.js'
import { Handler } from './components/core/handler.js'
import { EncryptHandler } from './components/core/encryptHandler.js'
import { DownloadHandler } from './components/core/downloadHandler.js'
import { NonceHandler } from './components/core/nonceHandler.js'
import { FindDdoHandler, GetDdoHandler } from './components/core/ddoHandler.js'
import { StatusHandler } from './components/core/statusHandler.js'
import { QueryHandler } from './components/core/queryHandler.js'
import { FeesHandler } from './components/core/feesHandler.js'
import { ReadableString } from './components/P2P/handleProtocolCommands.js'
import { pipe } from 'it-pipe'
import StreamConcat from 'stream-concat'

export const OCEAN_NODE_LOGGER: CustomNodeLogger = getCustomLoggerForModule(
  LOGGER_MODULE_NAMES.OCEAN_NODE,
  LOG_LEVELS_STR.LEVEL_INFO, // Info level
  defaultConsoleTransport // console only Transport
)

export type HandlerRegistry = {
  handlerName: string // name of the handler
  handlerImpl: Handler // class that implements it
}

export class OceanNode {
  private coreHandlers: Map<string, Handler> = new Map<string, Handler>()
  public constructor(
    private config: OceanNodeConfig,
    private db: Database,
    private node?: OceanP2P,
    private provider?: OceanProvider,
    private indexer?: OceanIndexer
  ) {
    // implement core handlers
    this.registerCoreHandler(PROTOCOL_COMMANDS.DOWNLOAD, new DownloadHandler(this.node))
    this.registerCoreHandler(PROTOCOL_COMMANDS.ENCRYPT, new EncryptHandler(this.node))
    this.registerCoreHandler(PROTOCOL_COMMANDS.NONCE, new NonceHandler(this.node))
    this.registerCoreHandler(PROTOCOL_COMMANDS.GET_DDO, new GetDdoHandler(this.node))
    this.registerCoreHandler(PROTOCOL_COMMANDS.QUERY, new QueryHandler(this.node))
    this.registerCoreHandler(PROTOCOL_COMMANDS.STATUS, new StatusHandler(this.node))
    this.registerCoreHandler(PROTOCOL_COMMANDS.FIND_DDO, new FindDdoHandler(this.node))
    this.registerCoreHandler(PROTOCOL_COMMANDS.GET_FEES, new FeesHandler(this.node))
    this.registerCoreHandler(PROTOCOL_COMMANDS.ECHO, new EchoHandler())
    /**
   * 
  PROTOCOL_COMMANDS.DOWNLOAD_URL,
  PROTOCOL_COMMANDS.ECHO,
  PROTOCOL_COMMANDS.ENCRYPT,
  PROTOCOL_COMMANDS.NONCE,
  PROTOCOL_COMMANDS.GET_DDO,
  PROTOCOL_COMMANDS.QUERY,
  PROTOCOL_COMMANDS.STATUS,
  PROTOCOL_COMMANDS.FIND_DDO,
  PROTOCOL_COMMANDS.GET_FEES
   */
  }

  public addP2PNode(_node: OceanP2P) {
    this.node = _node
  }

  public addProvider(_provider: OceanProvider) {
    this.provider = _provider
  }

  public addIndexer(_indexer: OceanIndexer) {
    this.indexer = _indexer
  }

  public getConfig(): OceanNodeConfig {
    return this.config
  }

  public getP2PNode(): OceanP2P | undefined {
    return this.node
  }

  public getProvider(): OceanProvider | undefined {
    return this.provider
  }

  public getIndexer(): OceanIndexer | undefined {
    return this.indexer
  }

  public getDatabase(): Database {
    return this.db
  }

  // private method for registering the core handlers
  private registerCoreHandler(handlerName: string, handlerObj: Handler) {
    if (!this.coreHandlers.has(handlerName)) {
      this.coreHandlers.set(handlerName, handlerObj)
    }
  }

  // any new Handlers just need to call this method
  public registerHandler(handler: HandlerRegistry) {
    if (
      !this.coreHandlers.has(handler.handlerName) &&
      handler.handlerImpl instanceof Handler
    ) {
      this.coreHandlers.set(handler.handlerName, handler.handlerImpl)
    }
  }

  // pass the handler name from the SUPPORTED_PROTOCOL_COMMANDS keys
  public getHandler(handlerName: string): Handler | null {
    if (!SUPPORTED_PROTOCOL_COMMANDS.includes(handlerName)) {
      OCEAN_NODE_LOGGER.error(
        `Invalid handler "${handlerName}". No known associated protocol command!`
      )
      return null
    } else if (!this.coreHandlers.has(handlerName)) {
      // TODO: we can also just log the warning and create a new handler ourselfes here
      OCEAN_NODE_LOGGER.error(
        `No handler registered for "${handlerName}". Did you forgot to call "registerHandler()" ?`
      )
      return null
    }
    return this.coreHandlers.get(handlerName)
  }

  public getHandlerForTask(task: Command): Handler | null {
    return this.getHandler(task.command)
  }

  public hasHandlerFor(handlerName: string): boolean {
    return this.coreHandlers.has(handlerName)
  }

  /**
   * Use this method to direct calls to the node as node cannot dial into itself
   * @param message command message
   * @param sink transform function
   */
  public async handleDirectProtocolCommand(
    message: string,
    sink: any
  ): Promise<P2PCommandResponse> {
    OCEAN_NODE_LOGGER.logMessage('Incoming direct command for ocean peer', true)
    let status = null
    // let statusStream
    let sendStream = null
    let response: P2PCommandResponse = null

    OCEAN_NODE_LOGGER.logMessage('Performing task: ' + message, true)

    try {
      const task = JSON.parse(message)
      const handler: Handler = this.getHandler(task.command)
      if (handler === null || !SUPPORTED_PROTOCOL_COMMANDS.includes(task.command)) {
        status = {
          httpStatus: 501,
          error: 'Unknown command or unexisting handler for command: ' + task.command
        }
      } else {
        response = await handler.handle(task)
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

      return (
        response || {
          status,
          stream: null
        }
      )
    } catch (err) {
      OCEAN_NODE_LOGGER.logMessageWithEmoji(
        'handleDirectProtocolCommands Error: ' + err.message,
        true,
        GENERIC_EMOJIS.EMOJI_CROSS_MARK,
        LOG_LEVELS_STR.LEVEL_ERROR
      )

      return {
        status: { httpStatus: 500, error: err.message },
        stream: null
      }
    }
  }
}

class EchoHandler extends Handler {
  handle(task: Command): Promise<P2PCommandResponse> {
    return new Promise<P2PCommandResponse>((resolve, reject) => {
      resolve({
        status: { httpStatus: 200 },
        stream: new ReadableString('OK')
      })
    })
  }
}

export class HandlerFactory {
  static buildHandlerForTask(task: Command): HandlerRegistry {
    if (SUPPORTED_PROTOCOL_COMMANDS.includes(task.command)) {
      return {
        handlerName: task.command,
        handlerImpl: undefined // TODO: create instance, new HandlerImplXYZ(...)
      }
    } else {
      const msg = `Invalid handler "${task.command}". No known associated protocol command!`
      OCEAN_NODE_LOGGER.error(msg)
      throw new Error(msg)
    }
  }
}
