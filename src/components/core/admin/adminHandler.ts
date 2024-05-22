import { AdminCommand, CommandStatus, JobStatus } from '../../../@types/commands.js'
import {
  ValidateParams,
  validateCommandParameters,
  buildInvalidRequestMessage
} from '../../httpRoutes/validateCommands.js'
import { validateAdminSignature } from '../../../utils/auth.js'
import { Handler } from '../handler/handler.js'

export abstract class AdminHandler extends Handler {
  validate(command: AdminCommand): ValidateParams {
    const commandValidation = validateCommandParameters(command, [
      'expiryTimestamp',
      'signature'
    ])
    if (!commandValidation.valid) {
      return buildInvalidRequestMessage(commandValidation.reason)
    }
    const signatureValidation = validateAdminSignature(
      command.expiryTimestamp,
      command.signature
    )
    if (!signatureValidation.valid) {
      return buildInvalidRequestMessage(
        `Signature check failed: ${signatureValidation.error}`
      )
    }
    return {
      valid: true
    }
  }
}
// when we send an admin command, we also get a job id back in the reponse
// we can use it later to get the status of the job execution (if not immediate)
export function buildJobIdentifier(command: AdminCommand): JobStatus {
  const now = new Date().getTime().toString()
  return {
    command: command.command, // which command
    timestamp: now, // when was delivered
    jobId: command.command + ':' + now, // job id
    status: CommandStatus.DELIVERED
  }
}
