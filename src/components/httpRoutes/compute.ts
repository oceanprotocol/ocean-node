import express from 'express'
import {
  ComputeGetEnvironmentsHandler,
  ComputeStartHandler,
  ComputeStopHandler,
  ComputeGetStatusHandler,
  ComputeGetResultHandler,
  ComputeInitializeHandler
} from '../core/compute/index.js'
import type { ComputeAlgorithm, ComputeAsset, ComputeOutput } from '../../@types/C2D.js'
import type {
  ComputeStartCommand,
  ComputeStopCommand,
  ComputeGetResultCommand,
  ComputeGetStatusCommand
} from '../../@types/commands.js'

import { streamToObject, streamToString } from '../../utils/util.js'
import { PROTOCOL_COMMANDS, SERVICES_API_BASE_PATH } from '../../utils/constants.js'
import { Readable } from 'stream'
import { HTTP_LOGGER } from '../../utils/logging/common.js'
import { LOG_LEVELS_STR } from '../../utils/logging/Logger.js'

export const computeRoutes = express.Router()

computeRoutes.get(`${SERVICES_API_BASE_PATH}/computeEnvironments`, async (req, res) => {
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
    const response = await new ComputeGetEnvironmentsHandler(req.oceanNode).handle(
      getEnvironmentsTask
    ) // get compute environments
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

computeRoutes.post(`${SERVICES_API_BASE_PATH}/compute`, async (req, res) => {
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

    const response = await new ComputeStartHandler(req.oceanNode).handle(startComputeTask) // get compute environments
    const jobs = await streamToObject(response.stream as Readable)
    res.status(200).json(jobs)
  } catch (error) {
    HTTP_LOGGER.log(LOG_LEVELS_STR.LEVEL_ERROR, `Error: ${error}`)
    res.status(500).send('Internal Server Error')
  }
})

computeRoutes.put(`${SERVICES_API_BASE_PATH}/compute`, async (req, res) => {
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
    const response = await new ComputeStopHandler(req.oceanNode).handle(stopComputeTask)
    const jobs = await streamToObject(response.stream as Readable)
    res.status(200).json(jobs)
  } catch (error) {
    HTTP_LOGGER.log(LOG_LEVELS_STR.LEVEL_ERROR, `Error: ${error}`)
    res.status(500).send('Internal Server Error')
  }
})

computeRoutes.get(`${SERVICES_API_BASE_PATH}/compute`, async (req, res) => {
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
    const response = await new ComputeGetStatusHandler(req.oceanNode).handle(
      statusComputeTask
    )
    const jobs = await streamToObject(response.stream as Readable)
    res.status(200).json(jobs)
  } catch (error) {
    HTTP_LOGGER.log(LOG_LEVELS_STR.LEVEL_ERROR, `Error: ${error}`)
    res.status(500).send('Internal Server Error')
  }
})

computeRoutes.get(`${SERVICES_API_BASE_PATH}/computeResult`, async (req, res) => {
  try {
    HTTP_LOGGER.logMessage(
      `ComputeGetResultCommand request received with query: ${JSON.stringify(req.query)}`,
      true
    )
    const resultComputeTask: ComputeGetResultCommand = {
      command: PROTOCOL_COMMANDS.COMPUTE_GET_RESULT,
      node: (req.query.node as string) || null,
      consumerAddress: (req.query.consumerAddress as string) || null,
      index: parseInt(req.query.index as string) || null,
      jobId: (req.query.jobId as string) || null,
      signature: (req.query.signature as string) || null,
      nonce: (req.query.nonce as string) || null
    }

    const response = await new ComputeGetResultHandler(req.oceanNode).handle(
      resultComputeTask
    )
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
computeRoutes.post(`${SERVICES_API_BASE_PATH}/initializeCompute`, async (req, res) => {
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
    body.command = PROTOCOL_COMMANDS.COMPUTE_INITIALIZE
    const result = await new ComputeInitializeHandler(req.oceanNode).handle(body)
    if (result.stream) {
      const queryResult = JSON.parse(await streamToString(result.stream as Readable))
      res.json(queryResult)
    } else {
      HTTP_LOGGER.log(
        LOG_LEVELS_STR.LEVEL_ERROR,
        `Stream not found: ${result.status.error}`
      )
      res.status(result.status.httpStatus).send(result.status.error)
    }
  } catch (error) {
    HTTP_LOGGER.log(LOG_LEVELS_STR.LEVEL_ERROR, `Error: ${error}`)
    res.status(500).send('Internal Server Error')
  }
})

computeRoutes.delete(`${SERVICES_API_BASE_PATH}/compute`, (req, res) => {
  res.status(404).send('Not yet implemented!')
})
