import express from 'express'
import { GetEnvironmentsHandler, InitializeComputeHandler } from '../core/compute.js'
import { streamToObject, streamToString } from '../../utils/util.js'
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

computeRoutes.post('/api/services/initializeCompute', async (req, res) => {
  try {
    HTTP_LOGGER.logMessage(
      `POST initializeCompute request received with query: ${JSON.stringify(req.body)}`,
      true
    )
    const { body } = req
    if (!body) {
      res.status(400).send('Missing required body')
      return
    }
    if (!body.datasets && !body.algorithm) {
      res.status(400).send('Missing datasets and algorithm')
      return
    }
    for (const dataset of body.datasets) {
      if (!dataset.documentId) {
        res.status(400).send('Missing dataset did')
        return
      }
    }
    if (!body.algorithm.documentId) {
      res.status(400).send('Missing algorithm did')
      return
    }
    body.command = PROTOCOL_COMMANDS.INITIALIZE_COMPUTE
    const result = await new InitializeComputeHandler(req.oceanNode).handle(body)
    if (result.stream) {
      const queryResult = JSON.parse(await streamToString(result.stream as Readable))
      res.json(queryResult)
    } else {
      res.status(result.status.httpStatus).send(result.status.error)
    }
  } catch (error) {
    HTTP_LOGGER.log(LOG_LEVELS_STR.LEVEL_ERROR, `Error: ${error}`)
    res.status(500).send('Internal Server Error')
  }
})
