import { AdminCommandHandler } from './adminHandler.js'
import { AdminFetchConfigCommand } from '../../../@types/commands.js'
import { P2PCommandResponse } from '../../../@types/OceanNode.js'
import {
  ValidateParams,
  buildInvalidParametersResponse
} from '../../httpRoutes/validateCommands.js'
import { ReadableString } from '../../P2P/handleProtocolCommands.js'
import { loadConfigFromFile } from '../../../utils/config/index.js'
import fs from 'fs'
import path from 'path'

export class FetchConfigHandler extends AdminCommandHandler {
  async validate(command: AdminFetchConfigCommand): Promise<ValidateParams> {
    return await super.validate(command)
  }

  async handle(task: AdminFetchConfigCommand): Promise<P2PCommandResponse> {
    const validation = await this.validate(task)
    if (!validation.valid) {
      return new Promise<P2PCommandResponse>((resolve) => {
        resolve(buildInvalidParametersResponse(validation))
      })
    }

    try {
      const config = loadConfigFromFile()
      const backupDir = path.join(process.cwd(), 'config_backups')

      if (!fs.existsSync(backupDir)) {
        return null
      }

      const files = fs.readdirSync(backupDir)
      const backupFiles = files
        .filter((file) => file.startsWith('config.backup.') && file.endsWith('.json'))
        .map((file) => ({
          path: path.join(backupDir, file),
          mtime: fs.statSync(path.join(backupDir, file)).mtime
        }))
        .sort((a, b) => b.mtime.getTime() - a.mtime.getTime())

      const lastBackup = backupFiles.length > 0 ? backupFiles[0].path : null

      const response = {
        config,
        lastBackup
      }

      return new Promise<P2PCommandResponse>((resolve) => {
        resolve({
          status: { httpStatus: 200 },
          stream: new ReadableString(JSON.stringify(response))
        })
      })
    } catch (error) {
      return new Promise<P2PCommandResponse>((resolve) => {
        resolve({
          status: { httpStatus: 500, error: `Error fetching config: ${error.message}` },
          stream: null
        })
      })
    }
  }
}
