import {
  CustomNodeLogger,
  LOGGER_MODULE_NAMES,
  LOG_LEVELS_STR,
  defaultConsoleTransport,
  getCustomLoggerForModule
} from '../utils/logging/Logger.js'
// Put some utilities functions here
import { Readable } from 'stream'

// sleep for ms miliseconds
import { Interface } from 'ethers'

export function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function streamToString(stream: Readable) {
  const chunks = []
  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk))
  }
  return Buffer.concat(chunks).toString()
}

export function getEventFromTx(txReceipt: { logs: any[] }, eventName: any) {
  return txReceipt?.logs?.filter((log) => {
    return log?.fragment?.name === eventName
  })[0]
}

export function fetchEventFromTransaction(
  txReceipt: any,
  eventName: string,
  contractInterface: Interface
): any[] {
  try {
    // Filter and decode logs
    const events = txReceipt.logs
      .map((log: any) => ({
        topics: [...log.topics],
        data: log.data
      }))
      .filter((log: any) => {
        try {
          const parsedLog = contractInterface.parseLog(log)
          return parsedLog.name === eventName
        } catch (error) {
          return false
        }
      })
      .map((log: any) => ({
        ...contractInterface.parseLog(log),
        log
      }))

    return events.length > 0 ? events : null
  } catch (error) {
    const PROVIDER_LOGGER: CustomNodeLogger = getCustomLoggerForModule(
      LOGGER_MODULE_NAMES.PROVIDER,
      LOG_LEVELS_STR.LEVEl_ERROR,
      defaultConsoleTransport
    )

    PROVIDER_LOGGER.logMessage(
      'Error fetching event from transaction: ' + error.message,
      true
    )
    return null
  }
}
