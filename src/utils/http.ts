import { Readable } from 'stream'
import { fetch as undiciFetch } from 'undici'
import type { Dispatcher } from 'undici'

/**
 * `RequestInit` plus undici's `dispatcher`. Pass `getSafeDispatcher(config)` (see
 * `safeUrl.ts`) for any request whose URL comes from a remote caller: the request is then
 * sent with undici's own fetch so the dispatcher's SSRF connector is honoured on every hop.
 */
export type FetchInit = RequestInit & { dispatcher?: Dispatcher }

/**
 * Convert a fetch `Headers` instance into a plain object with lowercase keys,
 * matching the shape axios used to expose on `response.headers`. Consumers that
 * iterate with `Object.entries(...)` (e.g. downloadHandler) rely on a plain
 * object here — `Object.entries(new Headers())` would yield `[]`.
 */
export function headersToObject(headers: Headers): Record<string, string> {
  return Object.fromEntries(headers)
}

/**
 * fetch with axios-like timeout semantics for streaming responses.
 *
 * The timer guards the connection + response-headers phase only. `fetch()`
 * resolves as soon as the response headers arrive (the body may still be
 * streaming), so clearing the timer in `finally` means long-running body
 * streams (downloads, checksums) are never aborted mid-flight — the same
 * behaviour axios had with `responseType: 'stream'` + `timeout`.
 *
 * Buffered callers that want the timeout to cover the full body should use
 * plain `fetch(url, { signal: AbortSignal.timeout(ms) })` instead.
 */
export async function fetchHeadersTimeout(
  url: string,
  init: FetchInit,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(
    () => controller.abort(new Error('Headers timeout')),
    timeoutMs
  )
  try {
    const { dispatcher, ...rest } = init
    if (dispatcher) {
      // the global fetch is Node's bundled undici; a dispatcher built from the npm
      // package must be used with the npm package's fetch. Same semantics otherwise.
      return (await undiciFetch(url, {
        ...(rest as any),
        dispatcher,
        signal: controller.signal
      })) as unknown as Response
    }
    return await fetch(url, { ...rest, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

/**
 * GET/POST a URL and adapt the response to the `StorageReadable` contract:
 * a Node `Readable` stream plus a plain lowercase-keyed headers object.
 *
 * Throws on non-2xx (axios threw on non-2xx by default; every storage caller
 * relied on that) and on an empty response body.
 */
export async function fetchStream(
  url: string,
  init: FetchInit = {},
  timeoutMs = 30000
): Promise<{ httpStatus: number; stream: Readable; headers: Record<string, string> }> {
  const response = await fetchHeadersTimeout(url, init, timeoutMs)
  if (!response.ok) {
    // preserve axios's throw-on-non-2xx contract for all callers
    await response.body?.cancel().catch(() => {})
    throw new Error(`Request failed with status code ${response.status} (${url})`)
  }
  if (!response.body) {
    throw new Error(`Empty response body (${url})`)
  }
  const headers = headersToObject(response.headers)
  // undici transparently decodes gzip/deflate/br but leaves the original
  // content-encoding + (now-wrong, compressed) content-length on the headers.
  // The stream we return is already decoded, so strip those stale headers —
  // otherwise a consumer re-serving them (e.g. downloadHandler) makes the client
  // try to decompress plain bytes ("incorrect header check"). axios's stream
  // adapter deleted these on decompress too.
  const encoding = headers['content-encoding']
  if (encoding && encoding.toLowerCase() !== 'identity') {
    delete headers['content-encoding']
    delete headers['content-length']
  }
  return {
    httpStatus: response.status,
    // `response.body` is typed as the DOM ReadableStream; Node's fromWeb wants
    // the node:stream/web ReadableStream — structurally identical, cast locally.
    stream: Readable.fromWeb(response.body as any),
    headers
  }
}
