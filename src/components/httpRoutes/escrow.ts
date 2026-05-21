import express, { Request, Response } from 'express'
import { Readable } from 'stream'
import { EscrowEventsHandler } from '../core/handler/escrowHandler.js'
import { PROTOCOL_COMMANDS } from '../../utils/constants.js'
import { streamToString } from '../../utils/util.js'
import { GetEscrowEventsCommand } from '../../@types/commands.js'

export const escrowRoutes = express.Router()

escrowRoutes.get(
  '/api/services/escrow/events',
  async (req: Request, res: Response): Promise<void> => {
    const { chainId } = req.query
    let parsedChainId: number | undefined
    if (chainId !== undefined) {
      parsedChainId = Number(chainId)
      if (Number.isNaN(parsedChainId)) {
        res.status(400).send('chainId must be a number')
        return
      }
    }

    const command: GetEscrowEventsCommand = {
      command: PROTOCOL_COMMANDS.GET_ESCROW_EVENTS,
      chainId: parsedChainId,
      eventType: req.query.eventType ? String(req.query.eventType) : undefined,
      payer: req.query.payer ? String(req.query.payer) : undefined,
      payee: req.query.payee ? String(req.query.payee) : undefined,
      token: req.query.token ? String(req.query.token) : undefined,
      jobId: req.query.jobId ? String(req.query.jobId) : undefined,
      txId: req.query.txId ? String(req.query.txId) : undefined,
      maxResultsPerPage: req.query.maxResultsPerPage
        ? Number(req.query.maxResultsPerPage)
        : undefined,
      pageNumber: req.query.pageNumber ? Number(req.query.pageNumber) : undefined,
      caller: req.caller
    }

    const result = await new EscrowEventsHandler(req.oceanNode).handle(command)
    if (result.stream) {
      const data = JSON.parse(await streamToString(result.stream as Readable))
      res.json(data)
    } else {
      res.status(result.status.httpStatus).send(result.status.error)
    }
  }
)
