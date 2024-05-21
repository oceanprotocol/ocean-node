import { P2PCommandResponse } from '../../../@types/OceanNode.js'
import { OceanNode } from '../../../OceanNode.js'
import { Command, ICommandHandler } from '../../../@types/commands.js'
import {
  ValidateParams,
  buildInvalidParametersResponse,
  buildRateLimitReachedResponse
} from '../../httpRoutes/validateCommands.js'
import { getConfiguration } from '../../../utils/index.js'
import { CORE_LOGGER } from '../../../utils/logging/common.js'
import { ReadableString } from '../../P2P/handlers.js'

export interface RequestLimiter {
  requester: string | string[] // IP address or peer ID
  lastRequestTime: number // time of the last request done (in miliseconds)
  numRequests: number // number of requests done in the specific time period
}

export interface RequestDataCheck {
  valid: boolean
  updatedRequestData: RequestLimiter
}
export abstract class Handler implements ICommandHandler {
  private nodeInstance?: OceanNode
  private requestMap: Map<string, RequestLimiter>
  public constructor(oceanNode: OceanNode) {
    this.nodeInstance = oceanNode
    this.requestMap = new Map<string, RequestLimiter>()
  }

  abstract validate(command: Command): ValidateParams

  abstract handle(task: Command): Promise<P2PCommandResponse>

  getOceanNode(): OceanNode {
    return this.nodeInstance
  }

  // TODO LOG, implement all handlers
  async checkRateLimit(): Promise<boolean> {
    const ratePerSecond = (await getConfiguration()).rateLimit
    const caller: string | string[] = this.getOceanNode().getRemoteCaller()
    const requestTime = new Date().getTime()
    let isOK = true

    const self = this
    // common stuff
    const updateRequestData = function (remoteCaller: string) {
      const updatedRequestData = self.checkRequestData(
        remoteCaller,
        requestTime,
        ratePerSecond
      )
      isOK = updatedRequestData.valid
      self.requestMap.set(remoteCaller, updatedRequestData.updatedRequestData)
    }

    let data: RequestLimiter = null
    if (Array.isArray(caller)) {
      for (const remote of caller) {
        if (!this.requestMap.has(remote)) {
          data = {
            requester: remote,
            lastRequestTime: requestTime,
            numRequests: 1
          }
          this.requestMap.set(remote, data)
        } else {
          updateRequestData(remote)
        }
        // do not proceed any further
        if (!isOK) {
          CORE_LOGGER.warn(
            `Request denied (rate limit exceeded) for remote caller ${remote}. Current request map: ${JSON.stringify(
              this.requestMap.get(remote)
            )}`
          )
          return false
        }
      }
    } else {
      if (!this.requestMap.has(caller)) {
        data = {
          requester: caller,
          lastRequestTime: requestTime,
          numRequests: 1
        }
        this.requestMap.set(caller, data)
        return true
      } else {
        updateRequestData(caller)
        // log if request was denied
        if (!isOK) {
          CORE_LOGGER.warn(
            `Request denied (rate limit exceeded) for remote caller ${caller}. Current request map: ${JSON.stringify(
              this.requestMap.get(caller)
            )}`
          )
        }
      }
    }
    return isOK
  }

  /**
   * Checks if the request is within the rate limit defined
   * @param remote remote endpoint (ip or peer identifier)
   * @param ratePerSecond number of calls per second allowed
   * @returns updated request data
   */
  checkRequestData(
    remote: string,
    currentTime: number,
    ratePerSecond: number
  ): RequestDataCheck {
    const requestData: RequestLimiter = this.requestMap.get(remote)
    const diffSeconds = (currentTime - requestData.lastRequestTime) / 1000
    // more than 1 sec difference means no problem
    if (diffSeconds >= 1) {
      // its fine
      requestData.lastRequestTime = currentTime
      requestData.numRequests = 1
      return {
        valid: true,
        updatedRequestData: requestData
      }
    } else {
      // requests in the same interval of 1 second
      requestData.numRequests++
      return {
        valid: requestData.numRequests <= ratePerSecond,
        updatedRequestData: requestData
      }
    }
  }

  async verifyParamsAndRateLimits(task: Command): Promise<P2PCommandResponse> {
    // first check rate limits, if any
    if (!(await this.checkRateLimit())) {
      return buildRateLimitReachedResponse()
    }
    // then validate the command arguments
    const validation = this.validate(task)
    if (!validation.valid) {
      return buildInvalidParametersResponse(validation)
    }

    // all good!
    return {
      stream: new ReadableString('OK'),
      status: { httpStatus: 200, error: null }
    }
  }

  shouldDenyTaskHandling(validationResponse: P2PCommandResponse): boolean {
    return (
      validationResponse.status.httpStatus !== 200 ||
      validationResponse.status.error !== null
    )
  }
}
