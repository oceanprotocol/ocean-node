import express from 'express'
import { HTTP_LOGGER } from '../../utils/logging/common.js'
import { SetMaintenanceHandler } from '../core/admin/setMaintenanceHandler.js'
import { PROTOCOL_COMMANDS } from '../../utils/constants.js'
import { Readable } from 'stream'
import { streamToObject } from '../../utils/util.js'

export const maintenanceRoutes = express.Router()

// Signed-admin endpoint to toggle maintenance (drain) mode. Mirrors the adminConfig route
// precedent. Non-200 responses carry both the HTTP status and the machine-readable `code`
// (the handler sets `status.code` for the 503 maintenance rejection; admin-auth failures have
// no code), so clients discriminate on `code` rather than the status.
maintenanceRoutes.post('/api/admin/maintenance', express.json(), async (req, res) => {
  try {
    const { enabled, nonce, signature, address } = req.body

    const response = await new SetMaintenanceHandler(req.oceanNode).handle({
      command: PROTOCOL_COMMANDS.SET_MAINTENANCE,
      enabled,
      nonce,
      signature,
      address,
      caller: req.caller
    })

    if (response.status.httpStatus === 200) {
      const result = await streamToObject(response.stream as Readable)
      res.status(200).json(result)
    } else {
      HTTP_LOGGER.logByStatus(
        response.status.httpStatus,
        `Set maintenance failed (${response.status.httpStatus}): ${response.status.error}`
      )
      res
        .status(response.status.httpStatus)
        .json({ error: response.status.error, code: response.status.code })
    }
  } catch (error) {
    HTTP_LOGGER.error(`Error setting maintenance mode: ${error.message}`)
    res.status(500).send(`Internal Server Error: ${error.message}`)
  }
})
