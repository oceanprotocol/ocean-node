import express from 'express'
import { validateAdminSignature } from '../../utils/auth.js'
import { HTTP_LOGGER } from '../../utils/logging/common.js'
import { CommonValidation } from '../../utils/validators.js'
import { GetLogsHandler } from '../core/admin/getLogsHandler.js'
import { PROTOCOL_COMMANDS } from '../../utils/constants.js'
import { streamToObject } from '../../utils/util.js'
import { Readable } from 'node:stream'

export const logRoutes = express.Router()

// Middleware to validate signature and expiry timestamp
const validateRequest = async (
  req: express.Request,
  res: express.Response,
  next: express.NextFunction
) => {
  const { signature, address } = req.body
  let { expiryTimestamp } = req.body

  if (!signature) {
    return res.status(400).send('Missing signature')
  }
  if (!expiryTimestamp) {
    return res.status(400).send('Missing expiryTimestamp')
  }

  // Ensure expiryTimestamp is a number
  expiryTimestamp = Number(expiryTimestamp)
  if (isNaN(expiryTimestamp)) {
    return res.status(400).send('Invalid expiryTimestamp')
  }

  const isValid: CommonValidation = await validateAdminSignature(
    expiryTimestamp,
    signature,
    address
  )
  if (!isValid.valid) {
    return res.status(403).send(`Invalid signature: ${isValid.error}`)
  }

  next() // Proceed to the next middleware/function if validation is successful
}

logRoutes.post('/logs', express.json(), async (req, res) => {
  try {
    const { signature, expiryTimestamp, address } = req.body

    const maxLogs = Math.min(
      typeof req.query.maxLogs === 'string' ? parseInt(req.query.maxLogs, 10) : 100,
      1000
    ) // default to 100 logs, max 1000
    const moduleName =
      typeof req.query.moduleName === 'string' ? req.query.moduleName : undefined
    const level = typeof req.query.level === 'string' ? req.query.level : undefined

    const page =
      typeof req.query.page === 'string' ? parseInt(req.query.page, 10) : undefined // Default to undefined, which will fetch all logs

    const response = await new GetLogsHandler(req.oceanNode).handle({
      command: PROTOCOL_COMMANDS.GET_LOGS,
      signature,
      expiryTimestamp,
      address,
      startTime: req.query.startTime as string,
      endTime: req.query.endTime as string,
      maxLogs,
      moduleName,
      level,
      page
    })

    if (response.status.httpStatus === 200) {
      const result = await streamToObject(response.stream as Readable)
      res.status(200).json(result)
    } else {
      HTTP_LOGGER.log('LEVEL_ERROR', `Error fetching logs: ${response.status.error}`)
      res.status(response.status.httpStatus).json({ error: response.status.error })
    }
  } catch (error) {
    HTTP_LOGGER.error(`Error retrieving logs: ${error.message}`)
    res.status(500).send(`Internal Server Error: ${error.message}`)
  }
})

logRoutes.post('/log/:id', express.json(), validateRequest, async (req, res) => {
  try {
    const logId = req.params.id
    const database = req.oceanNode.getDatabase()
    if (!database || !database.logs) {
      res.status(503).send('Logs database is not available')
      return
    }
    const log = await database.logs.retrieveLog(logId)
    if (log) {
      res.json(log)
    } else {
      res.status(404).send('Log not found')
    }
  } catch (error) {
    HTTP_LOGGER.error(`Error retrieving log: ${error.message}`)
    res.status(500).send('Internal Server Error' + error.message)
  }
})
