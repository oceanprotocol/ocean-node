import express from 'express'
import { GetEnvironmentsHandler } from '../core/compute.js'
import { streamToObject } from '../../utils/util.js'
import { PROTOCOL_COMMANDS } from '../../utils/constants.js'
import { Readable } from 'stream'
import { HTTP_LOGGER } from '../../utils/logging/common.js'
import { LOG_LEVELS_STR } from '../../utils/logging/Logger.js'

export const computeRoutes = express.Router()

computeRoutes.get('/api/services/computeEnvironments', async (req, res) => {
  try {
    HTTP_LOGGER.logMessage(
      `GET computeEnvironments request received with query: ${JSON.stringify(req.query)}`,
      true
    )
    const chainId = parseInt(req.query.chainId as string)

    if (isNaN(chainId) || chainId < 1) {
      HTTP_LOGGER.logMessage(
        `Invalid chainId: ${chainId} on GET computeEnvironments request`,
        true
      )
      return res.status(400).send('Invalid chainId')
    }

    const getEnvironmentsTask = {
      command: PROTOCOL_COMMANDS.GET_COMPUTE_ENVIRONMENTS,
      chainId,
      node: req.query.node as string
    }
    const response = await new GetEnvironmentsHandler().handle(getEnvironmentsTask) // get compute environments
    const computeEnvironments = await streamToObject(response.stream as Readable)

    // check if computeEnvironments is a valid json object and not empty
    if (computeEnvironments && computeEnvironments.length > 0) {
      res.json(computeEnvironments)
    } else {
      HTTP_LOGGER.logMessage(`Compute environments not found`, true)
      res.status(404).send('Compute environments not found')
    }
  } catch (error) {
    HTTP_LOGGER.log(LOG_LEVELS_STR.LEVEL_ERROR, `Error: ${error}`)
    res.status(500).send('Internal Server Error')
  }
})
