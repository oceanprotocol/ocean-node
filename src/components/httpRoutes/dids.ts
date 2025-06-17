import express, { Request, Response } from 'express'
import { sendMissingP2PResponse } from './index.js'
import { hasP2PInterface } from '../../utils/config.js'

export const getProvidersForStringRoute = express.Router()
getProvidersForStringRoute.get(
  '/getProvidersForString',
  express.urlencoded({ extended: true, type: '*/*' }),
  async (req: Request, res: Response): Promise<void> => {
    if (!req.query.input) {
      res.sendStatus(400)
      return
    }
    if (hasP2PInterface) {
      const providers = await req.oceanNode
        .getP2PNode()
        .getProvidersForString(req.query.input as string)
      res.json(providers)
    } else {
      sendMissingP2PResponse(res)
    }
  }
)

getProvidersForStringRoute.post('/getProvidersForStrings', async (req, res) => {
  const { body } = req
  const ret = Object()
  if (Array.isArray(body) && body.every((item) => typeof item === 'string')) {
    for (const input of body) {
      const providers = await req.oceanNode
        .getP2PNode()
        .getProvidersForString(req.query.input as string)
      ret[input] = providers
    }
    res.json(ret)
  } else {
    res.status(400).send('Expected an array of strings.')
  }
})
