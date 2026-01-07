/* eslint-disable no-unreachable */
import express, { Request, Response } from 'express'
import { Readable } from 'stream'
import { toString as uint8ArrayToString } from 'uint8arrays/to-string'

import { HTTP_LOGGER } from '../../utils/logging/common.js'
import { hasP2PInterface } from '../../utils/config.js'
import { validateCommandParameters } from './validateCommands.js'
import { streamToUint8Array } from '../../utils/util.js'

function writeResponsePayload(
  res: Response,
  payload: Uint8Array | undefined,
  isBinaryContent: boolean
): void {
  if (!payload) return

  if (isBinaryContent) {
    res.write(payload)
  } else {
    res.write(uint8ArrayToString(payload))
  }
}

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
      res.on('close', () => {
        if (!closedResponse) {
          HTTP_LOGGER.error('TCP connection was closed before we could send a response!')
        }
        closedResponse = true
      })

      HTTP_LOGGER.logMessage('Sending command : ' + JSON.stringify(req.body), true)

      const isLocalCommand =
        !hasP2PInterface ||
        !req.body.node ||
        req.oceanNode.getP2PNode()?.isTargetPeerSelf(req.body.node)

      if (isLocalCommand) {
        // Local command - call handler directly
        const response = await req.oceanNode.handleDirectProtocolCommand(
          JSON.stringify(req.body)
        )

        res.status(response.status.httpStatus)
        if (response.status.headers) {
          res.header(response.status.headers)
        }

        const isBinaryContent =
          response.status.headers?.['content-type']
            ?.toLowerCase()
            .includes('application/octet-stream') || false

        if (response.stream) {
          const payload = await streamToUint8Array(response.stream as Readable)
          writeResponsePayload(res, payload, isBinaryContent)
        } else if (response.status.error) {
          res.write(response.status.error)
        }

        closedResponse = true
        res.end()
      } else if (hasP2PInterface) {
        // Remote command - use P2P sendTo
        const response = await req.oceanNode
          .getP2PNode()
          .sendTo(req.body.node as string, JSON.stringify(req.body), req.body.multiAddrs)

        res.status(response.status.httpStatus)
        if (response.status.headers) {
          res.header(response.status.headers)
        }

        const isBinaryContent =
          response.status.headers?.['content-type']
            ?.toLowerCase()
            .includes('application/octet-stream') || false

        if (response.data) {
          writeResponsePayload(res, response.data, isBinaryContent)
        } else if (response.status.error) {
          res.write(response.status.error)
        }

        closedResponse = true
        res.end()
      } else {
        res.status(400).send('Invalid or Non Existing P2P configuration')
        closedResponse = true
        res.end()
      }
    } catch (err) {
      HTTP_LOGGER.error(err.message)
      res.status(500).send(err.message)
    }
  }
)
