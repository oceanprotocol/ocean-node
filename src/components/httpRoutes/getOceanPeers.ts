import express, { Request, Response } from 'express'
import {
  GetP2PPeerHandler,
  GetP2PPeersHandler,
  GetP2PNetworkStatsHandler,
  FindPeerHandler
} from '../core/handler/p2p.js'
import { PROTOCOL_COMMANDS } from '../../utils/constants.js'
import { streamToString } from '../../utils/util.js'
import { Readable } from 'stream'
export const p2pRoutes = express.Router()

p2pRoutes.get(
  '/getP2pNetworkStats',
  async (req: Request, res: Response): Promise<void> => {
    const node = req.oceanNode
    const result = await new GetP2PNetworkStatsHandler(node).handle({
      command: PROTOCOL_COMMANDS.GET_P2P_NETWORK_STATS,
      caller: req.caller
    })
    if (result.stream) {
      const validationResult = JSON.parse(await streamToString(result.stream as Readable))
      res.json(validationResult)
    } else {
      res.status(result.status.httpStatus).send(result.status.error)
    }
  }
)

p2pRoutes.get(
  '/findPeer',
  express.urlencoded({ extended: true }),
  async (req: Request, res: Response): Promise<void> => {
    if (!req.query.peerId) {
      res.sendStatus(400)
      return
    }
    const node = req.oceanNode
    const result = await new FindPeerHandler(node).handle({
      command: PROTOCOL_COMMANDS.FIND_PEER,
      peerId: req.query.peerId as string,
      timeout: req.query.timeout as string,
      caller: req.caller
    })
    if (result.stream) {
      const validationResult = JSON.parse(await streamToString(result.stream as Readable))
      res.json(validationResult)
    } else {
      res.status(result.status.httpStatus).send(result.status.error)
    }
  }
)

export const getP2PPeersRoute = express.Router()
p2pRoutes.get('/getP2PPeers', async (req: Request, res: Response): Promise<void> => {
  const node = req.oceanNode
  const result = await new GetP2PPeersHandler(node).handle({
    command: PROTOCOL_COMMANDS.GET_P2P_PEERS,
    caller: req.caller
  })
  if (result.stream) {
    const validationResult = JSON.parse(await streamToString(result.stream as Readable))
    res.json(validationResult)
  } else {
    res.status(result.status.httpStatus).send(result.status.error)
  }
})

export const getP2PPeerRoute = express.Router()
p2pRoutes.get(
  '/getP2PPeer',
  express.urlencoded({ extended: true }),
  async (req: Request, res: Response): Promise<void> => {
    if (!req.query.peerId) {
      res.sendStatus(400)
      return
    }
    const node = req.oceanNode
    const result = await new GetP2PPeerHandler(node).handle({
      command: PROTOCOL_COMMANDS.GET_P2P_PEER,
      peerId: req.query.peerId as string,
      caller: req.caller
    })
    if (result.stream) {
      const validationResult = JSON.parse(await streamToString(result.stream as Readable))
      res.json(validationResult)
    } else {
      res.status(result.status.httpStatus).send(result.status.error)
    }
  }
)
