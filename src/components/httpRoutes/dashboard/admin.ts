import express from 'express'
import { HTTP_LOGGER } from '../../../utils/logging/common.js'
import { validateSignature } from './utils/utils.js'
import { LOG_LEVELS_STR } from '../../../utils/logging/Logger.js'

export const aquariusRoutes = express.Router()

export const ADMIN_API_BASE_PATH = '/admin'

aquariusRoutes.post(`${ADMIN_API_BASE_PATH}/auth`, (req, res) => {
  try {
    if (!req.body || req.body === undefined) {
      HTTP_LOGGER.log(LOG_LEVELS_STR.LEVEL_ERROR, `Request body is empty`)
      res.status(400).send({
        response: false
      })
      return
    }
    const body = JSON.parse(req.body)
    if (!body.nonce || !body.signature || !body.expiryTimestamp) {
      HTTP_LOGGER.log(
        LOG_LEVELS_STR.LEVEL_ERROR,
        `Missing nonce || signature || expiryTimestamp`
      )
      res.status(400).send({
        response: false
      })
      return
    }
    if (new Date().getTime() >= body.expiryTimestamp) {
      HTTP_LOGGER.log(LOG_LEVELS_STR.LEVEL_ERROR, `Authentication expired`)
      res.status(400).send({
        response: false
      })
      return
    }
    const result = validateSignature(
      body.nonce,
      body.expiryTimestamp.toString(),
      body.signature
    )
    if (result === false) {
      HTTP_LOGGER.log(LOG_LEVELS_STR.LEVEL_ERROR, `Validation failed`)
      res.status(400).send({
        response: false
      })
    } else {
      res.status(200).send({
        response: true
      })
    }
  } catch (error) {
    HTTP_LOGGER.log(LOG_LEVELS_STR.LEVEL_ERROR, `Error: ${error}`)
    res.status(500).send(`Internal Server Error: ${error}`)
  }
})
