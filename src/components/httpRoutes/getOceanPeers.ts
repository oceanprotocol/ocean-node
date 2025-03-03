import express, { Request, Response } from 'express'
import {
  GetP2PPeerHandler,
  GetP2PPeersHandler,
  GetP2PNetworkStatsHandler
} from '../core/handler/p2p.js'
import { PROTOCOL_COMMANDS } from '../../utils/constants.js'
import { streamToString } from '../../utils/util.js'
import { Readable } from 'stream'

export const getP2pNetworkStatsRoute = express.Router()

getP2pNetworkStatsRoute.get(
  '/getP2pNetworkStats',
  async (req: Request, res: Response): Promise<void> => {
    const node = req.oceanNode
    const result = await new GetP2PNetworkStatsHandler(node).handle({
      command: PROTOCOL_COMMANDS.GET_P2P_NETWORK_STATS
    })
    if (result.stream) {
      const validationResult = JSON.parse(await streamToString(result.stream as Readable))
      res.json(validationResult)
    } else {
      res.status(result.status.httpStatus).send(result.status.error)
    }
  }
)

getP2pNetworkStatsRoute.get(
  '/findPeer',
  express.urlencoded({ extended: true }),
  async (req: Request, res: Response): Promise<void> => {
    if (!req.query.peerId) {
      res.sendStatus(400)
      return
    }
    if (hasP2PInterface) {
      const peers = await req.oceanNode
        .getP2PNode()
        .findPeerInDht(String(req.query.peerId), parseInt(String(req.query.timeout)))
      if (peers) res.json(peers)
      else res.sendStatus(404).send('Cannot find peer')
    } else {
      sendMissingP2PResponse(res)
    }
  }
)

export const getP2PPeersRoute = express.Router()
getP2PPeersRoute.get(
  '/getP2PPeers',
  async (req: Request, res: Response): Promise<void> => {
    const node = req.oceanNode
    const result = await new GetP2PPeersHandler(node).handle({
      command: PROTOCOL_COMMANDS.GET_P2P_PEERS
    })
    if (result.stream) {
      const validationResult = JSON.parse(await streamToString(result.stream as Readable))
      res.json(validationResult)
    } else {
      res.status(result.status.httpStatus).send(result.status.error)
    }
  }
)

export const getP2PPeerRoute = express.Router()
getP2PPeersRoute.get(
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
      peerId: req.query.peerId as string
    })
    if (result.stream) {
      const validationResult = JSON.parse(await streamToString(result.stream as Readable))
      res.json(validationResult)
    } else {
      res.status(result.status.httpStatus).send(result.status.error)
    }
  }
)
