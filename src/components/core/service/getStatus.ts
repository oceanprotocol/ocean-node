import { Readable } from 'stream'
import { P2PCommandResponse } from '../../../@types/index.js'
import { ServiceGetStatusCommand } from '../../../@types/commands.js'
import { CommandHandler } from '../handler/handler.js'
import {
  ValidateParams,
  validateCommandParameters
} from '../../httpRoutes/validateCommands.js'
import type { ServiceJob } from '../../../@types/C2D/ServiceOnDemand.js'
import { toPublicServiceJob } from './utils.js'

export class ServiceGetStatusHandler extends CommandHandler {
  validate(command: ServiceGetStatusCommand): ValidateParams {
    // consumerAddress is required: it is the owner scope AND the identity the
    // signature/token is verified against.
    return validateCommandParameters(command, ['consumerAddress'])
  }

  async handle(task: ServiceGetStatusCommand): Promise<P2PCommandResponse> {
    const validationResponse = await this.verifyParamsAndRateLimits(task)
    if (this.shouldDenyTaskHandling(validationResponse)) return validationResponse

    // Status exposes live endpoint URLs / payment data, so the caller must prove
    // control of consumerAddress; results are then scoped to that owner.
    const auth = await this.validateTokenOrSignature(
      task.authorization,
      task.consumerAddress,
      task.nonce,
      task.signature,
      task.command
    )
    if (auth.status.httpStatus !== 200) return auth

    const engines = this.getOceanNode().getC2DEngines()
    if (!engines)
      return {
        stream: null,
        status: { httpStatus: 503, error: 'Compute engines not configured' }
      }

    // Aggregate across engines; each engine returns only its own cluster's jobs,
    // and the query ANDs owner + serviceId so only the authenticated owner's jobs match.
    const jobs: ServiceJob[] = []
    for (const eng of engines.getAllEngines()) {
      jobs.push(...(await eng.getServiceStatus(task.consumerAddress, task.serviceId)))
    }

    return {
      stream: Readable.from(JSON.stringify(jobs.map(toPublicServiceJob))),
      status: { httpStatus: 200 }
    }
  }
}
