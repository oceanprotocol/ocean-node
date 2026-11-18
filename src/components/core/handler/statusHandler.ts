import { CommandHandler } from './handler.js'
import { status } from '../utils/statusHandler.js'
import { OceanNodeStatus, P2PCommandResponse } from '../../../@types/OceanNode.js'
import { DetailedStatusCommand, StatusCommand } from '../../../@types/commands.js'
import { Readable } from 'stream'
import {
  ValidateParams,
  validateCommandParameters
} from '../../httpRoutes/validateCommands.js'
import { CORE_LOGGER } from '../../../utils/logging/common.js'
import { STATUS_CHALLENGE_DOMAIN } from '../../../utils/crypt.js'
import { toUtf8Bytes, hexlify } from 'ethers'

// OJ-03 (plan §14.2): bound the public signing oracle — reject an oversized challenge.
const MAX_CLIENT_CHALLENGE_BYTES = 256
// Dedicated rate-limit bucket for the challenge-signing path (plan §14.4), separate from the
// global per-caller limiter.
const STATUS_CHALLENGE_BUCKET = 'status-challenge'

export class StatusHandler extends CommandHandler {
  validate(command: StatusCommand): ValidateParams {
    return validateCommandParameters(command, [])
  }

  /**
   * OJ-03: sign the client challenge with the node's libp2p IDENTITY key over a domain-separated
   * digest, so the signature proves control of the key the peerId commits to and can never
   * collide with anything else that key signs. Returns the 0x-hex signature, or a status response
   * when the request must be rejected (oversized challenge / rate limit). Never caches the result.
   */
  private async signClientChallenge(
    task: StatusCommand
  ): Promise<{ signedChallenge?: string; reject?: P2PCommandResponse }> {
    const { clientChallenge } = task
    if (clientChallenge == null) {
      return {}
    }
    if (
      typeof clientChallenge !== 'string' ||
      Buffer.byteLength(clientChallenge, 'utf8') > MAX_CLIENT_CHALLENGE_BYTES
    ) {
      return {
        reject: {
          stream: null,
          status: { httpStatus: 400, error: 'Invalid clientChallenge' }
        }
      }
    }
    // Dedicated, stricter per-caller limit for the sign path only (counted in its own bucket),
    // enforced BEFORE doing any signing. Over the limit ⇒ reject without signing.
    const rate = this.getOceanNode().getConfig().statusChallengeRateLimit
    const underLimit = await this.checkRateLimitForBucket(
      task.caller,
      rate,
      STATUS_CHALLENGE_BUCKET
    )
    if (!underLimit) {
      return {
        reject: {
          stream: null,
          status: { httpStatus: 429, error: 'Too many status challenge requests' }
        }
      }
    }
    const message = STATUS_CHALLENGE_DOMAIN + clientChallenge
    const signatureBytes = await this.getOceanNode()
      .getKeyManager()
      .signWithIdentityKey(toUtf8Bytes(message))
    return { signedChallenge: hexlify(signatureBytes) }
  }

  async handle(task: StatusCommand): Promise<P2PCommandResponse> {
    const checks = await this.verifyParamsAndRateLimits(task)
    if (checks.status.httpStatus !== 200 || checks.status.error !== null) {
      return checks
    }
    try {
      const statusResult = await status(this.getOceanNode(), task.node, !!task.detailed)
      if (!statusResult) {
        return {
          stream: null,
          status: { httpStatus: 404, error: 'Status Not Found' }
        }
      }
      // OJ-03: compute signedChallenge per request and merge it into a SHALLOW COPY so the shared
      // (cached) status object never carries it (plan §14.4).
      let responseStatus: OceanNodeStatus = statusResult
      const { signedChallenge, reject } = await this.signClientChallenge(task)
      if (reject) {
        return reject
      }
      if (signedChallenge) {
        responseStatus = { ...statusResult, signedChallenge }
      }
      return {
        stream: Readable.from(JSON.stringify(responseStatus, null, 4)),
        status: { httpStatus: 200 }
      }
    } catch (error) {
      CORE_LOGGER.error(`Error in StatusHandler: ${error.message}`)
      return {
        stream: null,
        status: { httpStatus: 500, error: 'Unknown error: ' + error.message }
      }
    }
  }
}

export class DetailedStatusHandler extends StatusHandler {
  validate(command: DetailedStatusCommand): ValidateParams {
    return validateCommandParameters(command, [])
  }

  async handle(task: StatusCommand): Promise<P2PCommandResponse> {
    task.detailed = true
    return await super.handle(task)
  }
}
