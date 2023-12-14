import express from 'express'
import { getNonce } from '../core/nonceHandler.js'
import { streamToString } from '../../utils/util.js'
import { Readable } from 'stream'
import { calculateFee } from '../core/feesHandler.js'
import { DDO } from '../../@types/DDO/DDO'
import {
  CustomNodeLogger,
  defaultConsoleTransport,
  getCustomLoggerForModule,
  LOG_LEVELS_STR,
  LOGGER_MODULE_NAMES
} from '../../utils/logging/Logger.js'
import { PROTOCOL_COMMANDS } from '../../utils/constants.js'
import { handleEncryptCommand } from '../core/encryptHandler.js'

export const providerRoutes = express.Router()
const logger: CustomNodeLogger = getCustomLoggerForModule(
  LOGGER_MODULE_NAMES.HTTP,
  LOG_LEVELS_STR.LEVEL_INFO,
  defaultConsoleTransport
)

providerRoutes.post('/encrypt', async (req, res) => {
  try {
    const data = req.body.toString()
    if (!data) {
      res.status(400).send('Missing required body')
      return
    }
    const result = await handleEncryptCommand({
      blob: data,
      encoding: 'string',
      encryptionType: 'ECIES',
      command: PROTOCOL_COMMANDS.ENCRYPT
    })
    if (result.stream) {
      const encryptedData = await streamToString(result.stream as Readable)
      res.status(200).send(encryptedData)
    } else {
      res.status(result.status.httpStatus).send(result.status.error)
    }
  } catch (error) {
    logger.log(LOG_LEVELS_STR.LEVEL_ERROR, `Error: ${error}`)
    res.status(500).send('Internal Server Error')
  }
})

providerRoutes.get('/download', async (req, res) => {
  try {
    res.status(400).send()
  } catch (error) {
    logger.log(LOG_LEVELS_STR.LEVEL_ERROR, `Error: ${error}`)
    res.status(500).send('Internal Server Error')
  }
})

providerRoutes.get('/initialize', async (req, res) => {
  try {
    const did = String(req.query.documentId)
    const consumerAddress = String(req.query.consumerAddress)
    const serviceId = String(req.query.serviceId)

    const node = req.oceanNode.getP2PNode()
    const ddo = (await node.getDatabase().ddo.retrieve(did)) as DDO

    if (!ddo) {
      res.status(400).send('Cannot resolve DID')
      return
    }

    const service = ddo.services.find((service) => service.id === serviceId)
    if (!service) {
      res.status(400).send('Invalid serviceId')
      return
    }
    if (service.type === 'compute') {
      res
        .status(400)
        .send('Use the initializeCompute endpoint to initialize compute jobs')
      return
    }

    const datatoken = service.datatokenAddress
    const nonceResult = await getNonce(node, consumerAddress)
    const nonce = nonceResult.stream
      ? await streamToString(nonceResult.stream as Readable)
      : nonceResult.stream
    const providerFee = await calculateFee(ddo, serviceId)
    const response = {
      datatoken,
      nonce,
      providerFee
    }

    res.json(response)
  } catch (error) {
    logger.log(LOG_LEVELS_STR.LEVEL_ERROR, `Error: ${error}`)
    res.status(500).send('Internal Server Error')
  }
})

providerRoutes.get('/nonce', async (req, res) => {
  try {
    const userAddress = String(req.query.userAddress)
    if (!userAddress) {
      res.status(400).send('Missing required parameter: "userAddress"')
      return
    }
    const node = req.oceanNode.getP2PNode()
    const result = await getNonce(node, userAddress)
    if (result.stream) {
      res.json({ nonce: await streamToString(result.stream as Readable) })
    } else {
      res.status(400).send()
    }
  } catch (error) {
    logger.log(LOG_LEVELS_STR.LEVEL_ERROR, `Error: ${error}`)
    res.status(500).send('Internal Server Error')
  }
})
