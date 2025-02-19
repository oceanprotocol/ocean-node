import { P2PCommandResponse } from '../../../@types/OceanNode.js'
import { OceanNode, RequestDataCheck, RequestLimiter } from '../../../OceanNode.js'
import {
  Command,
  ICommandHandler,
  IValidateCommandHandler
} from '../../../@types/commands.js'
import {
  // ValidateParams,
  buildInvalidParametersResponse,
  buildRateLimitReachedResponse,
  ValidateParams
} from '../../httpRoutes/validateCommands.js'
import { getConfiguration } from '../../../utils/index.js'
import { CORE_LOGGER } from '../../../utils/logging/common.js'
import { ReadableString } from '../../P2P/handlers.js'
import { CONNECTION_HISTORY_DELETE_THRESHOLD } from '../../../utils/constants.js'

export abstract class BaseHandler implements ICommandHandler {
  private nodeInstance: OceanNode
  public constructor(oceanNode: OceanNode) {
    this.nodeInstance = oceanNode
  }

  // abstract validate(command: Command): ValidateParams
  abstract verifyParamsAndRateLimits(task: Command): Promise<P2PCommandResponse>

  abstract handle(task: Command): Promise<P2PCommandResponse>

  getOceanNode(): OceanNode {
    return this.nodeInstance
  }

  // TODO LOG, implement all handlers
  async checkRateLimit(): Promise<boolean> {
    const requestMap = this.getOceanNode().getRequestMap()
    const ratePerMinute = (await getConfiguration()).rateLimit
    const caller: string | string[] = this.getOceanNode().getRemoteCaller()
    const requestTime = new Date().getTime()
    let isOK = true

    // we have to clear this from time to time, so it does not grow forever
    if (requestMap.size > CONNECTION_HISTORY_DELETE_THRESHOLD) {
      CORE_LOGGER.info('Request history reached threeshold, cleaning cache...')
      requestMap.clear()
    }

    const self = this
    // common stuff
    const updateRequestData = function (remoteCaller: string) {
      const updatedRequestData = self.checkRequestData(
        remoteCaller,
        requestTime,
        ratePerMinute
      )
      isOK = updatedRequestData.valid
      requestMap.set(remoteCaller, updatedRequestData.updatedRequestData)
    }

    let data: RequestLimiter = null
    if (Array.isArray(caller)) {
      for (const remote of caller) {
        if (!requestMap.has(remote)) {
          data = {
            requester: remote,
            lastRequestTime: requestTime,
            numRequests: 1
          }
          requestMap.set(remote, data)
        } else {
          updateRequestData(remote)
        }
        // do not proceed any further
        if (!isOK) {
          CORE_LOGGER.warn(
            `Request denied (rate limit exceeded) for remote caller ${remote}. Current request map: ${JSON.stringify(
              requestMap.get(remote)
            )}`
          )
          return false
        }
      }
    } else {
      if (!requestMap.has(caller)) {
        data = {
          requester: caller,
          lastRequestTime: requestTime,
          numRequests: 1
        }
        requestMap.set(caller, data)
        return true
      } else {
        updateRequestData(caller)
        // log if request was denied
        if (!isOK) {
          CORE_LOGGER.warn(
            `Request denied (rate limit exceeded) for remote caller ${caller}. Current request map: ${JSON.stringify(
              requestMap.get(caller)
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
   * @param ratePerMinute number of calls per minute allowed (per ip or peer identifier)
   * @returns updated request data
   */
  checkRequestData(
    remote: string,
    currentTime: number,
    ratePerMinute: number
  ): RequestDataCheck {
    const requestMap = this.getOceanNode().getRequestMap()
    const requestData: RequestLimiter = requestMap.get(remote)
    const diffMinutes = ((currentTime - requestData.lastRequestTime) / 1000) * 60
    // more than 1 minute difference means no problem
    if (diffMinutes >= 1) {
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
        valid: requestData.numRequests <= ratePerMinute,
        updatedRequestData: requestData
      }
    }
  }

  shouldDenyTaskHandling(validationResponse: P2PCommandResponse): boolean {
    return (
      validationResponse.status.httpStatus !== 200 ||
      validationResponse.status.error !== null
    )
  }
}

export abstract class CommandHandler
  extends BaseHandler
  implements IValidateCommandHandler
{
  abstract validate(command: Command): ValidateParams
  async verifyParamsAndRateLimits(task: Command): Promise<P2PCommandResponse> {
    // first check rate limits, if any
    if (!(await this.checkRateLimit())) {
      return buildRateLimitReachedResponse()
    }
    // then validate the command arguments
    const validation = await this.validate(task)
    if (!validation.valid) {
      return buildInvalidParametersResponse(validation)
    }

    // all good!
    return {
      stream: new ReadableString('OK'),
      status: { httpStatus: 200, error: null }
    }
  }
}
