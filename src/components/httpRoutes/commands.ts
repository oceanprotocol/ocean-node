import express, { Request, Response } from 'express'
import { toString as uint8ArrayToString } from 'uint8arrays/to-string'

import { HTTP_LOGGER } from '../../utils/logging/common.js'
import { errorSummary } from '../../utils/logging/redact.js'

import { validateCommandParameters } from './validateCommands.js'
import { Readable } from 'stream'
import { sanitizeLogValue } from '../../utils/util.js'

// caller-supplied values: sanitized so they cannot forge log lines (CWE-117)
function describeCommand(body: any): string {
  return `${sanitizeLogValue(body?.command)}${
    body?.node ? ' -> ' + sanitizeLogValue(body.node) : ''
  }`
}

function mapChunkToBuffer(chunk: any): Buffer | Uint8Array {
  if (typeof chunk === 'string') {
    return Buffer.from(chunk)
  }

  if (Buffer.isBuffer(chunk)) {
    return chunk
  }

  if (typeof chunk === 'object' && 'subarray' in chunk) {
    return chunk.subarray()
  }

  return Buffer.from(JSON.stringify(chunk))
}

async function streamToResponse(
  res: Response,
  stream: any,
  isBinaryContent: boolean
): Promise<void> {
  if (!stream) {
    HTTP_LOGGER.error('streamToResponse called with null/undefined stream')
    throw new Error('Stream is null or undefined')
  }

  try {
    for await (const chunk of stream) {
      if (!chunk) {
        continue
      }

      const data = mapChunkToBuffer(chunk)
      if (isBinaryContent) {
        res.write(data)
      } else {
        res.write(uint8ArrayToString(data))
      }
    }
  } catch (err) {
    HTTP_LOGGER.error(`Stream error: ${errorSummary(err)}`)
    throw err
  }
}

export const directCommandRoute = express.Router()
directCommandRoute.post(
  '/directCommand',
  express.json(),
  async (req: Request, res: Response): Promise<void> => {
    let closedResponse = false

    try {
      const validate = validateCommandParameters(req.body, [])
      if (!validate.valid) {
        res.status(validate.status).send(validate.reason)
        return
      }

      res.on('close', () => {
        if (!closedResponse) {
          HTTP_LOGGER.debug(
            `directCommand ${describeCommand(req.body)}: client closed the connection before the response`
          )
        }
        closedResponse = true
      })

      HTTP_LOGGER.debug(`directCommand ${describeCommand(req.body)}`)

      const isLocalCommand =
        !req.oceanNode.hasP2PInterface() ||
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
          await streamToResponse(res, response.stream as Readable, isBinaryContent)
        } else if (response.status.error) {
          res.write(response.status.error)
        }

        closedResponse = true
        res.end()
      } else if (req.oceanNode.hasP2PInterface()) {
        // Remote command - use P2P sendTo
        let { multiAddrs } = req.body
        if (typeof multiAddrs === 'string') {
          if (multiAddrs.startsWith('[')) {
            try {
              const parsed = JSON.parse(multiAddrs)
              multiAddrs = Array.isArray(parsed) ? parsed : [multiAddrs]
            } catch {
              multiAddrs = [multiAddrs]
            }
          } else {
            multiAddrs = [multiAddrs]
          }
        }

        const response = await req.oceanNode
          .getP2PNode()
          .sendTo(req.body.node as string, JSON.stringify(req.body), multiAddrs)

        res.status(response.status.httpStatus)
        if (response.status.headers) {
          res.header(response.status.headers)
        }

        const isBinaryContent =
          response.status.headers?.['content-type']
            ?.toLowerCase()
            .includes('application/octet-stream') || false

        if (response.stream) {
          await streamToResponse(res, response.stream as Readable, isBinaryContent)
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
      // after the headers are sent, failures are mid-stream aborts (peer, storage or client)
      const message = `directCommand ${describeCommand(req.body)} failed: ${errorSummary(err)}`
      HTTP_LOGGER.error(message)
      closedResponse = true
      if (!res.headersSent) {
        res.status(500).send(err.message)
      } else {
        // The status line and at least one body chunk are already on the wire, so
        // the status cannot be changed and end() would look like a complete (but
        // short) transfer. Destroy the response instead: the client and every
        // intermediate proxy see a failed transfer immediately, rather than holding
        // the socket open until their own timeout.
        res.destroy(err)
      }
    }
  }
)
