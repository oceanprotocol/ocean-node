import express, { Request, Response } from 'express'
import { P2PCommandResponse } from '../../@types'
import { toString as uint8ArrayToString } from 'uint8arrays/to-string'

import { getDefaultLevel } from '../../utils/logging/Logger.js'

import {
  validateBroadcastParameters,
  validateCommandAPIParameters
} from './validateCommands.js'
import { HTTP_LOGGER } from '../httpRoutes/index.js'

export const broadcastCommandRoute = express.Router()

broadcastCommandRoute.post(
  '/broadcastCommand',
  express.json(),
  async (req: Request, res: Response): Promise<void> => {
    const validate = validateBroadcastParameters(req.body)
    if (!validate.valid) {
      res.status(validate.status).send(validate.reason)
      return
    }

    HTTP_LOGGER.log(getDefaultLevel(), `broadcastCommand received ${req.body}`, true)

    await req.oceanNode.getP2PNode().broadcast(JSON.stringify(req.body))
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

    HTTP_LOGGER.logMessage('Sending command : ' + JSON.stringify(req.body), true)

    // TODO NOTES: We are sending all "/directCommand" requests to the P2P component as "req.oceanNode.getP2PNode()"
    // even if we do not need any P2P functionality at all (as all our handlers are "inside" P2P)
    // All ends up here => "handleProtocolCommands()" or here => "handleDirectProtocolCommands()", where we do not have
    // any access to main OceanNode, neither Provider or Indexer components
    // probably the handlers should be on the OceanNode level, and if they need P2P connectivity we pass them the getP2PNode()
    // (we kinda do it already on most handlers anyway)
    let status: P2PCommandResponse = null
    // send to this peer
    if (!req.body.node || req.oceanNode.getP2PNode().isTargetPeerSelf(req.body.node)) {
      // send to this node
      status = await req.oceanNode.getP2PNode().sendToSelf(JSON.stringify(req.body), sink)
    } else {
      // send to another peer
      status = await req.oceanNode
        .getP2PNode()
        .sendTo(req.body.node as string, JSON.stringify(req.body), sink)
    }

    if (status.stream == null) {
      res.status(status.status.httpStatus)
      res.write(status.status.error)
      res.end()
    }
  }
)
