import { AdminCommandHandler } from './adminHandler.js'
import { AdminPushConfigCommand } from '../../../@types/commands.js'
import { P2PCommandResponse } from '../../../@types/OceanNode.js'
import {
  ValidateParams,
  buildInvalidParametersResponse,
  buildInvalidRequestMessage
} from '../../httpRoutes/validateCommands.js'
import { CORE_LOGGER } from '../../../utils/logging/common.js'
import { ReadableString } from '../../P2P/handleProtocolCommands.js'
import { getConfiguration, getConfigFilePath } from '../../../utils/config/index.js'
import { OceanNodeConfigSchema } from '../../../utils/config/schemas.js'
import fs from 'fs'
import path from 'path'

export class PushConfigHandler extends AdminCommandHandler {
  async validate(command: AdminPushConfigCommand): Promise<ValidateParams> {
    const baseValidation = await super.validate(command)
    if (!baseValidation.valid) {
      return baseValidation
    }

    if (!command.config || typeof command.config !== 'object') {
      return buildInvalidRequestMessage('Config must be a valid object')
    }

    // Pre-validate the config fields using Zod schema
    try {
      const currentConfig = await getConfiguration()
      const mergedConfig = { ...currentConfig, ...command.config }

      OceanNodeConfigSchema.parse(mergedConfig)
    } catch (error) {
      if (error.name === 'ZodError') {
        const issues = error.issues
          .map((issue: any) => `${issue.path.join('.')}: ${issue.message}`)
          .join(', ')
        return buildInvalidRequestMessage(`Config validation failed: ${issues}`)
      }
      return buildInvalidRequestMessage(`Config validation error: ${error.message}`)
    }

    return { valid: true }
  }

  async handle(task: AdminPushConfigCommand): Promise<P2PCommandResponse> {
    const validation = await this.validate(task)
    if (!validation.valid) {
      return new Promise<P2PCommandResponse>((resolve) => {
        resolve(buildInvalidParametersResponse(validation))
      })
    }

    try {
      const configPath = getConfigFilePath()
      const configContent = fs.readFileSync(configPath, 'utf-8')
      const currentConfig = JSON.parse(configContent)

      this.createBackup(configContent)

      const mergedConfig = { ...currentConfig, ...task.config }
      this.saveConfigToFile(mergedConfig)

      await getConfiguration(true, false)
      CORE_LOGGER.logMessage('Configuration reloaded successfully')

      const response = {
        message: 'Config updated and node reloaded successfully',
        config: mergedConfig
      }

      return new Promise<P2PCommandResponse>((resolve) => {
        resolve({
          status: { httpStatus: 200 },
          stream: new ReadableString(JSON.stringify(response))
        })
      })
    } catch (error) {
      CORE_LOGGER.error(`Error pushing config: ${error.message}`)
      return new Promise<P2PCommandResponse>((resolve) => {
        resolve({
          status: { httpStatus: 500, error: `Error pushing config: ${error.message}` },
          stream: null
        })
      })
    }
  }

  private createBackup(configContent: string): void {
    const backupDir = path.join(process.cwd(), 'config_backups')
    if (!fs.existsSync(backupDir)) {
      fs.mkdirSync(backupDir, { recursive: true })
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
    const backupPath = path.join(backupDir, `config.backup.${timestamp}.json`)
    fs.writeFileSync(backupPath, configContent, 'utf-8')
    CORE_LOGGER.logMessage(`Config backup created at: ${backupPath}`)
  }

  private saveConfigToFile(config: Record<string, any>): void {
    const configPath = getConfigFilePath()
    const content = JSON.stringify(config, null, 4)
    fs.writeFileSync(configPath, content, 'utf-8')
    CORE_LOGGER.logMessage(`Config saved to: ${configPath}`)
  }
}
