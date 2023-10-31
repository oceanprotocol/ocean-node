import express, { Request, Response } from 'express'
import { P2PCommandResponse } from '../../@types'
import { toString as uint8ArrayToString } from 'uint8arrays/to-string'

import {
  LOGGER_MODULE_NAMES,
  CustomNodeLogger,
  getCustomLoggerForModule,
  getDefaultLevel
} from '../../utils/logging/Logger.js'

import { validateCommandAPIParameters } from './validateCommands.js'

export const broadcastCommandRoute = express.Router()

// just use the default logger with default transports
// Bellow is just an example usage
const logger: CustomNodeLogger = getCustomLoggerForModule(LOGGER_MODULE_NAMES.HTTP)

broadcastCommandRoute.post(
  '/broadcastCommand',
  express.urlencoded({ extended: true }),
  async (req: Request, res: Response): Promise<void> => {
    if (!req.query.message) {
      res.status(400).send('Missing query parameter: "message" is mandatory')
      return
    }

    logger.log(getDefaultLevel(), `broadcastCommand received ${req.query.message}`, true)

    await req.oceanNode.node.broadcast(req.query.message)
    res.sendStatus(200)
  }
)

export const directCommandRoute = express.Router()
directCommandRoute.post(
  '/directCommand',
  express.json(),
  async (req: Request, res: Response): Promise<void> => {
    const validate = validateCommandAPIParameters(req.body)
    if (!validate.valid) {
      // 'node' param is not mandatory for 'downloadURL' command for instance:
      // https://github.com/oceanprotocol/ocean-node/issues/26
      // https://github.com/oceanprotocol/ocean-node/issues/38
      res.status(validate.status).send(validate.reason)
      return
    }

    let isBinaryContent = false
    const sink = async function (source: any) {
      let first = true
      for await (const chunk of source) {
        if (first) {
          first = false
          try {
            const str = uint8ArrayToString(chunk.subarray()) // Obs: we need to specify the length of the subarrays
            const decoded = JSON.parse(str)

            res.status(decoded.httpStatus)
            if ('headers' in decoded) {
              res.header(decoded.headers)
              // when streaming binary data we cannot convert to plain string, specially if encrypted data
              if (str.toLowerCase().includes('application/octet-stream')) {
                isBinaryContent = true
              }
            }
            if (decoded.httpStatus !== 200) {
              res.write(decoded.error)
              res.end()
              break
            }
          } catch (e) {
            res.status(500)
            res.write(uint8ArrayToString(chunk.subarray()))
            res.end()
          }
        } else {
          if (isBinaryContent) {
            // Binary content, could be encrypted
            res.write(chunk.subarray())
          } else {
            const str = uint8ArrayToString(chunk.subarray())
            res.write(str)
          }
        }
      }
      res.end()
    }

    logger.logMessage('Sending command : ' + JSON.stringify(req.body), true)

    let status: P2PCommandResponse = null
    // send to this peer
    if (!req.body.node || req.oceanNode.node.isTargetPeerSelf(req.body.node)) {
      // send to this node
      status = await req.oceanNode.node.sendToSelf(JSON.stringify(req.body), sink)
    } else {
      // send to another peer
      status = await req.oceanNode.node.sendTo(
        req.body.node as string,
        JSON.stringify(req.body),
        sink
      )
    }

    if (status.stream == null) {
      res.status(status.status.httpStatus)
      res.write(status.status.error)
      res.end()
    }
  }
)
