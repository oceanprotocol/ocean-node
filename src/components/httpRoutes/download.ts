import express, { Request, Response } from 'express'
import { DownloadHandler } from '../core/downloadHandler.js'
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
  '/api/services/download',
  express.urlencoded({ extended: true, type: '*/*' }),
  async (req: Request, res: Response): Promise<void> => {
    if (!req.query) {
      res.sendStatus(400)
      return
    }
    logger.logMessage(`Download request received: ${JSON.stringify(req.query)}`, true)
    try {
      const {
        fileIndex,
        documentId,
        serviceId,
        transferTxId,
        nonce,
        consumerAddress,
        signature
      } = req.query

      const downloadTask = {
        fileIndex: Number(fileIndex),
        documentId: documentId as string,
        serviceId: serviceId as string,
        transferTxId: transferTxId as string,
        nonce: nonce as string,
        consumerAddress: consumerAddress as string,
        signature: signature as string
      }

      const response = await new DownloadHandler(req.oceanNode.getP2PNode()).handle(
        downloadTask
      )
      if (response.stream) {
        res.status(response.status.httpStatus)
        res.set(response.status.headers)
        response.stream.pipe(res)
      } else {
        res.status(response.status.httpStatus).send(response.error)
      }
    } catch (error) {
      logger.logMessage(`Error: ${error}`, true)
      res.status(500).send(error)
    }
    // res.sendStatus(200)
  }
)
