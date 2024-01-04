import { OceanP2P } from './components/P2P/index.js'
import { OceanProvider } from './components/Provider/index.js'
import { OceanIndexer } from './components/Indexer/index.js'
import { OceanNodeConfig, P2PCommandResponse } from './@types/OceanNode.js'
import { Database } from './components/database/index.js'
import { CoreHandlersRegistry } from './components/core/coreHandlersRegistry.js'
import { OCEAN_NODE_LOGGER } from './utils/logging/common.js'
import { ReadableString } from './components/P2P/handleProtocolCommands.js'
import StreamConcat from 'stream-concat'
import { pipe } from 'it-pipe'
import { SUPPORTED_PROTOCOL_COMMANDS } from './utils/constants.js'
import { GENERIC_EMOJIS, LOG_LEVELS_STR } from './utils/logging/Logger.js'
import { Handler } from './components/core/handler.js'

export class OceanNode {
  // handlers
  private coreHandlers: CoreHandlersRegistry
  // eslint-disable-next-line no-useless-constructor
  public constructor(
    private config: OceanNodeConfig,
    private db: Database,
    private node?: OceanP2P,
    private provider?: OceanProvider,
    private indexer?: OceanIndexer
  ) {
    this.coreHandlers = new CoreHandlersRegistry(this.node)
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

  public getCoreHandlers(): CoreHandlersRegistry {
    return this.coreHandlers
  }

  /**
   * Use this method to direct calls to the node as node cannot dial into itself
   * @param message command message
   * @param sink transform function
   */
  async handleDirectProtocolCommand(
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
      const handler: Handler = this.coreHandlers.getHandler(task.command)
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
