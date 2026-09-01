import express, { Request, Response } from 'express'
import { Readable } from 'stream'
import {
  GetNodeMetricsHandler,
  GetNodeMetricsHistoryHandler
} from '../core/handler/nodeMetrics.js'
import { PROTOCOL_COMMANDS } from '../../utils/constants.js'
import { streamToString } from '../../utils/util.js'
import {
  GetNodeMetricsCommand,
  GetNodeMetricsHistoryCommand
} from '../../@types/commands.js'

export const nodeMetricsRoutes = express.Router()

nodeMetricsRoutes.get(
  '/nodeMetrics',
  async (req: Request, res: Response): Promise<void> => {
    const command: GetNodeMetricsCommand = {
      command: PROTOCOL_COMMANDS.GET_NODE_METRICS,
      caller: req.caller
    }
    const result = await new GetNodeMetricsHandler(req.oceanNode).handle(command)
    if (result.stream) {
      const data = JSON.parse(await streamToString(result.stream as Readable))
      res.json(data)
    } else {
      res.status(result.status.httpStatus).send(result.status.error)
    }
  }
)

nodeMetricsRoutes.get(
  '/nodeMetrics/history',
  express.urlencoded({ extended: true }),
  async (req: Request, res: Response): Promise<void> => {
    const command: GetNodeMetricsHistoryCommand = {
      command: PROTOCOL_COMMANDS.GET_NODE_METRICS_HISTORY,
      startTime: req.query.startTime ? String(req.query.startTime) : undefined,
      stopTime: req.query.stopTime ? String(req.query.stopTime) : undefined,
      caller: req.caller
    }
    const result = await new GetNodeMetricsHistoryHandler(req.oceanNode).handle(command)
    if (result.stream) {
      const data = JSON.parse(await streamToString(result.stream as Readable))
      res.json(data)
    } else {
      res.status(result.status.httpStatus).send(result.status.error)
    }
  }
)
