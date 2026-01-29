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
    HTTP_LOGGER.logMessage(
      `PolicyServerPassthroughRoute request received: ${JSON.stringify(req.body)}`,
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
    HTTP_LOGGER.logMessage(
      `initializePSVerificationRoute  request received: ${JSON.stringify(req.body)}`,
      true
    )
    try {
      const response = await new PolicyServerInitializeHandler(req.oceanNode).handle({
        command: PROTOCOL_COMMANDS.POLICY_SERVER_PASSTHROUGH,
        documentId: req.body.documentId,
        serviceId: req.body.serviceId,
        consumerAddress: req.body.consumerAddress,
        policyServer: req.body.policyServer,
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
