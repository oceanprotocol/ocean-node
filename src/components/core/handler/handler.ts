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
import { CORE_LOGGER } from '../../../utils/logging/common.js'
import { ReadableString } from '../../P2P/handlers.js'
import {
  CONNECTION_HISTORY_DELETE_THRESHOLD,
  CONNECTIONS_RATE_INTERVAL
} from '../../../utils/constants.js'
import { normalizeCommandAddresses, sameAddress } from '../../../utils/evmAddress.js'

const RATE_LIMIT_LOG_KEY = 'core-rate-limit'
const RATE_LIMIT_LOG_INTERVAL_MS = 60_000
export abstract class BaseHandler implements ICommandHandler {
  public nodeInstance: OceanNode
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
  // eslint-disable-next-line require-await
  async checkRateLimit(caller: string | string[]): Promise<boolean> {
    const node = this.getOceanNode()
    const requestMap = node.getRequestMap()
    const ratePerMinute = node.getConfig().rateLimit
    const requestTime = new Date().getTime()
    let isOK = true

    // If caller is not set, we cannot rate limit - allow the request
    if (!caller) {
      CORE_LOGGER.debug('No remote caller set, allowing request without rate limiting')
      return true
    }

    // Keep the request history bounded WITHOUT wiping everyone's counters. The previous
    // behaviour cleared the whole map at the threshold, which let an attacker reset every
    // caller's rate-limit state just by sending enough distinct `caller` values. Instead, once
    // we reach the hard cap we drop entries whose window has already elapsed and, if still at
    // the cap, evict the LEAST-ACTIVE callers (lowest request count) first. This is O(n) only
    // at/over the cap.
    if (requestMap.size >= CONNECTION_HISTORY_DELETE_THRESHOLD) {
      CORE_LOGGER.debug(
        'Request history reached threshold, evicting stale/oldest entries'
      )
      this.evictRequestHistory(requestMap, requestTime)
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
          // a client hammering the node must not flood the logs: one line per minute
          CORE_LOGGER.throttled(
            RATE_LIMIT_LOG_KEY,
            'warn',
            `Request denied (rate limit exceeded) for remote caller ${remote} (${
              requestMap.get(remote)?.numRequests
            } requests in the current window)`,
            RATE_LIMIT_LOG_INTERVAL_MS
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
          CORE_LOGGER.throttled(
            RATE_LIMIT_LOG_KEY,
            'warn',
            `Request denied (rate limit exceeded) for remote caller ${caller} (${
              requestMap.get(caller)?.numRequests
            } requests in the current window)`,
            RATE_LIMIT_LOG_INTERVAL_MS
          )
        }
      }
    }
    return isOK
  }

  /**
   * Bound the request-history map without discarding live counters. First removes entries whose
   * rate-limit window has already elapsed (stale), then — if still at/over the hard cap because a
   * lot of callers are genuinely active — evicts the LEAST-ACTIVE callers (lowest request count,
   * ties broken by oldest window start) until the map is back under the cap. Only ever called
   * at/over the cap, so the common path stays O(1).
   *
   * Evicting by request count (not by window-start age) is what actually defeats the ON-08b
   * counter-reset: a flood of distinct callers each sends ~1 request, so those singleton entries
   * are dropped before a caller we are actively rate-limiting (high numRequests). An attacker can
   * neither reset a victim's counter by filling the map, nor reset their own by self-eviction (a
   * high count is kept; a low count resetting from 1→1 is harmless). `lastRequestTime` is the
   * window start, not last-activity, so it is only a stable tie-breaker here, never the key.
   * @param requestMap the shared per-caller request history
   * @param now current time in ms
   */
  evictRequestHistory(requestMap: Map<string, RequestLimiter>, now: number): void {
    // 1) Drop entries whose window has already expired — they no longer count toward any limit.
    for (const [key, data] of requestMap) {
      if (now - data.lastRequestTime > CONNECTIONS_RATE_INTERVAL) {
        requestMap.delete(key)
      }
    }
    // 2) Still at/over the cap (many active callers): evict least-active first (lowest request
    // count, then oldest window start) until we drop below the cap, so actively rate-limited
    // callers are kept and a flood of singleton callers cannot displace them.
    if (requestMap.size >= CONNECTION_HISTORY_DELETE_THRESHOLD) {
      const byLeastActive = [...requestMap.entries()].sort(
        (a, b) =>
          a[1].numRequests - b[1].numRequests ||
          a[1].lastRequestTime - b[1].lastRequestTime
      )
      const removeCount = requestMap.size - CONNECTION_HISTORY_DELETE_THRESHOLD + 1
      for (let i = 0; i < removeCount && i < byLeastActive.length; i++) {
        requestMap.delete(byLeastActive[i][0])
      }
    }
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
    // Real elapsed time (ms) since this caller's last window start. The rate window is a fixed
    // 60s interval (CONNECTIONS_RATE_INTERVAL); once it elapses, the caller's counter resets.
    // (The previous `(Δms / 1000) * 60` was Δms * 0.06, so the "1 minute" window actually reset
    // after ~17ms and MAX_REQ_PER_MINUTE went effectively unenforced.)
    const elapsedMs = currentTime - requestData.lastRequestTime
    // a full window has elapsed: start a fresh 60s window for this caller
    if (elapsedMs >= CONNECTIONS_RATE_INTERVAL) {
      requestData.lastRequestTime = currentTime
      requestData.numRequests = 1
      return {
        valid: true,
        updatedRequestData: requestData
      }
    } else {
      // another request within the same 60s window
      requestData.numRequests++
      return {
        valid: requestData.numRequests <= ratePerMinute,
        updatedRequestData: requestData
      }
    }
  }

  /**
   * ON-07: a dedicated, stricter rate limit for a specific command path, counted in a
   * SEPARATE bucket (namespaced key) so it does not share counters with the global limiter.
   * `ratePerMinute <= 0` disables it (returns true). Reuses `checkRequestData` plumbing.
   */
  // eslint-disable-next-line require-await
  async checkRateLimitForBucket(
    caller: string | string[],
    ratePerMinute: number,
    bucket: string
  ): Promise<boolean> {
    if (!caller || !ratePerMinute || ratePerMinute <= 0) {
      return true
    }
    const node = this.getOceanNode()
    const requestMap = node.getRequestMap()
    const requestTime = new Date().getTime()
    const callers = Array.isArray(caller) ? caller : [caller]
    for (const remote of callers) {
      const key = `${bucket}:${remote}`
      if (!requestMap.has(key)) {
        requestMap.set(key, {
          requester: key,
          lastRequestTime: requestTime,
          numRequests: 1
        })
        continue
      }
      const updated = this.checkRequestData(key, requestTime, ratePerMinute)
      requestMap.set(key, updated.updatedRequestData)
      if (!updated.valid) {
        CORE_LOGGER.throttled(
          RATE_LIMIT_LOG_KEY,
          'warn',
          `Request denied (${bucket} rate limit exceeded) for remote caller ${remote} (${
            requestMap.get(key)?.numRequests
          } requests in the current window)`,
          RATE_LIMIT_LOG_INTERVAL_MS
        )
        return false
      }
    }
    return true
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
    // Canonicalize every caller-supplied address (EIP-55) before ANYTHING reads it: the
    // validators below, DB lookups keyed by owner, ownership comparisons. Addresses are
    // identity keys, and a differently-cased one silently misses instead of erroring.
    normalizeCommandAddresses(task)
    // first check rate limits, if any
    if (!(await this.checkRateLimit(task.caller))) {
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

  async validateTokenOrSignature(
    authToken: string,
    address: string,
    nonce: string,
    signature: string,
    command: string,
    // ON-02: OPTIONAL resource/destination binding fields forwarded to the nonce verifier.
    // They are appended to the signed message ONLY for DECRYPT_DDO; callers that pass nothing
    // (e.g. ON-07 fileInfo, validateDDO, download) keep the unchanged message, so this stays
    // fully backward-compatible.
    extraSignedFields?: { chainId?: string; txId?: string; dataNftAddress?: string }
  ): Promise<P2PCommandResponse & { consumerAddress?: string }> {
    const oceanNode = this.getOceanNode()
    const auth = oceanNode.getAuth()
    if (!auth) {
      return {
        stream: null,
        status: { httpStatus: 401, error: 'Auth not configured' }
      }
    }
    const isAuthRequestValid = await auth.validateAuthenticationOrToken({
      token: authToken,
      address,
      nonce,
      signature,
      command,
      chainId: extraSignedFields?.chainId,
      txId: extraSignedFields?.txId,
      dataNftAddress: extraSignedFields?.dataNftAddress
    })
    if (!isAuthRequestValid.valid) {
      return {
        stream: null,
        status: { httpStatus: 401, error: isAuthRequestValid.error }
      }
    }
    // An auth TOKEN authenticates whoever it was issued to — not necessarily the address the
    // command claims. Bind the two: without this, a valid token for address A would authorize a
    // request naming address B as its consumerAddress, i.e. read/act on B's jobs, services and
    // buckets. (The signature path returns the very address it verified, so it always matches.)
    if (address && !sameAddress(isAuthRequestValid.address, address)) {
      return {
        stream: null,
        status: {
          httpStatus: 401,
          error: 'Authenticated address does not match the requested address'
        }
      }
    }

    return {
      stream: null,
      status: { httpStatus: 200 },
      consumerAddress: isAuthRequestValid.address
    }
  }
}
