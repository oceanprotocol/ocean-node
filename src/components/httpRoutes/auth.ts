import express from 'express'
import { SERVICES_API_BASE_PATH, PROTOCOL_COMMANDS } from '../../utils/constants.js'
import { HTTP_LOGGER } from '../../utils/logging/common.js'
import {
  CreateAuthTokenHandler,
  InvalidateAuthTokenHandler
} from '../core/handler/authHandler.js'
import { streamToString } from '../../utils/util.js'
import { Readable } from 'stream'

export const authRoutes = express.Router()

authRoutes.post(
  `${SERVICES_API_BASE_PATH}/auth/token`,
  express.json(),
  async (req, res) => {
    try {
      const { signature, address, nonce, validUntil, chainId } = req.body

      if (!signature || !address) {
        return res.status(400).json({ error: 'Missing required parameters' })
      }

      const response = await new CreateAuthTokenHandler(req.oceanNode).handle({
        command: PROTOCOL_COMMANDS.CREATE_AUTH_TOKEN,
        signature,
        address,
        nonce,
        validUntil,
        chainId,
        caller: req.caller
      })

      if (response.status.error) {
        return res
          .status(response.status.httpStatus)
          .json({ error: response.status.error })
      }

      const result = JSON.parse(await streamToString(response.stream as Readable))
      res.json(result)
    } catch (error) {
      HTTP_LOGGER.error(`Error creating auth token: ${error}`)
      res.status(500).json({ error: 'Internal server error' })
    }
  }
)

authRoutes.post(
  `${SERVICES_API_BASE_PATH}/auth/token/invalidate`,
  express.json(),
  async (req, res) => {
    try {
      const { signature, address, nonce, token, chainId } = req.body

      if (!signature || !address || !token) {
        return res.status(400).json({ error: 'Missing required parameters' })
      }

      const response = await new InvalidateAuthTokenHandler(req.oceanNode).handle({
        command: PROTOCOL_COMMANDS.INVALIDATE_AUTH_TOKEN,
        signature,
        address,
        nonce,
        token,
        chainId,
        caller: req.caller
      })

      if (response.status.error) {
        return res
          .status(response.status.httpStatus)
          .json({ error: response.status.error })
      }

      const result = JSON.parse(await streamToString(response.stream as Readable))
      res.json(result)
    } catch (error) {
      HTTP_LOGGER.error(`Error invalidating auth token: ${error}`)
      res.status(500).json({ error: 'Internal server error' })
    }
  }
)
