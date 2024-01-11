import express, { Request, Response } from 'express'

export const fileInfoRoute = express.Router()

fileInfoRoute.get(
  '/api/fileinfo',
  express.urlencoded({ extended: true, type: '*/*' }),
  async (req: Request, res: Response): Promise<void> => {
    if (!req.query) {
      res.sendStatus(400)
      return
    }

    try {
      // Retrieve the file info
      res.sendStatus(200)
    } catch (error) {
      res.status(500).send(error)
    }
    // res.sendStatus(200)
  }
)
