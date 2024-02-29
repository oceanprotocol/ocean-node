import express from 'express'
import {
  ComputeGetEnvironmentsHandler,
  ComputeStartHandler,
  ComputeStopHandler,
  ComputeGetStatusHandler,
  ComputeGetResultHandler
} from '../core/compute/index.js'
import type { ComputeAlgorithm, ComputeAsset, ComputeOutput } from '../../@types/C2D.js'
import type {
  ComputeGetEnvironmentsCommand,
  ComputeStartCommand,
  ComputeStopCommand,
  ComputeGetResultCommand,
  ComputeGetStatusCommand
} from '../../@types/commands.js'

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
    const getEnvironmentsTask = {
      command: PROTOCOL_COMMANDS.COMPUTE_GET_ENVIRONMENTS,
      chainId: parseInt(req.query.chainId as string),
      node: (req.query.node as string) || null
    }
    const response = await new ComputeGetEnvironmentsHandler().handle(getEnvironmentsTask) // get compute environments
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

computeRoutes.post('/api/services/compute', async (req, res) => {
  try {
    HTTP_LOGGER.logMessage(
      `ComputeStartCommand request received with query: ${JSON.stringify(req.query)}`,
      true
    )

    const startComputeTask: ComputeStartCommand = {
      command: PROTOCOL_COMMANDS.COMPUTE_START,
      node: (req.query.node as string) || null,
      consumerAddress: (req.query.consumerAddress as string) || null,
      signature: (req.query.signature as string) || null,
      nonce: (req.query.nonce as string) || null,
      environment: (req.query.environment as string) || null,
      algorithm: (req.query.algorithm as ComputeAlgorithm) || null,
      dataset: (req.query.dataset as unknown as ComputeAsset) || null
    }
    if (req.query.additionalDatasets) {
      startComputeTask.additionalDatasets = req.query
        .additionalDatasets as unknown as ComputeAsset[]
    }
    if (req.query.output) {
      startComputeTask.output = req.query.output as ComputeOutput
    }

    const response = await new ComputeStartHandler().handle(startComputeTask) // get compute environments
    const jobs = await streamToObject(response.stream as Readable)
    res.status(200).json(jobs)
  } catch (error) {
    HTTP_LOGGER.log(LOG_LEVELS_STR.LEVEL_ERROR, `Error: ${error}`)
    res.status(500).send('Internal Server Error')
  }
})

computeRoutes.put('/api/services/compute', async (req, res) => {
  try {
    HTTP_LOGGER.logMessage(
      `ComputeStopCommand request received with query: ${JSON.stringify(req.query)}`,
      true
    )

    const stopComputeTask: ComputeStopCommand = {
      command: PROTOCOL_COMMANDS.COMPUTE_STOP,
      node: (req.query.node as string) || null,
      consumerAddress: (req.query.consumerAddress as string) || null,
      signature: (req.query.signature as string) || null,
      nonce: (req.query.nonce as string) || null,
      jobId: (req.query.jobId as string) || null
    }
    const response = await new ComputeStopHandler().handle(stopComputeTask)
    const jobs = await streamToObject(response.stream as Readable)
    res.status(200).json(jobs)
  } catch (error) {
    HTTP_LOGGER.log(LOG_LEVELS_STR.LEVEL_ERROR, `Error: ${error}`)
    res.status(500).send('Internal Server Error')
  }
})

computeRoutes.get('/api/services/compute', async (req, res) => {
  try {
    HTTP_LOGGER.logMessage(
      `ComputeGetStatusCommand request received with query: ${JSON.stringify(req.query)}`,
      true
    )
    const statusComputeTask: ComputeGetStatusCommand = {
      command: PROTOCOL_COMMANDS.COMPUTE_GET_STATUS,
      node: (req.query.node as string) || null,
      consumerAddress: (req.query.consumerAddress as string) || null,
      did: (req.query.did as string) || null,
      jobId: (req.query.jobId as string) || null
    }
    const response = await new ComputeGetStatusHandler().handle(statusComputeTask)
    const jobs = await streamToObject(response.stream as Readable)
    res.status(200).json(jobs)
  } catch (error) {
    HTTP_LOGGER.log(LOG_LEVELS_STR.LEVEL_ERROR, `Error: ${error}`)
    res.status(500).send('Internal Server Error')
  }
})

computeRoutes.get('/api/services/computeResult', async (req, res) => {
  try {
    HTTP_LOGGER.logMessage(
      `ComputeGetResultCommand request received with query: ${JSON.stringify(req.query)}`,
      true
    )
    const resultComputeTask: ComputeGetResultCommand = {
      command: PROTOCOL_COMMANDS.COMPUTE_GET_STATUS,
      node: (req.query.node as string) || null,
      consumerAddress: (req.query.consumerAddress as string) || null,
      index: parseInt(req.query.index as string) || null,
      jobId: (req.query.jobId as string) || null,
      signature: (req.query.signature as string) || null,
      nonce: (req.query.nonce as string) || null
    }

    const response = await new ComputeGetResultHandler().handle(resultComputeTask)
    if (response.stream) {
      res.status(response.status.httpStatus)
      res.set(response.status.headers)
      response.stream.pipe(res)
    } else {
      res.status(response.status.httpStatus).send(response.status.error)
    }
  } catch (error) {
    HTTP_LOGGER.log(LOG_LEVELS_STR.LEVEL_ERROR, `Error: ${error}`)
    res.status(500).send('Internal Server Error')
  }
})
