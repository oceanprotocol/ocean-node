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

export const getProvidersForStringsRoute = express.Router()
getProvidersForStringsRoute.post(
  '/getProvidersForStrings',
  express.json(),
  async (req, res) => {
    try {
      if (!req.body) {
        res.status(400).send('Missing array of strings in request body.')
        return
      }
      // const body = JSON.parse(req.body)
      if (
        Array.isArray(req.body) &&
        req.body.every((item: unknown) => typeof item === 'string')
      ) {
        const timeout =
          typeof req.query?.timeout === 'string'
            ? parseInt(req.query.timeout, 10)
            : undefined
        const providers = await req.oceanNode
          .getP2PNode()
          .getProvidersForStrings(req.body, timeout)

        res.json(providers)
      } else {
        res.status(400).send('Expected an array of strings.')
      }
    } catch (error) {
      console.error('Error processing request:', error)
      res.status(400).send(error)
    }
  }
)
