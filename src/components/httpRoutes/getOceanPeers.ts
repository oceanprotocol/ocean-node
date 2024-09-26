import express, { Request, Response } from 'express'
import { getDefaultLevel } from '../../utils/logging/Logger.js'
import { P2P_LOGGER } from '../../utils/logging/common.js'
import { sendMissingP2PResponse } from './index.js'
import { getBoolEnvValue, hasP2PInterface } from '../../utils/config.js'
export const getOceanPeersRoute = express.Router()

getOceanPeersRoute.get(
  '/getP2pNetworkStats',
  async (req: Request, res: Response): Promise<void> => {
    // only return values if env P2P_ENABLE_NETWORK_STATS is explicitly allowed
    if (hasP2PInterface && getBoolEnvValue('P2P_ENABLE_NETWORK_STATS', false)) {
      const stats = await req.oceanNode.getP2PNode().getNetworkingStats()
      P2P_LOGGER.log(getDefaultLevel(), `getP2pNetworkStats: ${stats}`, true)
      res.json(stats)
    } else {
      res.status(400).send('Not enabled or unavailable')
    }
  }
)
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
