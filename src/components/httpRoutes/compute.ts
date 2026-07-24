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
  ComputeResourceRequest
} from '../../@types/C2D/C2D.js'
import type {
  PaidComputeStartCommand,
  ComputePayment,
  FreeComputeStartCommand,
  ComputeStopCommand,
  ComputeGetResultCommand,
  ComputeGetStatusCommand,
  ComputeGetStreamableLogsCommand,
  ServiceGetTemplatesCommand,
  ServiceStartCommand,
  ServiceStopCommand,
  ServiceExtendCommand,
  ServiceRestartCommand,
  ServiceGetStatusCommand,
  GetServicesCommand,
  ServiceGetStreamableLogsCommand
} from '../../@types/commands.js'
import {
  ServiceGetTemplatesHandler,
  ServiceStartHandler,
  ServiceStopHandler,
  ServiceExtendHandler,
  ServiceRestartHandler,
  ServiceGetStatusHandler,
  GetServicesHandler,
  ServiceGetStreamableLogsHandler
} from '../core/service/index.js'

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
      chainId: parseInt(req.query.chainId as string) || null,
      node: (req.query.node as string) || null,
      caller: req.caller
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
      policyServer: (req.body.policyServer as any) || null,
      metadata: req.body.metadata || null,
      authorization: req.headers?.authorization,
      additionalViewers: (req.body.additionalViewers as unknown as string[]) || null,
      queueMaxWaitTime: req.body.queueMaxWaitTime || 0,
      caller: req.caller,
      encryptedDockerRegistryAuth:
        (req.body.encryptedDockerRegistryAuth as string) || null
    }
    if (req.body.output) {
      startComputeTask.output = req.body.output
    }
    if (req.body.outputBucketId) {
      startComputeTask.outputBucketId = req.body.outputBucketId
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
      policyServer: (req.body.policyServer as any) || null,
      metadata: req.body.metadata || null,
      authorization: req.headers?.authorization,
      additionalViewers: (req.body.additionalViewers as unknown as string[]) || null,
      queueMaxWaitTime: req.body.queueMaxWaitTime || 0,
      caller: req.caller,
      encryptedDockerRegistryAuth:
        (req.body.encryptedDockerRegistryAuth as string) || null
    }
    if (req.body.output) {
      startComputeTask.output = req.body.output
    }
    if (req.body.outputBucketId) {
      startComputeTask.outputBucketId = req.body.outputBucketId
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
      agreementId: (req.query.agreementId as string) || null,
      authorization: req.headers?.authorization || null,
      caller: req.caller
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
      agreementId: (req.query.agreementId as string) || null,
      caller: req.caller
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
      authorization: req.headers?.authorization,
      caller: req.caller
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
      authorization: req.headers?.authorization,
      caller: req.caller
    }

    const response = await new ComputeGetStreamableLogsHandler(req.oceanNode).handle(
      resultComputeTask
    )
    if (response.stream) {
      res.status(response.status.httpStatus)
      res.set(response.status.headers)
      response.stream.pipe(res)
    } else {
      const body =
        response.status.error ??
        (response.status.httpStatus === 404 ? 'Job not found or not running' : 'Error')
      res.status(response.status.httpStatus).send(body)
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

    body.datasets = body.datasets || []

    if (!body.algorithm) {
      res.status(400).send('Missing algorithm')
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

// ── Service on Demand ─────────────────────────────────────────────────

async function runServiceCommand(
  HandlerClass: any,
  task: any,
  res: express.Response
): Promise<void> {
  try {
    const response = await new HandlerClass(res.req.oceanNode).handle(task)
    if (response?.status?.httpStatus === 200) {
      const result = await streamToObject(response.stream as Readable)
      res.status(200).json(result)
    } else {
      HTTP_LOGGER.log(LOG_LEVELS_STR.LEVEL_INFO, `Error: ${response?.status?.error}`)
      res.status(response?.status?.httpStatus || 500).json(response?.status?.error)
    }
  } catch (error) {
    HTTP_LOGGER.log(LOG_LEVELS_STR.LEVEL_ERROR, `Error: ${error}`)
    res.status(500).send('Internal Server Error')
  }
}

computeRoutes.get(`${SERVICES_API_BASE_PATH}/serviceTemplates`, async (req, res) => {
  const task: ServiceGetTemplatesCommand = {
    command: PROTOCOL_COMMANDS.SERVICE_GET_TEMPLATES,
    chainId: parseInt(req.query.chainId as string) || undefined,
    node: (req.query.node as string) || null,
    caller: req.caller
  }
  await runServiceCommand(ServiceGetTemplatesHandler, task, res)
})

computeRoutes.post(`${SERVICES_API_BASE_PATH}/serviceStart`, async (req, res) => {
  const task: ServiceStartCommand = {
    command: PROTOCOL_COMMANDS.SERVICE_START,
    node: (req.body.node as string) || null,
    consumerAddress: (req.body.consumerAddress as string) || null,
    nonce: (req.body.nonce as string) || null,
    signature: (req.body.signature as string) || null,
    environment: (req.body.environment as string) || null,
    image: (req.body.image as string) || null,
    tag: (req.body.tag as string) || undefined,
    checksum: (req.body.checksum as string) || undefined,
    dockerfile: (req.body.dockerfile as string) || undefined,
    additionalDockerFiles: req.body.additionalDockerFiles || undefined,
    dockerCmd: (req.body.dockerCmd as string[]) || undefined,
    dockerEntrypoint: (req.body.dockerEntrypoint as string[]) || undefined,
    exposedPorts: (req.body.exposedPorts as number[]) || undefined,
    resources: (req.body.resources as ComputeResourceRequest[]) || undefined,
    duration: req.body.duration as number,
    userData: (req.body.userData as string) || undefined,
    payment: req.body.payment,
    authorization: req.headers?.authorization,
    caller: req.caller
  }
  await runServiceCommand(ServiceStartHandler, task, res)
})

computeRoutes.post(`${SERVICES_API_BASE_PATH}/serviceStop`, async (req, res) => {
  const task: ServiceStopCommand = {
    command: PROTOCOL_COMMANDS.SERVICE_STOP,
    node: (req.body.node as string) || null,
    consumerAddress: (req.body.consumerAddress as string) || null,
    nonce: (req.body.nonce as string) || null,
    signature: (req.body.signature as string) || null,
    serviceId: (req.body.serviceId as string) || null,
    authorization: req.headers?.authorization,
    caller: req.caller
  }
  await runServiceCommand(ServiceStopHandler, task, res)
})

computeRoutes.post(`${SERVICES_API_BASE_PATH}/serviceExtend`, async (req, res) => {
  const task: ServiceExtendCommand = {
    command: PROTOCOL_COMMANDS.SERVICE_EXTEND,
    node: (req.body.node as string) || null,
    consumerAddress: (req.body.consumerAddress as string) || null,
    nonce: (req.body.nonce as string) || null,
    signature: (req.body.signature as string) || null,
    serviceId: (req.body.serviceId as string) || null,
    additionalDuration: req.body.additionalDuration as number,
    payment: req.body.payment,
    authorization: req.headers?.authorization,
    caller: req.caller
  }
  await runServiceCommand(ServiceExtendHandler, task, res)
})

computeRoutes.post(`${SERVICES_API_BASE_PATH}/serviceRestart`, async (req, res) => {
  const task: ServiceRestartCommand = {
    command: PROTOCOL_COMMANDS.SERVICE_RESTART,
    node: (req.body.node as string) || null,
    consumerAddress: (req.body.consumerAddress as string) || null,
    nonce: (req.body.nonce as string) || null,
    signature: (req.body.signature as string) || null,
    serviceId: (req.body.serviceId as string) || null,
    image: (req.body.image as string) || undefined,
    tag: (req.body.tag as string) || undefined,
    checksum: (req.body.checksum as string) || undefined,
    dockerfile: (req.body.dockerfile as string) || undefined,
    additionalDockerFiles:
      (req.body.additionalDockerFiles as Record<string, string>) || undefined,
    userData: (req.body.userData as string) || undefined,
    dockerCmd: (req.body.dockerCmd as string[]) || undefined,
    dockerEntrypoint: (req.body.dockerEntrypoint as string[]) || undefined,
    authorization: req.headers?.authorization,
    caller: req.caller
  }
  await runServiceCommand(ServiceRestartHandler, task, res)
})

computeRoutes.get(`${SERVICES_API_BASE_PATH}/serviceStatus`, async (req, res) => {
  const task: ServiceGetStatusCommand = {
    command: PROTOCOL_COMMANDS.SERVICE_GET_STATUS,
    consumerAddress: req.query.consumerAddress as string,
    nonce: req.query.nonce as string,
    signature: req.query.signature as string,
    serviceId: (req.query.serviceId as string) || undefined,
    node: (req.query.node as string) || null,
    authorization: req.headers?.authorization,
    caller: req.caller
  }
  await runServiceCommand(ServiceGetStatusHandler, task, res)
})

// node-wide service listing (any owner). Default: only services currently holding a
// resource reservation; `status` filters to one specific status, `includeAllStatuses`
// returns everything, `fromTimestamp` keeps services created at/after that moment.
computeRoutes.get(`${SERVICES_API_BASE_PATH}/serviceList`, async (req, res) => {
  const task: GetServicesCommand = {
    command: PROTOCOL_COMMANDS.SERVICE_LIST,
    consumerAddress: req.query.consumerAddress as string,
    nonce: req.query.nonce as string,
    signature: req.query.signature as string,
    status: req.query.status !== undefined ? Number(req.query.status) : undefined,
    includeAllStatuses: req.query.includeAllStatuses === 'true',
    fromTimestamp: (req.query.fromTimestamp as string) || undefined,
    node: (req.query.node as string) || null,
    authorization: req.headers?.authorization,
    caller: req.caller
  }
  await runServiceCommand(GetServicesHandler, task, res)
})

// streaming logs for services
computeRoutes.get(`${SERVICES_API_BASE_PATH}/serviceStreamableLogs`, async (req, res) => {
  try {
    HTTP_LOGGER.logMessage(
      `ServiceGetStreamableLogsCommand request received with query: ${JSON.stringify(
        req.query
      )}`,
      true
    )

    const task: ServiceGetStreamableLogsCommand = {
      command: PROTOCOL_COMMANDS.SERVICE_GET_STREAMABLE_LOGS,
      node: (req.query.node as string) || null,
      consumerAddress: (req.query.consumerAddress as string) || null,
      serviceId: (req.query.serviceId as string) || null,
      signature: (req.query.signature as string) || null,
      nonce: (req.query.nonce as string) || null,
      since: (req.query.since as string) || undefined,
      authorization: req.headers?.authorization,
      caller: req.caller
    }

    const response = await new ServiceGetStreamableLogsHandler(req.oceanNode).handle(task)
    if (response.stream) {
      res.status(response.status.httpStatus)
      res.set(response.status.headers)
      response.stream.pipe(res)
    } else {
      const body =
        response.status.error ??
        (response.status.httpStatus === 404
          ? 'Service not found or not running'
          : 'Error')
      res.status(response.status.httpStatus).send(body)
    }
  } catch (error) {
    HTTP_LOGGER.log(LOG_LEVELS_STR.LEVEL_ERROR, `Error: ${error}`)
    res.status(500).send('Internal Server Error')
  }
})
