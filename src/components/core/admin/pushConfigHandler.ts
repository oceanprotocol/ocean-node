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
import { assertNoOverlappingServiceHostPortRanges } from '../../../utils/config/builder.js'
import fs from 'fs'

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
      const currentConfig = this.getOceanNode().getConfig()
      const mergedConfig = { ...currentConfig, ...command.config }

      OceanNodeConfigSchema.parse(mergedConfig)

      // Overlap is enforced at config build (buildC2DClusters), which runs AFTER the handler has
      // already written the file — so a config that passes the Zod schema but has overlapping
      // service host-port ranges would be persisted and then crash the next startup. Run the same
      // check here, before any save, so a bad push is rejected and the on-disk config is left
      // intact. Field name mirrors builder.ts (OceanNodeConfig.dockerComputeEnvironments).
      assertNoOverlappingServiceHostPortRanges(
        (mergedConfig as any).dockerComputeEnvironments
      )
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
      const configContent = await fs.promises.readFile(configPath, 'utf-8')
      const currentConfig = JSON.parse(configContent)

      const mergedConfig = { ...currentConfig, ...task.config }
      // a client that echoed an older pushConfig response back may have saved `over` - a
      // copy of the raw private key - into the file; this write drops it
      delete mergedConfig.over
      await this.saveConfigToFile(mergedConfig)

      const newConfig = await getConfiguration(true, false)
      this.getOceanNode().setConfig(newConfig)
      await this.getOceanNode().addC2DEngines()

      const responseConfig = structuredClone(newConfig)
      responseConfig.keys.privateKey = '[*** HIDDEN CONTENT ***]'
      CORE_LOGGER.info(`Admin pushed config: saved to ${configPath} and reloaded`)
      CORE_LOGGER.debug(`Pushed config keys: ${Object.keys(task.config).join(', ')}`)

      return new Promise<P2PCommandResponse>((resolve) => {
        resolve({
          status: { httpStatus: 200 },
          stream: new ReadableString(JSON.stringify(responseConfig))
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

  private async saveConfigToFile(config: Record<string, any>): Promise<void> {
    const configPath = getConfigFilePath()
    const content = JSON.stringify(config, null, 4)
    await fs.promises.writeFile(configPath, content, 'utf-8')
    CORE_LOGGER.debug(`Config saved to: ${configPath}`)
  }
}
