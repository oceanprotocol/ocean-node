import express, { Request, Response } from 'express'
import { handleDownload } from '../core/downloadHandler.js'
import { Readable } from 'stream'
import {
  LOGGER_MODULE_NAMES,
  CustomNodeLogger,
  getCustomLoggerForModule,
  LOG_LEVELS_STR,
  defaultConsoleTransport
} from '../../utils/logging/Logger.js'

const logger: CustomNodeLogger = getCustomLoggerForModule(
  LOGGER_MODULE_NAMES.HTTP,
  LOG_LEVELS_STR.LEVEL_INFO, // Info level
  defaultConsoleTransport // console only Transport
)

export const downloadRoute = express.Router()
downloadRoute.get(
  '/download',
  express.urlencoded({ extended: true, type: '*/*' }),
  async (req: Request, res: Response): Promise<void> => {
    if (!req.query) {
      res.sendStatus(400)
      return
    }
    logger.logMessage(`Download request received: ${JSON.stringify(req.query)}`, true)
    try {
      const node = req.oceanNode.getP2PNode()
      const {
        filesIndex,
        documentId,
        serviceId,
        transferTxId,
        nonce,
        consumerAddress,
        signature
      } = req.query

      const downloadTask = {
        filesIndex: Number(filesIndex),
        documentId: documentId as string,
        serviceIndex: serviceId as string,
        transferTxId: transferTxId as string,
        nonce: nonce as string,
        consumerAddress: consumerAddress as string,
        signature: signature as string
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
