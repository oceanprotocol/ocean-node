import {
  PROTOCOL_COMMANDS,
  SUPPORTED_PROTOCOL_COMMANDS
} from '../../../utils/constants.js'
import { OCEAN_NODE_LOGGER } from '../../../utils/logging/common.js'
import {
  GetDdoHandler,
  FindDdoHandler,
  DecryptDdoHandler,
  ValidateDDOHandler
} from './ddoHandler.js'
import { DownloadHandler } from './downloadHandler.js'
import { FileInfoHandler } from './fileInfoHandler.js'
import { PolicyServerPassthroughHandler } from './policyServer.js'
import { EncryptHandler, EncryptFileHandler } from './encryptHandler.js'
import { FeesHandler } from './feesHandler.js'
import { BaseHandler, CommandHandler } from './handler.js'
import { NonceHandler } from './nonceHandler.js'
import { QueryHandler } from './queryHandler.js'
import { DetailedStatusHandler, StatusHandler } from './statusHandler.js'
import { OceanNode } from '../../../OceanNode.js'
import { Command } from '../../../@types/commands.js'
import {
  ComputeGetEnvironmentsHandler,
  ComputeStartHandler,
  FreeComputeStartHandler,
  ComputeStopHandler,
  ComputeGetStatusHandler,
  ComputeGetResultHandler,
  ComputeInitializeHandler,
  ComputeGetStreamableLogsHandler
} from '../compute/index.js'
import { StopNodeHandler } from '../admin/stopNodeHandler.js'
import { ReindexTxHandler } from '../admin/reindexTxHandler.js'
import { ReindexChainHandler } from '../admin/reindexChainHandler.js'
import { IndexingThreadHandler } from '../admin/IndexingThreadHandler.js'
import { CollectFeesHandler } from '../admin/collectFeesHandler.js'
import { AdminCommandHandler } from '../admin/adminHandler.js'
import {
  GetP2PPeerHandler,
  GetP2PPeersHandler,
  GetP2PNetworkStatsHandler,
  FindPeerHandler
} from './p2p.js'
export type HandlerRegistry = {
  handlerName: string // name of the handler
  handlerImpl: BaseHandler // class that implements it
}

// we can use this factory class to create adittional handlers
// and then register them on the Ocean Node instance
export class HandlerFactory {
  static buildHandlerForTask(task: Command, impl: BaseHandler): HandlerRegistry {
    if (!task || !impl) {
      const msg = 'Invalid task/handler parameters!'
      OCEAN_NODE_LOGGER.error(msg)
      throw new Error(msg)
    } else if (SUPPORTED_PROTOCOL_COMMANDS.includes(task.command)) {
      return {
        handlerName: task.command,
        handlerImpl: impl
      }
    } else {
      const msg = `Invalid handler "${task.command}". No known associated protocol command!`
      OCEAN_NODE_LOGGER.error(msg)
      throw new Error(msg)
    }
  }
}

// this should be used as singleton
export class CoreHandlersRegistry {
  // eslint-disable-next-line no-use-before-define
  private static instance: CoreHandlersRegistry
  // map of handlers registered
  private coreHandlers: Map<string, BaseHandler> = new Map<string, BaseHandler>()

  // private readonly node: OceanP2P
  private constructor(node: OceanNode) {
    // implement core handlers
    this.registerCoreHandler(PROTOCOL_COMMANDS.DOWNLOAD, new DownloadHandler(node))
    this.registerCoreHandler(PROTOCOL_COMMANDS.DECRYPT_DDO, new DecryptDdoHandler(node))
    this.registerCoreHandler(PROTOCOL_COMMANDS.NONCE, new NonceHandler(node))
    this.registerCoreHandler(PROTOCOL_COMMANDS.ENCRYPT, new EncryptHandler(node))
    this.registerCoreHandler(PROTOCOL_COMMANDS.ENCRYPT_FILE, new EncryptFileHandler(node))
    this.registerCoreHandler(PROTOCOL_COMMANDS.GET_DDO, new GetDdoHandler(node))
    this.registerCoreHandler(PROTOCOL_COMMANDS.QUERY, new QueryHandler(node))
    this.registerCoreHandler(PROTOCOL_COMMANDS.STATUS, new StatusHandler(node))
    this.registerCoreHandler(
      PROTOCOL_COMMANDS.DETAILED_STATUS,
      new DetailedStatusHandler(node)
    )
    this.registerCoreHandler(PROTOCOL_COMMANDS.FIND_DDO, new FindDdoHandler(node))
    this.registerCoreHandler(PROTOCOL_COMMANDS.GET_FEES, new FeesHandler(node))
    this.registerCoreHandler(PROTOCOL_COMMANDS.FILE_INFO, new FileInfoHandler(node))
    this.registerCoreHandler(
      PROTOCOL_COMMANDS.POLICY_SERVER_PASSTHROUGH,
      new PolicyServerPassthroughHandler(node)
    )

    this.registerCoreHandler(PROTOCOL_COMMANDS.VALIDATE_DDO, new ValidateDDOHandler(node))
    this.registerCoreHandler(
      PROTOCOL_COMMANDS.COMPUTE_GET_ENVIRONMENTS,
      new ComputeGetEnvironmentsHandler(node)
    )
    this.registerCoreHandler(
      PROTOCOL_COMMANDS.COMPUTE_START,
      new ComputeStartHandler(node)
    )
    this.registerCoreHandler(
      PROTOCOL_COMMANDS.FREE_COMPUTE_START,
      new FreeComputeStartHandler(node)
    )
    this.registerCoreHandler(PROTOCOL_COMMANDS.COMPUTE_STOP, new ComputeStopHandler(node))
    this.registerCoreHandler(
      PROTOCOL_COMMANDS.COMPUTE_GET_STATUS,
      new ComputeGetStatusHandler(node)
    )
    this.registerCoreHandler(
      PROTOCOL_COMMANDS.COMPUTE_GET_RESULT,
      new ComputeGetResultHandler(node)
    )
    this.registerCoreHandler(
      PROTOCOL_COMMANDS.COMPUTE_GET_STREAMABLE_LOGS,
      new ComputeGetStreamableLogsHandler(node)
    )
    this.registerCoreHandler(
      PROTOCOL_COMMANDS.COMPUTE_INITIALIZE,
      new ComputeInitializeHandler(node)
    )
    this.registerCoreHandler(PROTOCOL_COMMANDS.STOP_NODE, new StopNodeHandler(node))
    this.registerCoreHandler(PROTOCOL_COMMANDS.REINDEX_TX, new ReindexTxHandler(node))
    this.registerCoreHandler(
      PROTOCOL_COMMANDS.REINDEX_CHAIN,
      new ReindexChainHandler(node)
    )
    this.registerCoreHandler(
      PROTOCOL_COMMANDS.HANDLE_INDEXING_THREAD,
      new IndexingThreadHandler(node)
    )
    this.registerCoreHandler(PROTOCOL_COMMANDS.COLLECT_FEES, new CollectFeesHandler(node))
    this.registerCoreHandler(PROTOCOL_COMMANDS.GET_P2P_PEER, new GetP2PPeerHandler(node))
    this.registerCoreHandler(
      PROTOCOL_COMMANDS.GET_P2P_PEERS,
      new GetP2PPeersHandler(node)
    )
    this.registerCoreHandler(
      PROTOCOL_COMMANDS.GET_P2P_NETWORK_STATS,
      new GetP2PNetworkStatsHandler(node)
    )
    this.registerCoreHandler(PROTOCOL_COMMANDS.FIND_PEER, new FindPeerHandler(node))
  }

  public static getInstance(node: OceanNode): CoreHandlersRegistry {
    if (!CoreHandlersRegistry.instance) {
      this.instance = new CoreHandlersRegistry(node)
    }
    return this.instance
  }

  // private method for registering the core handlers
  private registerCoreHandler(handlerName: string, handlerObj: BaseHandler) {
    if (!this.coreHandlers.has(handlerName)) {
      this.coreHandlers.set(handlerName, handlerObj)
    }
  }

  // any new Handlers just need to call this method
  public registerHandler(handler: HandlerRegistry) {
    if (
      !this.coreHandlers.has(handler.handlerName) &&
      handler.handlerImpl instanceof BaseHandler
    ) {
      this.coreHandlers.set(handler.handlerName, handler.handlerImpl)
    }
  }

  // pass the handler name from the SUPPORTED_PROTOCOL_COMMANDS keys
  public getHandler(handlerName: string): any {
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

  public getHandlerForTask(task: Command): CommandHandler | AdminCommandHandler | null {
    return this.getHandler(task.command)
  }

  public hasHandlerFor(handlerName: string): boolean {
    return this.coreHandlers.has(handlerName)
  }

  public getRegisteredCommands(): string[] {
    return Array.from(this.coreHandlers.keys())
  }
}
