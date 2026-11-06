import { Readable } from 'stream'
import { AdminCommandHandler } from './adminHandler.js'
import { AdminSetMaintenanceCommand } from '../../../@types/commands.js'
import { P2PCommandResponse } from '../../../@types/OceanNode.js'
import {
  ValidateParams,
  buildInvalidParametersResponse,
  buildInvalidRequestMessage
} from '../../httpRoutes/validateCommands.js'
import { CORE_LOGGER } from '../../../utils/logging/common.js'

/**
 * Admin command handler that toggles maintenance (drain) mode. Gated by the standard
 * `AdminCommandHandler` auth (nonce + signature against `ALLOWED_ADMINS` / access lists).
 */
export class SetMaintenanceHandler extends AdminCommandHandler {
  /**
   * Validate the command: `enabled` must be an explicit boolean, then the standard admin
   * signature/nonce/address checks run via `super.validate`.
   *
   * @param command - the setMaintenance command to validate.
   * @returns the validation result.
   */
  async validate(command: AdminSetMaintenanceCommand): Promise<ValidateParams> {
    // `enabled` must be an explicit boolean — a missing/stringy value must not silently
    // toggle the node in or out of drain mode.
    if (typeof command.enabled !== 'boolean') {
      return buildInvalidRequestMessage('Parameter "enabled" must be a boolean')
    }
    return await super.validate(command)
  }

  /**
   * Validate, then persist + apply the new maintenance state. Returns 500 if the flag could
   * not be persisted (the cache is left unchanged), else 200 with `{ maintenance: <enabled> }`.
   *
   * @param task - the setMaintenance command.
   * @returns the command response.
   */
  async handle(task: AdminSetMaintenanceCommand): Promise<P2PCommandResponse> {
    const validation = await this.validate(task)
    if (!validation.valid) {
      return buildInvalidParametersResponse(validation)
    }
    try {
      await this.getOceanNode().setMaintenanceMode(task.enabled)
    } catch (error) {
      // Persist failed: the cache was NOT updated, so the node keeps its previous state. Surface
      // a 500 so the admin knows the toggle did not take, rather than reporting a false success.
      const message = error instanceof Error ? error.message : String(error)
      CORE_LOGGER.error(`Failed to set maintenance mode: ${message}`)
      return {
        status: { httpStatus: 500, error: `Failed to set maintenance mode: ${message}` },
        stream: null
      }
    }
    CORE_LOGGER.info(`Admin ${task.enabled ? 'enabled' : 'disabled'} maintenance mode`)
    return {
      status: { httpStatus: 200, error: null },
      stream: Readable.from(JSON.stringify({ maintenance: task.enabled }))
    }
  }
}
