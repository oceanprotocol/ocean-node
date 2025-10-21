import express from 'express'
import { HTTP_LOGGER } from '../../utils/logging/common.js'
import { FetchConfigHandler } from '../core/admin/fetchConfigHandler.js'
import { PushConfigHandler } from '../core/admin/pushConfigHandler.js'
import { PROTOCOL_COMMANDS } from '../../utils/constants.js'
import { Readable } from 'stream'
import { streamToObject } from '../../utils/util.js'

export const adminConfigRoutes = express.Router()

adminConfigRoutes.get('/api/admin/config', express.json(), async (req, res) => {
  try {
    const { expiryTimestamp, signature } = req.body

    const response = await new FetchConfigHandler(req.oceanNode).handle({
      command: PROTOCOL_COMMANDS.FETCH_CONFIG,
      expiryTimestamp,
      signature
    })

    if (response.status.httpStatus === 200) {
      const result = await streamToObject(response.stream as Readable)
      res.status(200).json(result)
    } else {
      HTTP_LOGGER.log('LEVEL_ERROR', `Error fetching config: ${response.status.error}`)
      res.status(response.status.httpStatus).json({ error: response.status.error })
    }
  } catch (error) {
    HTTP_LOGGER.error(`Error fetching config: ${error.message}`)
    res.status(500).send(`Internal Server Error: ${error.message}`)
  }
})

adminConfigRoutes.post('/api/admin/config/update', express.json(), async (req, res) => {
  try {
    const { expiryTimestamp, signature, config } = req.body

    const response = await new PushConfigHandler(req.oceanNode).handle({
      command: PROTOCOL_COMMANDS.PUSH_CONFIG,
      expiryTimestamp,
      signature,
      config
    })

    if (response.status.httpStatus === 200) {
      const result = await streamToObject(response.stream as Readable)
      res.status(200).json(result)
    } else {
      HTTP_LOGGER.log('LEVEL_ERROR', `Error pushing config: ${response.status.error}`)
      res.status(response.status.httpStatus).json({ error: response.status.error })
    }
  } catch (error) {
    HTTP_LOGGER.error(`Error pushing config: ${error.message}`)
    res.status(500).send(`Internal Server Error: ${error.message}`)
  }
})
