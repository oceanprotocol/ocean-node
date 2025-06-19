import express from 'express'
import { getNonce } from '../core/utils/nonceHandler.js'
import { streamToObject, streamToString } from '../../utils/util.js'
import { Readable } from 'stream'
import { LOG_LEVELS_STR } from '../../utils/logging/Logger.js'
import { PROTOCOL_COMMANDS, SERVICES_API_BASE_PATH } from '../../utils/constants.js'
import { EncryptFileHandler, EncryptHandler } from '../core/handler/encryptHandler.js'
import { HTTP_LOGGER } from '../../utils/logging/common.js'
import { DecryptDdoHandler } from '../core/handler/ddoHandler.js'
import { DownloadHandler } from '../core/handler/downloadHandler.js'
import { DownloadCommand } from '../../@types/commands.js'
import { FeesHandler } from '../core/handler/feesHandler.js'
import { BaseFileObject, EncryptMethod } from '../../@types/fileObject.js'
import { P2PCommandResponse } from '../../@types/OceanNode.js'
import { getEncryptMethodFromString } from '../../utils/crypt.js'
import { ComputeGetEnvironmentsHandler } from '../core/compute/environments.js'
import { GetJobsHandler } from '../core/compute/getJobs.js'
import { ComputeGetStatusHandler } from '../core/compute/getStatus.js'

export const providerRoutes = express.Router()

providerRoutes.post(`${SERVICES_API_BASE_PATH}/decrypt`, async (req, res) => {
  try {
    const result = await new DecryptDdoHandler(req.oceanNode).handle({
      ...req.body,
      command: PROTOCOL_COMMANDS.DECRYPT_DDO
    })
    if (result.stream) {
      const decryptedData = await streamToString(result.stream as Readable)
      res.header('Content-Type', 'text/plain')
      res.status(200).send(decryptedData)
    } else {
      res.status(result.status.httpStatus).send(result.status.error)
    }
  } catch (error) {
    HTTP_LOGGER.log(LOG_LEVELS_STR.LEVEL_ERROR, `Error: ${error}`)
    res.status(500).send(`Internal Server error: ${error.message}`)
  }
})

providerRoutes.post(`${SERVICES_API_BASE_PATH}/encrypt`, async (req, res) => {
  try {
    const data = req.body.toString()
    if (!data) {
      res.status(400).send('Missing required body')
      return
    }
    const result = await new EncryptHandler(req.oceanNode).handle({
      blob: data,
      encoding: 'string',
      encryptionType: EncryptMethod.ECIES,
      command: PROTOCOL_COMMANDS.ENCRYPT
    })
    if (result.stream) {
      const encryptedData = await streamToString(result.stream as Readable)
      res.header('Content-Type', 'application/octet-stream')
      res.status(200).send(encryptedData)
    } else {
      res.status(result.status.httpStatus).send(result.status.error)
    }
  } catch (error) {
    HTTP_LOGGER.log(LOG_LEVELS_STR.LEVEL_ERROR, `Error: ${error}`)
    res.status(500).send('Internal Server Error')
  }
})

// There are two ways of encrypting a file:

// 1) Body contains file object
// Content-type header must be set to application/json

// 2 ) Body contains raw file content
// Content-type header must be set to application/octet-stream or multipart/form-data

// Query.encryptMethod can be aes or ecies (if missing, defaults to aes)

// Returns:
// Body: encrypted file content
// Headers
// X-Encrypted-By: our_node_id
// X-Encrypted-Method: aes or ecies
providerRoutes.post(`${SERVICES_API_BASE_PATH}/encryptFile`, async (req, res) => {
  const writeResponse = async (
    result: P2PCommandResponse,
    encryptMethod: EncryptMethod
  ) => {
    if (result.stream) {
      const encryptedData = await streamToString(result.stream as Readable)
      res.set(result.status.headers)
      res.status(200).send(encryptedData)
    } else {
      res.status(result.status.httpStatus).send(result.status.error)
    }
  }

  const getEncryptedData = async (
    encryptMethod: EncryptMethod.AES | EncryptMethod.ECIES,
    input: Buffer
  ) => {
    const result = await new EncryptFileHandler(req.oceanNode).handle({
      rawData: input,
      encryptionType: encryptMethod,
      command: PROTOCOL_COMMANDS.ENCRYPT_FILE
    })
    return result
  }

  try {
    const encryptMethod: EncryptMethod = getEncryptMethodFromString(
      req.query.encryptMethod as string
    )
    let result: P2PCommandResponse
    if (req.is('application/json')) {
      // body as fileObject
      result = await new EncryptFileHandler(req.oceanNode).handle({
        files: req.body as BaseFileObject,
        encryptionType: encryptMethod,
        command: PROTOCOL_COMMANDS.ENCRYPT_FILE
      })
      return await writeResponse(result, encryptMethod)
      // raw data on body
    } else if (req.is('application/octet-stream') || req.is('multipart/form-data')) {
      if (req.is('application/octet-stream')) {
        result = await getEncryptedData(encryptMethod, req.body)
        return await writeResponse(result, encryptMethod)
      } else {
        // multipart/form-data
        const data: Buffer[] = []
        req.on('data', function (chunk) {
          data.push(chunk)
        })
        req.on('end', async function () {
          result = await getEncryptedData(encryptMethod, Buffer.concat(data))
          return await writeResponse(result, encryptMethod)
        })
      }
    } else {
      res.status(400).send('Invalid request (missing body data or invalid content-type)')
    }
  } catch (error) {
    HTTP_LOGGER.log(LOG_LEVELS_STR.LEVEL_ERROR, `Error: ${error}`)
    res.status(500).send('Internal Server Error')
  }
})

providerRoutes.get(`${SERVICES_API_BASE_PATH}/initialize`, async (req, res) => {
  try {
    const data = req.body.toString()
    if (!data) {
      res.status(400).send('Missing required body')
      return
    }
    const result = await new FeesHandler(req.oceanNode).handle({
      command: PROTOCOL_COMMANDS.GET_FEES,
      ddoId: (req.query.documentId as string) || null,
      serviceId: (req.query.serviceId as string) || null,
      consumerAddress: (req.query.consumerAddress as string) || null,
      validUntil: parseInt(req.query.validUntil as string) || null,
      policyServer: req.query.policyServer || null
    })
    if (result.stream) {
      const initializeREsponse = await streamToObject(result.stream as Readable)
      res.header('Content-Type', 'application/json')
      res.status(200).send(initializeREsponse)
    } else {
      res.status(result.status.httpStatus).send(result.status.error)
    }
  } catch (error) {
    HTTP_LOGGER.log(LOG_LEVELS_STR.LEVEL_ERROR, `Error: ${error}`)
    res.status(500).send('Internal Server Error')
  }
})

providerRoutes.get(`${SERVICES_API_BASE_PATH}/nonce`, async (req, res) => {
  try {
    const userAddress = String(req.query.userAddress)
    if (!userAddress) {
      res.status(400).send('Missing required parameter: "userAddress"')
      return
    }
    const nonceDB = req.oceanNode.getDatabase().nonce
    const result = await getNonce(nonceDB, userAddress)
    if (result.stream) {
      res.json({ nonce: await streamToString(result.stream as Readable) })
    } else {
      res.status(400).send()
    }
  } catch (error) {
    HTTP_LOGGER.log(LOG_LEVELS_STR.LEVEL_ERROR, `Error: ${error}`)
    res.status(500).send('Internal Server Error')
  }
})

providerRoutes.get(
  `${SERVICES_API_BASE_PATH}/download`,
  express.urlencoded({ extended: true, type: '*/*' }),
  async (req, res): Promise<void> => {
    if (!req.query) {
      res.sendStatus(400)
      return
    }
    HTTP_LOGGER.logMessage(
      `Download request received: ${JSON.stringify(req.query)}`,
      true
    )
    try {
      const {
        fileIndex,
        documentId,
        serviceId,
        transferTxId,
        nonce,
        consumerAddress,
        signature
      } = req.query

      const downloadTask: DownloadCommand = {
        fileIndex: Number(fileIndex),
        documentId: documentId as string,
        serviceId: serviceId as string,
        transferTxId: transferTxId as string,
        nonce: nonce as string,
        consumerAddress: consumerAddress as string,
        signature: signature as string,
        command: PROTOCOL_COMMANDS.DOWNLOAD,
        policyServer: req.query.policyServer || null
      }

      const response = await new DownloadHandler(req.oceanNode).handle(downloadTask)

      if (response.stream) {
        res.status(response.status.httpStatus)

        const safeHeaders = { ...response.status.headers }
        if (safeHeaders['content-length'] && safeHeaders['Transfer-Encoding']) {
          delete safeHeaders['content-length']
        }

        res.set(safeHeaders)
        response.stream.pipe(res)
      } else {
        res.status(response.status.httpStatus).send(response.status.error)
      }
    } catch (error) {
      HTTP_LOGGER.logMessage(`Error: ${error}`, true)
      res.status(500).send(error)
    }
    // res.sendStatus(200)
  }
)

providerRoutes.get(`${SERVICES_API_BASE_PATH}/compute/environments`, async (req, res) => {
  try {
    const result = await new ComputeGetEnvironmentsHandler(req.oceanNode).handle({
      command: PROTOCOL_COMMANDS.COMPUTE_GET_ENVIRONMENTS
    })
    if (result.stream) {
      const environments = await streamToObject(result.stream as Readable)
      res.header('Content-Type', 'application/json')
      res.status(200).send(environments)
    } else {
      res.status(result.status.httpStatus).send(result.status.error)
    }
  } catch (error) {
    HTTP_LOGGER.log(LOG_LEVELS_STR.LEVEL_ERROR, `Error: ${error}`)
    res.status(500).send('Internal Server Error')
  }
})

providerRoutes.get(`${SERVICES_API_BASE_PATH}/compute/jobs`, async (req, res) => {
  try {
    const fromTimestamp = req.query.fromTimestamp as string
    const result = await new GetJobsHandler(req.oceanNode).handle({
      command: PROTOCOL_COMMANDS.GET_JOBS,
      fromTimestamp
    })
    if (result.stream) {
      const jobs = await streamToObject(result.stream as Readable)
      res.header('Content-Type', 'application/json')
      res.status(200).send(jobs)
    } else {
      res.status(result.status.httpStatus).send(result.status.error)
    }
  } catch (error) {
    HTTP_LOGGER.log(LOG_LEVELS_STR.LEVEL_ERROR, `Error: ${error}`)
    res.status(500).send('Internal Server Error')
  }
})

providerRoutes.get(
  `${SERVICES_API_BASE_PATH}/compute/jobs/:jobId/status`,
  async (req, res) => {
    try {
      const result = await new ComputeGetStatusHandler(req.oceanNode).handle({
        command: PROTOCOL_COMMANDS.COMPUTE_GET_STATUS,
        jobId: req.params.jobId
      })
      if (result.stream) {
        const status = await streamToObject(result.stream as Readable)
        res.header('Content-Type', 'application/json')
        res.status(200).send(status)
      } else {
        res.status(result.status.httpStatus).send(result.status.error)
      }
    } catch (error) {
      HTTP_LOGGER.log(LOG_LEVELS_STR.LEVEL_ERROR, `Error: ${error}`)
      res.status(500).send('Internal Server Error')
    }
  }
)
