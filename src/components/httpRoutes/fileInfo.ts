import express, { Request, Response } from 'express'
import {
  FileInfoHttpRequest,
  FileObjectType,
  StorageObject
} from '../../@types/fileObject.js'
import { PROTOCOL_COMMANDS, SERVICES_API_BASE_PATH } from '../../utils/constants.js'
import { FileInfoHandler } from '../core/handler/fileInfoHandler.js'
import { HTTP_LOGGER } from '../../utils/logging/common.js'
import { FileInfoCommand } from '../../@types/commands.js'

export const fileInfoRoute = express.Router()
fileInfoRoute.use(express.json()) // Ensure JSON parsing middleware is used

// Validation function
fileInfoRoute.post(
  `${SERVICES_API_BASE_PATH}/fileInfo`,
  express.urlencoded({ extended: true, type: '*/*' }),
  async (req: Request, res: Response): Promise<void> => {
    const fileInfoReq: FileInfoHttpRequest = req.body as unknown as FileInfoHttpRequest
    HTTP_LOGGER.logMessage(`FileInfo request received: ${JSON.stringify(req.body)}`, true)

    try {
      const hasType =
        'type' in fileInfoReq &&
        fileInfoReq.type != null &&
        String(fileInfoReq.type).trim() !== ''
      const hasDid =
        'did' in fileInfoReq &&
        fileInfoReq.did != null &&
        String(fileInfoReq.did).trim() !== ''
      if (!hasType && !hasDid) {
        res.status(400).send('Invalid request parameters')
        return
      }
      // Retrieve the file info
      let fileObject: StorageObject
      let fileInfoTask: FileInfoCommand

      if (`did` in fileInfoReq && fileInfoReq.did && fileInfoReq.serviceId) {
        fileInfoTask = {
          command: PROTOCOL_COMMANDS.FILE_INFO,
          did: fileInfoReq.did,
          serviceId: fileInfoReq.serviceId,
          caller: req.caller
        }
      } else {
        fileObject = { ...fileInfoReq } as StorageObject

        fileInfoTask = {
          command: PROTOCOL_COMMANDS.FILE_INFO,
          file: fileObject,
          type: fileObject.type as FileObjectType,
          caller: req.caller
        }
      }

      const response = await new FileInfoHandler(req.oceanNode).handle(fileInfoTask)
      if (response.stream) {
        res.status(response.status.httpStatus)
        res.set(response.status.headers)
        response.stream.pipe(res)
      } else {
        HTTP_LOGGER.error(response.status.error)
        res.status(response.status.httpStatus).send(response.status.error)
      }
    } catch (error) {
      HTTP_LOGGER.error(error.message)
      res.status(500).send(error)
    }
    // res.sendStatus(200)
  }
)
