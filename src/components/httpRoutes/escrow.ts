import express, { Request, Response } from 'express'
import { Readable } from 'stream'
import { EscrowEventsHandler } from '../core/handler/escrowHandler.js'
import { PROTOCOL_COMMANDS } from '../../utils/constants.js'
import { streamToString } from '../../utils/util.js'
import { GetEscrowEventsCommand, RangeFilter } from '../../@types/commands.js'

export const escrowRoutes = express.Router()

// Fold `<field>Min` / `<field>Max` query params into a ranges map, e.g.
// ?blockMin=100&blockMax=200&subsidyAmountMin=1000 -> { block:{min,max}, subsidyAmount:{min} }.
// Unknown/unsupported fields are rejected later by the handler's range validation.
function parseRangeParams(query: Record<string, any>): Record<string, RangeFilter> {
  const ranges: Record<string, RangeFilter> = {}
  const assign = (field: string, bound: keyof RangeFilter, value: any) => {
    if (!ranges[field]) ranges[field] = {}
    ranges[field][bound] = String(value)
  }
  for (const key of Object.keys(query)) {
    const value = query[key]
    if (value === undefined || value === '') continue
    let match: RegExpMatchArray | null
    if ((match = key.match(/^(.+)Min$/))) assign(match[1], 'min', value)
    else if ((match = key.match(/^(.+)Max$/))) assign(match[1], 'max', value)
  }
  return ranges
}

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

    let reclaimable: boolean | undefined
    if (req.query.reclaimable !== undefined) {
      reclaimable = String(req.query.reclaimable).toLowerCase() === 'true'
    }

    const ranges = parseRangeParams(req.query as Record<string, any>)

    const command: GetEscrowEventsCommand = {
      command: PROTOCOL_COMMANDS.GET_ESCROW_EVENTS,
      chainId: parsedChainId,
      eventType: req.query.eventType ? String(req.query.eventType) : undefined,
      payer: req.query.payer ? String(req.query.payer) : undefined,
      payee: req.query.payee ? String(req.query.payee) : undefined,
      token: req.query.token ? String(req.query.token) : undefined,
      provider: req.query.provider ? String(req.query.provider) : undefined,
      contract: req.query.contract ? String(req.query.contract) : undefined,
      reclaimable,
      jobId: req.query.jobId ? String(req.query.jobId) : undefined,
      txId: req.query.txId ? String(req.query.txId) : undefined,
      ranges: Object.keys(ranges).length ? ranges : undefined,
      offset: req.query.offset ? Number(req.query.offset) : undefined,
      size: req.query.size ? Number(req.query.size) : undefined,
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
