import express, { Request, Response } from 'express'
import {
  PolicyServerPassthroughHandler,
  PolicyServerInitializeHandler
} from '../core/handler/policyServer.js'
import { HTTP_LOGGER } from '../../utils/logging/common.js'
import { PROTOCOL_COMMANDS, SERVICES_API_BASE_PATH } from '../../utils/constants.js'

export const PolicyServerPassthroughRoute = express.Router()
PolicyServerPassthroughRoute.use(express.json()) // Ensure JSON parsing middleware is used

PolicyServerPassthroughRoute.post(
  `${SERVICES_API_BASE_PATH}/PolicyServerPassthrough`,
  express.urlencoded({ extended: true, type: '*/*' }),
  async (req: Request, res: Response): Promise<void> => {
    // do not log the raw body: the free-form policyServerPassthrough blob can carry
    // credentials (authorization token, signature)
    HTTP_LOGGER.logMessage(
      `PolicyServerPassthroughRoute request received (action: ${
        req.body?.policyServerPassthrough?.action ?? 'n/a'
      })`,
      true
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

PolicyServerPassthroughRoute.post(
  `${SERVICES_API_BASE_PATH}/initializePSVerification`,
  express.urlencoded({ extended: true, type: '*/*' }),
  async (req: Request, res: Response): Promise<void> => {
    // do not log the raw body: it carries the consumer signature and the free-form
    // policyServer blob, which can carry credentials
    HTTP_LOGGER.logMessage(
      `initializePSVerificationRoute request received (did: ${
        req.body?.documentId ?? 'n/a'
      }, serviceId: ${req.body?.serviceId ?? 'n/a'})`,
      true
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
