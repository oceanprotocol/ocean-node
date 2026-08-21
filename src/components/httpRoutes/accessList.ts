import express, { Request, Response } from 'express'
import { Readable } from 'stream'
import { isAddress } from 'ethers'
import {
  GetAccessListHandler,
  SearchAccessListHandler
} from '../core/handler/accessListHandler.js'
import { PROTOCOL_COMMANDS } from '../../utils/constants.js'
import { streamToString } from '../../utils/util.js'

export const accessListRoutes = express.Router()

accessListRoutes.get(
  '/api/services/accesslists',
  async (req: Request, res: Response): Promise<void> => {
    const { wallet } = req.query
    if (typeof wallet !== 'string' || !wallet) {
      res.status(400).send('Missing required query param: wallet')
      return
    }
    if (!isAddress(wallet)) {
      res.status(400).send('Invalid wallet address')
      return
    }
    const chainIdQuery = req.query.chainId
    let chainId: number | undefined
    if (chainIdQuery !== undefined) {
      chainId = Number(chainIdQuery)
      if (Number.isNaN(chainId)) {
        res.status(400).send('chainId must be a number')
        return
      }
    }
    const result = await new SearchAccessListHandler(req.oceanNode).handle({
      command: PROTOCOL_COMMANDS.SEARCH_ACCESS_LIST,
      wallet,
      chainId,
      caller: req.caller
    })
    if (result.stream) {
      const data = JSON.parse(await streamToString(result.stream as Readable))
      res.json(data)
    } else {
      res.status(result.status.httpStatus).send(result.status.error)
    }
  }
)

accessListRoutes.get(
  '/api/services/accesslists/:chainId/:contractAddress',
  // params are named explicitly: in @types/express 5 a bare `Request` types
  // req.params values as `string | string[]`, since path-to-regexp 8 allows repeats
  async (
    req: Request<{ chainId: string; contractAddress: string }>,
    res: Response
  ): Promise<void> => {
    const result = await new GetAccessListHandler(req.oceanNode).handle({
      command: PROTOCOL_COMMANDS.GET_ACCESS_LIST,
      chainId: Number(req.params.chainId),
      contractAddress: req.params.contractAddress,
      caller: req.caller
    })
    if (result.stream) {
      const data = JSON.parse(await streamToString(result.stream as Readable))
      res.json(data)
    } else {
      res.status(result.status.httpStatus).send(result.status.error)
    }
  }
)
