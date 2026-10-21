import express, { Request, Response } from 'express'
import {
  PolicyServerPassthroughHandler,
  PolicyServerInitializeHandler
} from '../core/handler/policyServer.js'
import { HTTP_LOGGER } from '../../utils/logging/common.js'
import { errorSummary } from '../../utils/logging/redact.js'
import { PROTOCOL_COMMANDS, SERVICES_API_BASE_PATH } from '../../utils/constants.js'

export const PolicyServerPassthroughRoute = express.Router()
PolicyServerPassthroughRoute.use(express.json()) // Ensure JSON parsing middleware is used

PolicyServerPassthroughRoute.post(
  `${SERVICES_API_BASE_PATH}/PolicyServerPassthrough`,
  express.urlencoded({ extended: true, type: '*/*' }),
  async (req: Request, res: Response): Promise<void> => {
    HTTP_LOGGER.debug(
      `PolicyServerPassthrough request: action=${req.body?.policyServerPassthrough?.action ?? '-'}`
    )
    try {
      const response = await new PolicyServerPassthroughHandler(req.oceanNode).handle({
        command: PROTOCOL_COMMANDS.POLICY_SERVER_PASSTHROUGH,
        policyServerPassthrough: req.body.policyServerPassthrough,
        caller: req.caller
      })
      if (response.stream) {
        res.status(response.status.httpStatus)
        res.set(response.status.headers)
        response.stream.pipe(res)
      } else {
        HTTP_LOGGER.logByStatus(
          response.status.httpStatus,
          `PolicyServerPassthrough failed (${response.status.httpStatus}): ${response.status.error}`
        )
        res.status(response.status.httpStatus).send(response.status.error)
      }
    } catch (error) {
      HTTP_LOGGER.error(`PolicyServerPassthrough failed: ${errorSummary(error)}`)
      res.status(500).send(error)
    }
    // res.sendStatus(200)
  }
)

PolicyServerPassthroughRoute.post(
  `${SERVICES_API_BASE_PATH}/initializePSVerification`,
  express.urlencoded({ extended: true, type: '*/*' }),
  async (req: Request, res: Response): Promise<void> => {
    HTTP_LOGGER.debug(
      `initializePSVerification request: ${req.body?.documentId} service=${req.body?.serviceId}`
    )
    try {
      const response = await new PolicyServerInitializeHandler(req.oceanNode).handle({
        command: PROTOCOL_COMMANDS.POLICY_SERVER_INITIALIZE,
        documentId: req.body.documentId,
        serviceId: req.body.serviceId,
        consumerAddress: req.body.consumerAddress,
        policyServer: req.body.policyServer,
        nonce: req.body.nonce,
        signature: req.body.signature,
        authorization: req.headers?.authorization,
        caller: req.caller
      })
      if (response.stream) {
        res.status(response.status.httpStatus)
        res.set(response.status.headers)
        response.stream.pipe(res)
      } else {
        HTTP_LOGGER.logByStatus(
          response.status.httpStatus,
          `initializePSVerification failed for ${req.body?.documentId} (${response.status.httpStatus}): ${response.status.error}`
        )
        res.status(response.status.httpStatus).send(response.status.error)
      }
    } catch (error) {
      HTTP_LOGGER.error(
        `initializePSVerification failed for ${req.body?.documentId}: ${errorSummary(error)}`
      )
      res.status(500).send(error)
    }
    // res.sendStatus(200)
  }
)
