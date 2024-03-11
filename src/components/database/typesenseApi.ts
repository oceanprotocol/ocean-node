import axios, { AxiosRequestConfig, AxiosResponse } from 'axios'
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
        const url = `${node.protocol}://${node.host}:${node.port}${endpoint}`
        const requestOptions: AxiosRequestConfig = {
          method: requestType,
          url,
          headers: { 'X-TYPESENSE-API-KEY': this.config.apiKey },
          maxContentLength: Infinity,
          maxBodyLength: Infinity,
          validateStatus: (status) => {
            return status > 0
          },
          transformResponse: [
            (data, headers) => {
              let transformedData = data
              if (
                headers !== undefined &&
                typeof data === 'string' &&
                headers['content-type'] &&
                headers['content-type'].startsWith('application/json')
              ) {
                transformedData = JSON.parse(data)
              }
              return transformedData
            }
          ]
        }

        if (skipConnectionTimeout !== true) {
          requestOptions.timeout = this.config.connectionTimeoutSeconds * 1000
        }

        if (queryParameters !== null) {
          requestOptions.params = queryParameters
        }

        if (bodyParameters !== null) {
          requestOptions.data = bodyParameters
        }

        const response = await axios(requestOptions)
        this.config.logger.debug(
          `Request ${endpoint}: Request to Node ${node.host} was made. Response Code was ${response.status}.`
        )

        if (response.status >= 200 && response.status < 300) {
          return Promise.resolve(response.data)
        } else if (response.status < 500) {
          return Promise.reject(this.customError(response))
        } else {
          throw new Error(response.data?.message)
        }
      } catch (error: any) {
        lastException = error
        this.config.logger.debug(
          `Request ${endpoint}: Request to Node ${node.host} failed due to "${error.code} ${error.message}"`
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

  customError(response: AxiosResponse): TypesenseError {
    const error = new TypesenseError(response.data?.message)
    error.httpStatus = response.status
    return error
  }
}
