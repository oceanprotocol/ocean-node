import express, { Request, Response } from 'express'
import { handleDownload } from '../core/downloadHandler.js'
import { Readable } from 'stream'
import {
  LOGGER_MODULE_NAMES,
  CustomNodeLogger,
  getCustomLoggerForModule
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
    logger.logMessage(`Download request received: ${req.body}`, true)
    try {
      const node = req.oceanNode.getP2PNode()
      const {
        filesIndex,
        documentId,
        serviceIndex,
        transferTxId,
        nonce,
        consumerAddress,
        signature
      } = req.params

      const downloadTask = {
        filesIndex: Number(filesIndex),
        documentId,
        serviceIndex,
        transferTxId,
        nonce,
        consumerAddress,
        signature
      }

      const response = await handleDownload(downloadTask, node)
      if (response.stream) {
        res.send(response.stream as Readable)
      } else {
        res.status(response.status.httpStatus).send(response.status.error)
      }
    } catch (error) {
      logger.logMessage(`Error: ${error}`, true)
      res.sendStatus(500)
      return
    }
    res.sendStatus(200)
  }
)
