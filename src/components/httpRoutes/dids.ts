import express, { Request, Response } from 'express'
import { sendMissingP2PResponse } from './index.js'
import { hasP2PInterface } from '../../utils/config.js'

export const advertiseDidRoute = express.Router()

advertiseDidRoute.post(
  '/advertiseDid',
  express.urlencoded({ extended: true, type: '*/*' }),
  async (req: Request, res: Response): Promise<void> => {
    if (!req.query.did) {
      res.sendStatus(400)
      return
    }
    if (hasP2PInterface) {
      await req.oceanNode.getP2PNode().advertiseDid(req.query.did as string)
      res.sendStatus(200)
    } else {
      sendMissingP2PResponse(res)
    }
  }
)

export const getProvidersForDidRoute = express.Router()
getProvidersForDidRoute.get(
  '/getProvidersForDid',
  express.urlencoded({ extended: true, type: '*/*' }),
  async (req: Request, res: Response): Promise<void> => {
    if (!req.query.did) {
      res.sendStatus(400)
      return
    }
    if (hasP2PInterface) {
      const providers = await req.oceanNode
        .getP2PNode()
        .getProvidersForDid(req.query.did as string)
      res.json(providers)
    } else {
      sendMissingP2PResponse(res)
    }
  }
)
