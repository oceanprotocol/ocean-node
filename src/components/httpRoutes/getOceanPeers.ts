import express, { Request, Response } from 'express'
import { getDefaultLevel } from '../../utils/logging/Logger.js'
import { P2P_LOGGER } from '../../utils/logging/common.js'
import { hasP2PInterface, sendMissingP2PResponse } from './index.js'

export const getOceanPeersRoute = express.Router()

getOceanPeersRoute.get(
  '/getOceanPeers',
  async (req: Request, res: Response): Promise<void> => {
    if (hasP2PInterface) {
      const peers = await req.oceanNode.getP2PNode().getAllOceanPeers()
      P2P_LOGGER.log(getDefaultLevel(), `getOceanPeers: ${peers}`, true)
      res.json(peers)
    } else {
      sendMissingP2PResponse(res)
    }
  }
)

export const getP2PPeersRoute = express.Router()
getP2PPeersRoute.get(
  '/getP2PPeers',
  async (req: Request, res: Response): Promise<void> => {
    if (hasP2PInterface) {
      const peers = await req.oceanNode.getP2PNode().getAllPeerStore()
      res.json(peers)
    } else {
      sendMissingP2PResponse(res)
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
    if (hasP2PInterface) {
      const peers = await req.oceanNode
        .getP2PNode()
        .getPeerDetails(String(req.query.peerId))
      res.json(peers)
    } else {
      sendMissingP2PResponse(res)
    }
  }
)
