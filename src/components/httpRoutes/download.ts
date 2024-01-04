import express, { Request, Response } from 'express'
import { DownloadHandler } from '../core/downloadHandler.js'
import { DownloadCommand, PROTOCOL_COMMANDS } from '../../utils/constants.js'
import { HTTP_LOGGER } from '../../utils/logging/common.js'

export const downloadRoute = express.Router()
downloadRoute.get(
  '/api/services/download',
  express.urlencoded({ extended: true, type: '*/*' }),
  async (req: Request, res: Response): Promise<void> => {
    if (!req.query) {
      res.sendStatus(400)
      return
    }
    HTTP_LOGGER.logMessage(
      `Download request received: ${JSON.stringify(req.query)}`,
      true
    )
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

      const downloadTask: DownloadCommand = {
        fileIndex: Number(fileIndex),
        documentId: documentId as string,
        serviceId: serviceId as string,
        transferTxId: transferTxId as string,
        nonce: nonce as string,
        consumerAddress: consumerAddress as string,
        signature: signature as string,
        command: PROTOCOL_COMMANDS.DOWNLOAD
      }

      const response = await new DownloadHandler(req.oceanNode.getP2PNode()).handle(
        downloadTask
      )
      if (response.stream) {
        res.status(response.status.httpStatus)
        res.set(response.status.headers)
        response.stream.pipe(res)
      } else {
        res.status(response.status.httpStatus).send(response.status.error)
      }
    } catch (error) {
      HTTP_LOGGER.logMessage(`Error: ${error}`, true)
      res.status(500).send(error)
    }
    // res.sendStatus(200)
  }
)
