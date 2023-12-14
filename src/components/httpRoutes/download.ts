import express, { Request, Response } from 'express'
import {
  LOGGER_MODULE_NAMES,
  CustomNodeLogger,
  getCustomLoggerForModule,
  getDefaultLevel
} from '../../utils/logging/Logger.js'

const logger: CustomNodeLogger = getCustomLoggerForModule(LOGGER_MODULE_NAMES.HTTP)

export const downloadRoute = express.Router()
downloadRoute.post(
  '/download',
  express.urlencoded({ extended: true, type: '*/*' }),
  async (req: Request, res: Response): Promise<void> => {
    if (!req.query) {
      res.sendStatus(400)
      return
    }
    logger.log(getDefaultLevel(), `Download request received: ${req.body}`, true)
    res.sendStatus(200)
  }
)
