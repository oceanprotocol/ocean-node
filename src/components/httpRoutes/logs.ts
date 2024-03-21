import express from 'express'
import { validateSignature } from '../../utils/auth'

export const logRoutes = express.Router()

// Middleware to validate signature and expiry timestamp
const validateRequest = (
  req: express.Request,
  res: express.Response,
  next: express.NextFunction
) => {
  const { signature, expiryTimestamp } = req.body
  if (!signature || !expiryTimestamp) {
    return res.status(400).send('Missing signature or expiryTimestamp')
  }

  const isValid = validateSignature(expiryTimestamp, signature)
  if (!isValid) {
    return res.status(403).send('Invalid signature')
  }

  next() // Proceed to the next middleware/function if validation is successful
}

logRoutes.post('/logs', validateRequest, async (req, res) => {
  try {
    const startTime =
      typeof req.query.startTime === 'string'
        ? new Date(req.query.startTime)
        : new Date(Date.now() - 90 * 24 * 60 * 60 * 1000) // Default to 90 days ago
    const endTime =
      typeof req.query.endTime === 'string' ? new Date(req.query.endTime) : new Date()
    const maxLogs =
      typeof req.query.maxLogs === 'string' ? parseInt(req.query.maxLogs, 10) : 100 // default to 100 logs
    const moduleName =
      typeof req.query.moduleName === 'string' ? req.query.moduleName : undefined
    const level = typeof req.query.level === 'string' ? req.query.level : undefined

    const logs = await req.oceanNode
      .getDatabase()
      .logs.retrieveMultipleLogs(startTime, endTime, maxLogs, moduleName, level)
    if (logs) {
      res.json(logs)
    } else {
      res.status(404).send('No logs found')
    }
  } catch (error) {
    res.status(500).send('Internal Server Error')
  }
})

logRoutes.post('/log/:id', validateRequest, async (req, res) => {
  try {
    const logId = req.params.id
    const log = await req.oceanNode.getDatabase().logs.retrieveLog(logId)
    if (log) {
      res.json(log)
    } else {
      res.status(404).send('Log not found')
    }
  } catch (error) {
    res.status(500).send('Internal Server Error' + error.message)
  }
})
