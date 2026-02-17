import express from 'express'
import { HTTP_LOGGER } from '../../utils/logging/common.js'
import { GetLogsHandler } from '../core/admin/getLogsHandler.js'
import { PROTOCOL_COMMANDS } from '../../utils/constants.js'
import { streamToObject } from '../../utils/util.js'
import { Readable } from 'node:stream'

export const logRoutes = express.Router()

logRoutes.post('/logs', express.json(), async (req, res) => {
  try {
    const { signature, address, nonce } = req.body

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
      nonce,
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

logRoutes.post('/log/:id', express.json(), async (req, res) => {
  try {
    const { signature, nonce, address, logId } = req.body
    if (!logId) {
      res.status(400).send('id is missing')
    }
    const response = await new GetLogsHandler(req.oceanNode).handle({
      command: PROTOCOL_COMMANDS.GET_LOGS,
      signature,
      nonce,
      address,
      logId
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
