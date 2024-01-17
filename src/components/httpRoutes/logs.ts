import express from 'express'

export const logRoutes = express.Router()

logRoutes.get('/logs', async (req, res) => {
  try {
    // Ensure the query parameters are strings before creating Date objects
    const startTime =
      typeof req.query.startTime === 'string'
        ? new Date(req.query.startTime)
        : new Date(Date.now() - 24 * 60 * 60 * 1000) // Default to 24 hours ago
    const endTime =
      typeof req.query.endTime === 'string' ? new Date(req.query.endTime) : new Date()
    const maxLogs =
      typeof req.query.maxLogs === 'string' ? parseInt(req.query.maxLogs, 10) : 100 // Default to 100 logs
    const moduleName =
      typeof req.query.moduleName === 'string' ? req.query.moduleName : undefined
    const level = typeof req.query.level === 'string' ? req.query.level : undefined

    // Retrieve logs from the database
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

logRoutes.get('/log/:id', async (req, res) => {
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
