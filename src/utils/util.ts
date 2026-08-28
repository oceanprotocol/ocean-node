import { LOG_LEVELS_STR } from './logging/Logger.js'
import { Readable, Stream } from 'stream'
import { Interface } from 'ethers'
import { PROVIDER_LOGGER } from './logging/common.js'

export function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * The function checks if the input string starts with 0x, which indicates that it is a hexadecimal string.
 * If it is, the function removes the 0x prefix and returns the remaining string.
 * Otherwise, the function returns the input string as is.
 * @param serviceFiles string
 * @returns sanitized string
 */
export function sanitizeServiceFiles(serviceFiles: string): string {
  if (typeof serviceFiles === 'string' && serviceFiles.startsWith('0x')) {
    return serviceFiles.substring(2)
  } else {
    return serviceFiles
  }
}

/**
 * Ceiling on what the two accumulating stream readers below will hold in memory.
 *
 * They are used on whole-payload responses - a DDO, a decrypted document, a nonce, a query
 * result page, an auth verdict - including responses that arrived from *another node* over the
 * P2P command protocol, where the sender is not trusted and the framing layer bounds a single
 * frame (4 MiB) but nothing bounds their sum. Without a cap a peer that keeps sending frames
 * grows the receiving process's heap for as long as it cares to, and the paths that do this
 * with no caller-supplied deadline are on the indexer, so the DDO pipeline is what pays.
 *
 * 64 MiB, because the cap has to sit above every legitimate payload and these are all payloads
 * that something is about to `JSON.parse` or hand to a handler whole: the largest are a query
 * result page (a few hundred DDOs at a few KiB each) and a decrypted DDO, both comfortably
 * under a MiB in practice, so this is roughly two orders of magnitude of headroom. It is not
 * the frame cap and not a transfer cap: streaming consumers - the download path, compute
 * results, log tails - never come through here, they pipe, and are bounded by the P2P response
 * budgets instead.
 */
export const MAX_ACCUMULATED_STREAM_BYTES = 64 * 1024 * 1024

/**
 * Stops the source and reports the overrun.
 *
 * `destroy` is called only when the source actually has it. These readers are typed as taking
 * a `Readable`, but the P2P client path hands them a bare async iterable (the response-body
 * iterator), and calling `destroy` on that would replace the size error with a `TypeError`.
 * Throwing out of a `for await` is what releases such a source anyway: the loop calls the
 * iterator's `return()`, which is where that iterator resets the stream.
 */
function stopAndReport(stream: unknown, maxBytes: number): Error {
  const destroy = (stream as { destroy?: unknown } | null)?.destroy
  if (typeof destroy === 'function') {
    try {
      destroy.call(stream)
    } catch {}
  }
  return new Error(`stream exceeded the maximum of ${maxBytes} bytes`)
}

export async function streamToObject(
  stream: Readable,
  maxBytes: number = MAX_ACCUMULATED_STREAM_BYTES
): Promise<any> {
  const jsonString = await streamToString(stream, maxBytes)
  try {
    return JSON.parse(jsonString)
  } catch (error) {
    throw new Error(`Invalid JSON in stream: ${error}`)
  }
}

/**
 * Reads a whole stream into a string, up to `maxBytes`.
 *
 * The stream is destroyed and an error thrown once the accumulated size passes the cap, rather
 * than the cap being applied to the result: the point is to stop holding the bytes, so it has
 * to be checked per chunk.
 */
export async function streamToString(
  stream: Readable,
  maxBytes: number = MAX_ACCUMULATED_STREAM_BYTES
) {
  if (!stream) {
    throw new Error('streamToString: stream is null or undefined')
  }
  const chunks = []
  let size = 0
  for await (const chunk of stream) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buf.length
    if (size > maxBytes) {
      throw stopAndReport(stream, maxBytes)
    }
    chunks.push(buf)
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

/** As `streamToString`, but returns the raw bytes. Same cap, for the same reason. */
export async function streamToUint8Array(
  stream: Readable,
  maxBytes: number = MAX_ACCUMULATED_STREAM_BYTES
): Promise<Uint8Array> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of stream) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buf.length
    if (size > maxBytes) {
      throw stopAndReport(stream, maxBytes)
    }
    chunks.push(buf)
  }
  return new Uint8Array(Buffer.concat(chunks))
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

export function isDefined(something: any): boolean {
  return something !== undefined && something !== null
}

export function deleteKeysFromObject(source: any, keys: string[]): any {
  keys.forEach((keyName) => {
    if (keyName in source) {
      delete source[keyName]
    }
  })
  return source
}

export function convertGigabytesToBytes(gigabytes: number): number {
  if (gigabytes < 0) {
    throw new Error('Input must be a non-negative number')
  }

  const bytesInAGigabyte = 1024 ** 3 // 1 gigabyte = 1024^3 bytes
  const bytes = gigabytes * bytesInAGigabyte
  return bytes
}
