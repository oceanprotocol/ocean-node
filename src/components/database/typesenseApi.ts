import { setTimeout } from 'timers/promises'
import { TypesenseConfig } from './typesenseConfig.js'
import { TypesenseError } from './typesense.js'
import { TypesenseNode } from '../../@types/index.js'

/**
 * TypesenseApi class is used to implement an api interface
 * for working with Typesense via http requests
 */
export class TypesenseApi {
  currentNodeIndex = -1

  constructor(private config: TypesenseConfig) {}

  // eslint-disable-next-line require-await
  async get<T>(endpoint: string, queryParameters: any = {}): Promise<T> {
    return this.request<T>('get', endpoint, {
      queryParameters
    })
  }

  // eslint-disable-next-line require-await
  async post<T>(
    endpoint: string,
    bodyParameters: any = {},
    queryParameters: any = {}
  ): Promise<T> {
    return this.request<T>('post', endpoint, {
      queryParameters,
      bodyParameters
    })
  }

  // eslint-disable-next-line require-await
  async delete<T>(endpoint: string, queryParameters: any = {}): Promise<T> {
    return this.request<T>('delete', endpoint, { queryParameters })
  }

  // eslint-disable-next-line require-await
  async put<T>(
    endpoint: string,
    bodyParameters: any = {},
    queryParameters: any = {}
  ): Promise<T> {
    return this.request<T>('put', endpoint, {
      queryParameters,
      bodyParameters
    })
  }

  // eslint-disable-next-line require-await
  async patch<T>(
    endpoint: string,
    bodyParameters: any = {},
    queryParameters: any = {}
  ): Promise<T> {
    return this.request<T>('patch', endpoint, {
      queryParameters,
      bodyParameters
    })
  }

  getNextNode(): TypesenseNode {
    let candidateNode: TypesenseNode = this.config.nodes[0]
    if (this.config.nodes.length === 1) {
      return candidateNode
    }
    this.currentNodeIndex = (this.currentNodeIndex + 1) % this.config.nodes.length
    candidateNode = this.config.nodes[this.currentNodeIndex]
    this.config.logger.debug(`Updated current node to Node ${candidateNode}`)
    return candidateNode
  }

  async request<T>(
    requestType: string,
    endpoint: string,
    {
      queryParameters = null,
      bodyParameters = null,
      skipConnectionTimeout = false
    }: {
      queryParameters?: any
      bodyParameters?: any
      skipConnectionTimeout?: boolean
    }
  ): Promise<T> {
    this.config.logger.debug(`Request ${endpoint}`)
    let lastException
    for (let numTries = 1; numTries <= this.config.numRetries + 1; numTries++) {
      const node = this.getNextNode()
      this.config.logger.debug(
        `Request ${endpoint}: Attempting ${requestType.toUpperCase()} request Try #${numTries} to Node ${
          node.host
        }`
      )

      try {
        const url = new URL(`${node.protocol}://${node.host}:${node.port}${endpoint}`)
        if (queryParameters !== null) {
          for (const [key, value] of Object.entries(queryParameters)) {
            if (value !== undefined && value !== null) {
              url.searchParams.set(key, String(value))
            }
          }
        }

        const init: RequestInit = {
          method: requestType.toUpperCase(),
          headers: {
            'X-TYPESENSE-API-KEY': this.config.apiKey,
            ...(bodyParameters !== null && { 'content-type': 'application/json' })
          },
          ...(bodyParameters !== null && { body: JSON.stringify(bodyParameters) })
        }

        if (skipConnectionTimeout !== true) {
          init.signal = AbortSignal.timeout(this.config.connectionTimeoutSeconds * 1000)
        }

        const response = await fetch(url, init)
        this.config.logger.debug(
          `Request ${endpoint}: Request to Node ${node.host} was made. Response Code was ${response.status}.`
        )

        // fetch never throws on HTTP status and doesn't auto-parse — replicate
        // axios's old transformResponse (JSON only when content-type says so).
        const contentType = response.headers.get('content-type') ?? ''
        const data: any = contentType.startsWith('application/json')
          ? await response.json()
          : await response.text()

        if (response.status >= 200 && response.status < 300) {
          return data
        } else if (response.status < 500) {
          return Promise.reject(this.customError(response.status, data))
        } else {
          throw new Error(data?.message)
        }
      } catch (error: any) {
        lastException = error
        this.config.logger.debug(
          `Request ${endpoint}: Request to Node ${node.host} failed due to "${
            error.cause?.code ?? error.code
          } ${error.message}"`
        )
        this.config.logger.debug(
          `Request ${endpoint}: Sleeping for ${this.config.retryIntervalSeconds}s and then retrying request...`
        )
        await setTimeout(this.config.retryIntervalSeconds)
      }
    }
    this.config.logger.debug(`Request: No retries left. Raising last error`)
    return Promise.reject(lastException)
  }

  customError(status: number, data: any): TypesenseError {
    const error = new TypesenseError(data?.message)
    error.httpStatus = status
    return error
  }
}
