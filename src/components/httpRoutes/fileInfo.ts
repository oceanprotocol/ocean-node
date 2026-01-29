import express, { Request, Response } from 'express'
import {
  ArweaveFileObject,
  FileInfoHttpRequest,
  FileObjectType,
  IpfsFileObject,
  UrlFileObject
} from '../../@types/fileObject'
import { PROTOCOL_COMMANDS, SERVICES_API_BASE_PATH } from '../../utils/constants.js'
import { FileInfoHandler } from '../core/handler/fileInfoHandler.js'
import { HTTP_LOGGER } from '../../utils/logging/common.js'
import { FileInfoCommand } from '../../@types/commands.js'

export const fileInfoRoute = express.Router()
fileInfoRoute.use(express.json()) // Ensure JSON parsing middleware is used

// Validation function
const validateFileInfoRequest = (req: FileInfoHttpRequest): boolean => {
  // Helper function to check if a string matches a regular expression
  const matchesRegex = (value: string, regex: RegExp): boolean => regex.test(value)

  if (!req.type && !req.did) return false // either 'type' or 'did' is required
  if (req.type && !['ipfs', 'url', 'arweave'].includes(req.type)) return false // 'type' must be one of the allowed values
  if (req.did && !matchesRegex(req.did, /^did:op/)) return false // 'did' must match the regex
  if (req.type === 'ipfs' && !req.hash) return false // 'hash' is required if 'type' is 'ipfs'
  if (req.type === 'url' && !req.url) return false // 'url' is required if 'type' is 'url'
  if (req.type === 'arweave' && !req.transactionId) return false // 'transactionId' is required if 'type' is 'arweave'
  if (!req.type && !req.serviceId) return false // 'serviceId' is required if 'type' is not provided

  return true
}

fileInfoRoute.post(
  `${SERVICES_API_BASE_PATH}/fileInfo`,
  express.urlencoded({ extended: true, type: '*/*' }),
  async (req: Request, res: Response): Promise<void> => {
    const fileInfoReq: FileInfoHttpRequest = req.body as unknown as FileInfoHttpRequest
    HTTP_LOGGER.logMessage(`FileInfo request received: ${JSON.stringify(req.body)}`, true)

    if (!validateFileInfoRequest(fileInfoReq)) {
      res.status(400).send('Invalid request parameters')
      return
    }

    try {
      // Retrieve the file info
      let fileObject: UrlFileObject | IpfsFileObject | ArweaveFileObject
      let fileInfoTask: FileInfoCommand

      if (fileInfoReq.did && fileInfoReq.serviceId) {
        fileInfoTask = {
          command: PROTOCOL_COMMANDS.FILE_INFO,
          did: fileInfoReq.did,
          serviceId: fileInfoReq.serviceId,
          caller: req.caller
        }
      } else if (fileInfoReq.type === 'url' && fileInfoReq.url) {
        fileObject = {
          type: 'url',
          url: fileInfoReq.url,
          method: 'GET'
        } as UrlFileObject
        fileInfoTask = {
          command: PROTOCOL_COMMANDS.FILE_INFO,
          file: fileObject,
          type: fileObject.type as FileObjectType,
          caller: req.caller
        }
      } else if (fileInfoReq.type === 'ipfs' && fileInfoReq.hash) {
        fileObject = {
          type: 'ipfs',
          hash: fileInfoReq.hash,
          method: 'GET'
        } as IpfsFileObject
        fileInfoTask = {
          command: PROTOCOL_COMMANDS.FILE_INFO,
          file: fileObject,
          type: fileObject.type as FileObjectType,
          caller: req.caller
        }
      } else if (fileInfoReq.type === 'arweave' && fileInfoReq.transactionId) {
        fileObject = {
          type: 'arweave',
          transactionId: fileInfoReq.transactionId,
          method: 'GET'
        } as ArweaveFileObject
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
