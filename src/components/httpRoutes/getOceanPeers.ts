import express, { Request, Response } from 'express'
import { getDefaultLevel } from '../../utils/logging/Logger.js'
import { P2P_CONSOLE_LOGGER } from '../../utils/logging/common.js'

export const getOceanPeersRoute = express.Router()
getOceanPeersRoute.get(
  '/getOceanPeers',
  async (req: Request, res: Response): Promise<void> => {
    const peers = await req.oceanNode.getP2PNode().getPeers()
    P2P_CONSOLE_LOGGER.log(getDefaultLevel(), `getOceanPeers: ${peers}`, true)
    res.json(peers)
  }
)

export const getP2PPeersRoute = express.Router()
getP2PPeersRoute.get(
  '/getP2PPeers',
  async (req: Request, res: Response): Promise<void> => {
    const peers = await req.oceanNode.getP2PNode().getAllPeerStore()
    res.json(peers)
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
    const peers = await req.oceanNode
      .getP2PNode()
      .getPeerDetails(String(req.query.peerId))
    res.json(peers)
  }
)
