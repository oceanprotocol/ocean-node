import express from 'express'
import {
  ComputeGetEnvironmentsHandler,
  PaidComputeStartHandler,
  FreeComputeStartHandler,
  ComputeStopHandler,
  ComputeGetStatusHandler,
  ComputeGetResultHandler,
  ComputeInitializeHandler,
  ComputeGetStreamableLogsHandler
} from '../core/compute/index.js'
import type {
  ComputeAlgorithm,
  ComputeAsset,
  ComputeOutput,
  ComputeResourceRequest
} from '../../@types/C2D/C2D.js'
import type {
  PaidComputeStartCommand,
  ComputePayment,
  FreeComputeStartCommand,
  ComputeStopCommand,
  ComputeGetResultCommand,
  ComputeGetStatusCommand,
  ComputeGetStreamableLogsCommand
} from '../../@types/commands.js'

import { streamToObject, streamToString } from '../../utils/util.js'
import { PROTOCOL_COMMANDS, SERVICES_API_BASE_PATH } from '../../utils/constants.js'
import { Readable } from 'stream'
import { HTTP_LOGGER } from '../../utils/logging/common.js'
import { LOG_LEVELS_STR } from '../../utils/logging/Logger.js'
import { PolicyServerTask } from '../../@types/policyServer.js'

export const computeRoutes = express.Router()

computeRoutes.get(`${SERVICES_API_BASE_PATH}/computeEnvironments`, async (req, res) => {
  try {
    HTTP_LOGGER.logMessage(
      `GET computeEnvironments request received with query: ${JSON.stringify(req.query)}`,
      true
    )
    const getEnvironmentsTask = {
      command: PROTOCOL_COMMANDS.COMPUTE_GET_ENVIRONMENTS,
      chainId: parseInt(req.query.chainId as string) || null,
      node: (req.query.node as string) || null
    }
    const response = await new ComputeGetEnvironmentsHandler(req.oceanNode).handle(
      getEnvironmentsTask
    ) // get compute environments
    const computeEnvironments = await streamToObject(response.stream as Readable)

    // always return the array, even if it's empty
    res.json(computeEnvironments)
  } catch (error) {
    HTTP_LOGGER.log(LOG_LEVELS_STR.LEVEL_ERROR, `Error: ${error}`)
    res.status(500).send('Internal Server Error')
  }
})

// start compute
computeRoutes.post(`${SERVICES_API_BASE_PATH}/compute`, async (req, res) => {
  try {
    HTTP_LOGGER.logMessage(
      `ComputeStartCommand request received as body params: ${JSON.stringify(req.body)}`,
      true
    )

    const startComputeTask: PaidComputeStartCommand = {
      command: PROTOCOL_COMMANDS.COMPUTE_START,
      node: (req.body.node as string) || null,
      consumerAddress: (req.body.consumerAddress as string) || null,
      signature: (req.body.signature as string) || null,
      nonce: (req.body.nonce as string) || null,
      environment: (req.body.environment as string) || null,
      maxJobDuration: (req.body.maxJobDuration as number) || null,
      algorithm: (req.body.algorithm as ComputeAlgorithm) || null,
      datasets: (req.body.datasets as unknown as ComputeAsset[]) || null,
      payment: (req.body.payment as unknown as ComputePayment) || null,
      resources: (req.body.resources as unknown as ComputeResourceRequest[]) || null,
      policyServer: (req.query.policyServer as PolicyServerTask) || null,
      metadata: req.body.metadata || null,
      authorization: req.headers?.authorization
    }
    if (req.body.output) {
      startComputeTask.output = req.body.output as ComputeOutput
    }

    const response = await new PaidComputeStartHandler(req.oceanNode).handle(
      startComputeTask
    )
    if (response?.status?.httpStatus === 200) {
      const jobs = await streamToObject(response.stream as Readable)
      res.status(200).json(jobs)
    } else {
      HTTP_LOGGER.log(LOG_LEVELS_STR.LEVEL_INFO, `Error: ${response?.status?.error}`)
      res.status(response?.status.httpStatus).json(response?.status?.error)
    }
  } catch (error) {
    HTTP_LOGGER.log(LOG_LEVELS_STR.LEVEL_ERROR, `Error: ${error}`)
    res.status(500).send('Internal Server Error')
  }
})

// free compute
computeRoutes.post(`${SERVICES_API_BASE_PATH}/freeCompute`, async (req, res) => {
  try {
    HTTP_LOGGER.logMessage(
      `FreeComputeStartCommand request received as body params: ${JSON.stringify(
        req.body
      )}`,
      true
    )
    const startComputeTask: FreeComputeStartCommand = {
      command: PROTOCOL_COMMANDS.FREE_COMPUTE_START,
      node: (req.body.node as string) || null,
      consumerAddress: (req.body.consumerAddress as string) || null,
      signature: (req.body.signature as string) || null,
      nonce: (req.body.nonce as string) || null,
      environment: (req.body.environment as string) || null,
      algorithm: (req.body.algorithm as ComputeAlgorithm) || null,
      datasets: (req.body.datasets as unknown as ComputeAsset[]) || null,
      resources: (req.body.resources as unknown as ComputeResourceRequest[]) || null,
      maxJobDuration: req.body.maxJobDuration || null,
      policyServer: (req.query.policyServer as PolicyServerTask) || null,
      metadata: req.body.metadata || null,
      authorization: req.headers?.authorization
    }
    if (req.body.output) {
      startComputeTask.output = req.body.output as ComputeOutput
    }

    const response = await new FreeComputeStartHandler(req.oceanNode).handle(
      startComputeTask
    )
    if (response?.status?.httpStatus === 200) {
      const jobs = await streamToObject(response.stream as Readable)
      res.status(200).json(jobs)
    } else {
      HTTP_LOGGER.log(LOG_LEVELS_STR.LEVEL_INFO, `Error: ${response?.status?.error}`)
      res.status(response?.status.httpStatus).json(response?.status?.error)
    }
  } catch (error) {
    HTTP_LOGGER.log(LOG_LEVELS_STR.LEVEL_ERROR, `Error: ${error}`)
    res.status(500).send('Internal Server Error')
  }
})

// stop compute
computeRoutes.put(`${SERVICES_API_BASE_PATH}/compute`, async (req, res) => {
  try {
    HTTP_LOGGER.logMessage(
      `ComputeStopCommand request received as body parameters : ${JSON.stringify(
        req.body
      )}`,
      true
    )

    const stopComputeTask: ComputeStopCommand = {
      command: PROTOCOL_COMMANDS.COMPUTE_STOP,
      node: (req.query.node as string) || null,
      consumerAddress: (req.query.consumerAddress as string) || null,
      signature: (req.query.signature as string) || null,
      nonce: (req.query.nonce as string) || null,
      jobId: (req.query.jobId as string) || null,
      agreementId: (req.query.agreementId as string) || null
    }
    const response = await new ComputeStopHandler(req.oceanNode).handle(stopComputeTask)
    const jobs = await streamToObject(response.stream as Readable)
    res.status(200).json(jobs)
  } catch (error) {
    HTTP_LOGGER.log(LOG_LEVELS_STR.LEVEL_ERROR, `Error: ${error}`)
    res.status(500).send('Internal Server Error')
  }
})

// get status
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
      jobId: (req.query.jobId as string) || null,
      agreementId: (req.query.agreementId as string) || null
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

// compute results
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
      index: req.query.index ? Number(req.query.index) : null, // can't be parseInt() because that excludes index 0
      jobId: (req.query.jobId as string) || null,
      signature: (req.query.signature as string) || null,
      nonce: (req.query.nonce as string) || null,
      authorization: req.headers?.authorization
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

// streaming logs
computeRoutes.get(`${SERVICES_API_BASE_PATH}/computeStreamableLogs`, async (req, res) => {
  try {
    HTTP_LOGGER.logMessage(
      `ComputeGetStreamableLogsCommand request received with query: ${JSON.stringify(
        req.query
      )}`,
      true
    )

    const resultComputeTask: ComputeGetStreamableLogsCommand = {
      command: PROTOCOL_COMMANDS.COMPUTE_GET_STREAMABLE_LOGS,
      node: (req.query.node as string) || null,
      consumerAddress: (req.query.consumerAddress as string) || null,
      jobId: (req.query.jobId as string) || null,
      signature: (req.query.signature as string) || null,
      nonce: (req.query.nonce as string) || null,
      authorization: req.headers?.authorization
    }

    const response = await new ComputeGetStreamableLogsHandler(req.oceanNode).handle(
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
