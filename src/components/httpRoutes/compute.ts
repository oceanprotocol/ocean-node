import express from 'express'
import { GetEnvironmentsHandler } from '../core/compute.js'
import { streamToObject } from '../../utils/util.js'
import { PROTOCOL_COMMANDS } from '../../utils/constants.js'
import { Readable } from 'stream'

export const computeRoutes = express.Router()

computeRoutes.get('/api/services/computeEnvironments', async (req, res) => {
  try {
    const chainId = parseInt(req.query.chainId as string)
    if (isNaN(chainId) && chainId < 0) {
      return res.status(400).send('Invalid chainId')
    }

    const getEnvironmentsTask = {
      command: PROTOCOL_COMMANDS.GET_COMPUTE_ENVIRONMENTS,
      chainId
    }
    const response = await new GetEnvironmentsHandler().handle(getEnvironmentsTask) // get compute environments
    const computeEnvironments = await streamToObject(response.stream as Readable)

    // check if computeEnvironments is a valid json object and not empty
    if (computeEnvironments && computeEnvironments.length > 0) {
      res.json(computeEnvironments)
    } else {
      res.status(404).send('Compute environments not found')
    }
  } catch (error) {
    res.status(500).send('Internal Server Error')
  }
})
