import express from 'express'
import { validateAdminSignature } from '../../utils/auth.js'
import { HTTP_LOGGER } from '../../utils/logging/common.js'
import { CommonValidation } from './requestValidator.js'

export const logRoutes = express.Router()

// Middleware to validate signature and expiry timestamp
const validateRequest = async (
  req: express.Request,
  res: express.Response,
  next: express.NextFunction
) => {
  const { signature } = req.body
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
    signature
  )
  if (!isValid.valid) {
    return res.status(403).send(`Invalid signature: ${isValid.error}`)
  }

  next() // Proceed to the next middleware/function if validation is successful
}

logRoutes.post('/logs', express.json(), validateRequest, async (req, res) => {
  try {
    const startTime =
      typeof req.query.startTime === 'string'
        ? new Date(req.query.startTime)
        : new Date(Date.now() - 90 * 24 * 60 * 60 * 1000) // Default to 90 days ago
    const endTime =
      typeof req.query.endTime === 'string' ? new Date(req.query.endTime) : new Date() // Default to now
    const maxLogs =
      typeof req.query.maxLogs === 'string' ? parseInt(req.query.maxLogs, 10) : 100 // default to 100 logs
    const moduleName =
      typeof req.query.moduleName === 'string' ? req.query.moduleName : undefined
    const level = typeof req.query.level === 'string' ? req.query.level : undefined

    const page =
      typeof req.query.page === 'string' ? parseInt(req.query.page, 10) : undefined // Default to undefined, which will fetch all logs

    // Retrieve logs from the database with pagination
    const logs = await req.oceanNode
      .getDatabase()
      .logs.retrieveMultipleLogs(startTime, endTime, maxLogs, moduleName, level, page)

    if (logs.length > 0) {
      res.json(logs)
    } else {
      res.status(404).send('No logs found')
    }
  } catch (error) {
    HTTP_LOGGER.error(`Error retrieving logs: ${error.message}`)
    res.status(500).send(`Internal Server Error: ${error.message}`)
  }
})

logRoutes.post('/log/:id', express.json(), validateRequest, async (req, res) => {
  try {
    const logId = req.params.id
    const log = await req.oceanNode.getDatabase().logs.retrieveLog(logId)
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
