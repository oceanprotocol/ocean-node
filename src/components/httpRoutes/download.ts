import express, { Request, Response } from 'express'
import { handleDownload } from '../core/downloadHandler.js'
import { HTTP_LOGGER } from './index.js'

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
      const node = req.oceanNode.getP2PNode()
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

      const response = await handleDownload(downloadTask, node)
      if (response.stream) {
        res.status(response.status.httpStatus)
        res.set(response.status.headers)
        response.stream.pipe(res)
      } else {
        res.status(response.status.httpStatus).send(response.error)
      }
    } catch (error) {
      HTTP_LOGGER.logMessage(`Error: ${error}`, true)
      res.status(500).send(error)
    }
    // res.sendStatus(200)
  }
)
