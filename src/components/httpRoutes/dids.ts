import express, { Request, Response } from 'express'

export const advertiseDidRoute = express.Router()
advertiseDidRoute.post(
  '/advertiseDid',
  express.urlencoded({ extended: true, type: '*/*' }),
  async (req: Request, res: Response): Promise<void> => {
    if (!req.query.did) {
      res.sendStatus(400)
      return
    }
    await req.oceanNode.getP2PNode().advertiseDid(req.query.did as string)
    res.sendStatus(200)
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
    const providers = await req.oceanNode
      .getP2PNode()
      .getProvidersForDid(req.query.did as string)
    res.json(providers)
  }
)
