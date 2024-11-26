/* eslint-disable no-unreachable */
import express, { Request, Response } from 'express'
import { P2PCommandResponse } from '../../@types'
import { toString as uint8ArrayToString } from 'uint8arrays/to-string'

import { HTTP_LOGGER } from '../../utils/logging/common.js'
import { hasP2PInterface } from '../../utils/config.js'
import { validateCommandParameters } from './validateCommands.js'

export const directCommandRoute = express.Router()
directCommandRoute.post(
  '/directCommand',
  express.json(),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const validate = validateCommandParameters(req.body, [])
      if (!validate.valid) {
        res.status(validate.status).send(validate.reason)
        return
      }

      let closedResponse = false

      // detect connection closed
      res.on('close', () => {
        if (!closedResponse) {
          HTTP_LOGGER.error('TCP connection was closed before we could send a response!')
        }
        closedResponse = true
      })
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
                if (str?.toLowerCase().includes('application/octet-stream')) {
                  isBinaryContent = true
                }
              }
            } catch (e) {
              res.status(500)
              res.write(uint8ArrayToString(chunk.subarray()))
              closedResponse = true
              res.end()
              HTTP_LOGGER.error(e.message)
            }
          } else {
            try {
              if (isBinaryContent) {
                // Binary content, could be encrypted
                res.write(chunk.subarray())
              } else {
                const str = uint8ArrayToString(chunk.subarray())
                res.write(str)
              }
            } catch (e) {
              HTTP_LOGGER.error(e.message)
            }
          }
        }
        closedResponse = true
        res.end()
      }

      HTTP_LOGGER.logMessage('Sending command : ' + JSON.stringify(req.body), true)

      // TODO NOTES: We are sending all "/directCommand" requests to the P2P component as "req.oceanNode.getP2PNode()"
      // even if we do not need any P2P functionality at all (as all our handlers are "inside" P2P)
      // All ends up here => "handleProtocolCommands()" or here => "handleDirectProtocolCommands()", where we do not have
      // any access to main OceanNode, neither Provider or Indexer components
      // probably the handlers should be on the OceanNode level, and if they need P2P connectivity we pass them the getP2PNode()
      // (we kinda do it already on most handlers anyway)

      let response: P2PCommandResponse = null
      // send to this peer (we might not need P2P connectivity)
      if (
        !hasP2PInterface ||
        !req.body.node ||
        req.oceanNode.getP2PNode().isTargetPeerSelf(req.body.node)
      ) {
        // send to this node
        response = await req.oceanNode.handleDirectProtocolCommand(
          JSON.stringify(req.body),
          sink
        )
        // UPDATED: we can just call the handler directly here, once we have them
        // moving some of the logic from "handleProtocolCommands()" and "handleDirectProtocolCommands()" to the OceanNode
        // These actions do not need P2P connections directly
      } else if (hasP2PInterface) {
        // send to another peer (Only here we need P2P networking)
        response = await req.oceanNode
          .getP2PNode()
          .sendTo(req.body.node as string, JSON.stringify(req.body), sink)
      } else {
        response = {
          stream: null,
          status: {
            httpStatus: 400,
            error: 'Invalid or Non Existing P2P configuration'
          }
        }
      }

      // only if response was not already sent
      if (response.stream == null && !closedResponse) {
        try {
          res.statusMessage = response.status.error
          res.status(response.status.httpStatus).send(response.status.error)
          closedResponse = true
          res.end()
        } catch (e) {
          HTTP_LOGGER.error(e.message)
        }
      }
    } catch (err) {
      HTTP_LOGGER.error(err.message)
    }
  }
)
