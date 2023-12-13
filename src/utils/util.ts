import {
  CustomNodeLogger,
  LOGGER_MODULE_NAMES,
  LOG_LEVELS_STR,
  defaultConsoleTransport,
  getCustomLoggerForModule
} from '../utils/logging/Logger.js'
import { Readable, Stream } from 'stream'

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
      LOG_LEVELS_STR.LEVEL_ERROR,
      defaultConsoleTransport
    )

    PROVIDER_LOGGER.logMessage(
      'Error fetching event from transaction: ' + error.message,
      true
    )
    return null
  }
}

// Helper function to read from a stream
export async function readStream(stream: Stream): Promise<string> {
  return new Promise((resolve, reject) => {
    // Check if the stream is readable
    if (!(stream instanceof Readable)) {
      reject(new Error('Provided stream is not a readable stream.'))
      return
    }

    let data = ''

    stream.on('data', (chunk) => {
      data += chunk
    })

    stream.on('end', () => {
      resolve(data)
    })

    stream.on('error', (error) => {
      reject(error)
    })
  })
}
