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
    // A token-authorized (header-only) request may carry no JSON body, leaving req.body undefined;
    // default to {} so destructuring never throws and the token still reaches the validator.
    const { nonce, signature, address } = req.body || {}

    const response = await new FetchConfigHandler(req.oceanNode).handle({
      command: PROTOCOL_COMMANDS.FETCH_CONFIG,
      nonce,
      signature,
      address,
      // read-only admin: a scoped auth token may be presented via the Authorization header
      // instead of a signature (plan §16.3). The ALLOWED_ADMINS gate still applies.
      authorization: req.headers?.authorization as string,
      caller: req.caller
    })

    if (response.status.httpStatus === 200) {
      const result = await streamToObject(response.stream as Readable)
      res.status(200).json(result)
    } else {
      HTTP_LOGGER.logByStatus(
        response.status.httpStatus,
        `Fetch config failed (${response.status.httpStatus}): ${response.status.error}`
      )
      res.status(response.status.httpStatus).json({ error: response.status.error })
    }
  } catch (error) {
    HTTP_LOGGER.error(`Error fetching config: ${error.message}`)
    res.status(500).send(`Internal Server Error: ${error.message}`)
  }
})

adminConfigRoutes.post('/api/admin/config/update', express.json(), async (req, res) => {
  try {
    const { nonce, signature, config, address } = req.body

    const response = await new PushConfigHandler(req.oceanNode).handle({
      command: PROTOCOL_COMMANDS.PUSH_CONFIG,
      nonce,
      signature,
      config,
      address,
      caller: req.caller
    })

    if (response.status.httpStatus === 200) {
      const result = await streamToObject(response.stream as Readable)
      res.status(200).json(result)
    } else {
      HTTP_LOGGER.logByStatus(
        response.status.httpStatus,
        `Push config failed (${response.status.httpStatus}): ${response.status.error}`
      )
      res.status(response.status.httpStatus).json({ error: response.status.error })
    }
  } catch (error) {
    HTTP_LOGGER.error(`Error pushing config: ${error.message}`)
    res.status(500).send(`Internal Server Error: ${error.message}`)
  }
})
