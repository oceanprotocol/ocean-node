import express from 'express'
import { Readable } from 'stream'

import { SERVICES_API_BASE_PATH, PROTOCOL_COMMANDS } from '../../utils/constants.js'
import { HTTP_LOGGER } from '../../utils/logging/common.js'
import { streamToObject, streamToString } from '../../utils/util.js'

import {
  PersistentStorageCreateBucketHandler,
  PersistentStorageDeleteFileHandler,
  PersistentStorageGetBucketsHandler,
  PersistentStorageGetFileObjectHandler,
  PersistentStorageListFilesHandler,
  PersistentStorageUploadFileHandler
} from '../core/handler/persistentStorage.js'

export const persistentStorageRoutes = express.Router()

function readRawBody(req: any): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: any) => chunks.push(Buffer.from(chunk)))
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

// Create bucket
persistentStorageRoutes.post(
  `${SERVICES_API_BASE_PATH}/persistentStorage/buckets`,
  express.json(),
  async (req, res) => {
    try {
      const response = await new PersistentStorageCreateBucketHandler(
        req.oceanNode
      ).handle({
        ...req.body,
        command: PROTOCOL_COMMANDS.PERSISTENT_STORAGE_CREATE_BUCKET,
        authorization: req.headers?.authorization,
        caller: req.caller
      })
      if (!response.stream) {
        res.status(response.status.httpStatus).send(response.status.error)
        return
      }
      const payload = await streamToObject(response.stream as Readable)
      res.status(200).json(payload)
    } catch (error) {
      HTTP_LOGGER.error(`PersistentStorage create bucket error: ${error}`)
      res.status(500).send('Internal Server Error')
    }
  }
)

// List buckets for an owner (then filtered by ACL in handler)
persistentStorageRoutes.get(
  `${SERVICES_API_BASE_PATH}/persistentStorage/buckets`,
  async (req, res) => {
    try {
      const response = await new PersistentStorageGetBucketsHandler(req.oceanNode).handle(
        {
          command: PROTOCOL_COMMANDS.PERSISTENT_STORAGE_GET_BUCKETS,
          consumerAddress: req.query.consumerAddress as string,
          signature: req.query.signature as string,
          nonce: req.query.nonce as string,
          chainId: parseInt(req.query.chainId as string) || null,
          owner: req.query.owner as string,
          authorization: req.headers?.authorization,
          caller: req.caller
        } as any
      )
      if (!response.stream) {
        res.status(response.status.httpStatus).send(response.status.error)
        return
      }
      const payload = await streamToObject(response.stream as Readable)
      res.status(200).json(payload)
    } catch (error) {
      HTTP_LOGGER.error(`PersistentStorage get buckets error: ${error}`)
      res.status(500).send('Internal Server Error')
    }
  }
)

// List files in bucket
persistentStorageRoutes.get(
  `${SERVICES_API_BASE_PATH}/persistentStorage/buckets/:bucketId/files`,
  async (req, res) => {
    try {
      const response = await new PersistentStorageListFilesHandler(req.oceanNode).handle({
        command: PROTOCOL_COMMANDS.PERSISTENT_STORAGE_LIST_FILES,
        consumerAddress: req.query.consumerAddress as string,
        signature: req.query.signature as string,
        nonce: req.query.nonce as string,
        bucketId: req.params.bucketId,
        authorization: req.headers?.authorization,
        caller: req.caller
      } as any)
      if (!response.stream) {
        res.status(response.status.httpStatus).send(response.status.error)
        return
      }
      const payload = await streamToObject(response.stream as Readable)
      res.status(200).json(payload)
    } catch (error) {
      HTTP_LOGGER.error(`PersistentStorage list files error: ${error}`)
      res.status(500).send('Internal Server Error')
    }
  }
)

// Get file object for a file in a bucket
persistentStorageRoutes.get(
  `${SERVICES_API_BASE_PATH}/persistentStorage/buckets/:bucketId/files/:fileName/object`,
  async (req, res) => {
    try {
      const response = await new PersistentStorageGetFileObjectHandler(
        req.oceanNode
      ).handle({
        command: PROTOCOL_COMMANDS.PERSISTENT_STORAGE_GET_FILE_OBJECT,
        consumerAddress: req.query.consumerAddress as string,
        signature: req.query.signature as string,
        nonce: req.query.nonce as string,
        bucketId: req.params.bucketId,
        fileName: req.params.fileName,
        authorization: req.headers?.authorization,
        caller: req.caller
      } as any)
      if (!response.stream) {
        res.status(response.status.httpStatus).send(response.status.error)
        return
      }
      const payload = await streamToObject(response.stream as Readable)
      res.status(200).json(payload)
    } catch (error) {
      HTTP_LOGGER.error(`PersistentStorage get file object error: ${error}`)
      res.status(500).send('Internal Server Error')
    }
  }
)

// Upload file to bucket. Body is treated as raw bytes.
persistentStorageRoutes.post(
  `${SERVICES_API_BASE_PATH}/persistentStorage/buckets/:bucketId/files/:fileName`,
  async (req, res) => {
    try {
      const raw = await readRawBody(req)
      const response = await new PersistentStorageUploadFileHandler(req.oceanNode).handle(
        {
          command: PROTOCOL_COMMANDS.PERSISTENT_STORAGE_UPLOAD_FILE,
          consumerAddress: req.query.consumerAddress as string,
          signature: req.query.signature as string,
          nonce: req.query.nonce as string,
          bucketId: req.params.bucketId,
          fileName: req.params.fileName,
          stream: Readable.from(raw),
          authorization: req.headers?.authorization,
          caller: req.caller
        } as any
      )
      if (!response.stream) {
        res.status(response.status.httpStatus).send(response.status.error)
        return
      }
      const payload = await streamToObject(response.stream as Readable)
      res.status(200).json(payload)
    } catch (error) {
      HTTP_LOGGER.error(`PersistentStorage upload error: ${error}`)
      res.status(500).send('Internal Server Error')
    }
  }
)

// Delete file from bucket
persistentStorageRoutes.delete(
  `${SERVICES_API_BASE_PATH}/persistentStorage/buckets/:bucketId/files/:fileName`,
  async (req, res) => {
    try {
      const response = await new PersistentStorageDeleteFileHandler(req.oceanNode).handle(
        {
          command: PROTOCOL_COMMANDS.PERSISTENT_STORAGE_DELETE_FILE,
          consumerAddress: req.query.consumerAddress as string,
          signature: req.query.signature as string,
          nonce: req.query.nonce as string,
          chainId: parseInt(req.query.chainId as string) || null,
          bucketId: req.params.bucketId,
          fileName: req.params.fileName,
          authorization: req.headers?.authorization,
          caller: req.caller
        } as any
      )

      if (response.status.httpStatus !== 200) {
        res.status(response.status.httpStatus).send(response.status.error)
        return
      }

      if (!response.stream) {
        res.status(200).json({ success: true })
        return
      }

      const payload = JSON.parse(await streamToString(response.stream as Readable))
      res.status(200).json(payload)
    } catch (error) {
      HTTP_LOGGER.error(`PersistentStorage delete error: ${error}`)
      res.status(500).send('Internal Server Error')
    }
  }
)
