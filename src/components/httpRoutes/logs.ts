import express from 'express'
import { HTTP_LOGGER } from '../../utils/logging/common.js'
import { GetLogsHandler } from '../core/admin/getLogsHandler.js'
import { PROTOCOL_COMMANDS } from '../../utils/constants.js'
import { streamToObject } from '../../utils/util.js'
import { Readable } from 'node:stream'

export const logRoutes = express.Router()

function parseQueryInt(value: unknown): number | undefined {
  const parsed = typeof value === 'string' ? parseInt(value, 10) : NaN
  return Number.isFinite(parsed) ? parsed : undefined
}

logRoutes.post('/logs', express.json(), async (req, res) => {
  try {
    const { signature, address, nonce } = req.body

    // NaN (missing or not a number) becomes undefined: the handler defaults to 100 logs
    // (max 1000) and to the first page
    const maxLogs = parseQueryInt(req.query.maxLogs)
    const moduleName =
      typeof req.query.moduleName === 'string' ? req.query.moduleName : undefined
    const level = typeof req.query.level === 'string' ? req.query.level : undefined
    const page = parseQueryInt(req.query.page)

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
      HTTP_LOGGER.logByStatus(
        response.status.httpStatus,
        `Error fetching logs: ${response.status.error}`
      )
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
      return
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
      HTTP_LOGGER.logByStatus(
        response.status.httpStatus,
        `Error fetching logs: ${response.status.error}`
      )
      res.status(response.status.httpStatus).json({ error: response.status.error })
    }
  } catch (error) {
    HTTP_LOGGER.error(`Error retrieving logs: ${error.message}`)
    res.status(500).send(`Internal Server Error: ${error.message}`)
  }
})
