import { LOG_LEVELS_STR } from './logging/Logger.js'
import { Readable, Stream } from 'stream'
import { Interface } from 'ethers'
import { PROVIDER_LOGGER } from './logging/common.js'

export function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function streamToObject(stream: Readable): Promise<any> {
  const jsonString = await streamToString(stream)
  try {
    return JSON.parse(jsonString)
  } catch (error) {
    throw new Error('Invalid JSON in stream')
  }
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
    PROVIDER_LOGGER.log(
      LOG_LEVELS_STR.LEVEL_ERROR,
      'Error fetching event from transaction: ' + error.message,
      true
    )
    return null
  }
}

// Helper function to read from a stream
export function readStream(stream: Stream): Promise<string> {
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

// something returned by an async request, that we want to limit of wait time
export interface AsyncRequestLimited {
  data: any
  timeout: boolean
}
/**
 * Call an async function with a maximum time limit (milliseconds) for the timeout
 * @param {Promise<any>} asyncPromise An asynchronous promise to resolve
 * @param {number} timeLimit Time limit in milliseconds to resolve
 * @returns {Promise<AsyncRequestLimited> } Resolved promise result for async call
 */
export function asyncCallWithTimeout(
  asyncPromise: Promise<any>,
  timeLimit: number
): Promise<AsyncRequestLimited> {
  let timeoutHandler: any = null
  const timeoutPromise = new Promise((resolve, reject) => {
    timeoutHandler = setTimeout(
      () =>
        resolve({
          data: null,
          timeout: true
        }),
      timeLimit
    )
  })

  return Promise.race([asyncPromise, timeoutPromise]).then((result) => {
    clearTimeout(timeoutHandler)
    return {
      data: result,
      timeout: false
    }
  })
}
