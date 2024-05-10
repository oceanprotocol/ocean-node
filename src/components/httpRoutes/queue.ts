import express from 'express'
import { OceanIndexer } from '../Indexer'
import { HTTP_LOGGER } from '../../utils/logging/common.js'
import { SERVICES_API_BASE_PATH } from '../../utils/constants.js'

export const queueRoutes = express.Router()

queueRoutes.get(`${SERVICES_API_BASE_PATH}/indexQueue`, (req, res) => {
  try {
    const indexer: OceanIndexer = req.oceanNode.getIndexer()
    if (indexer) {
      const queue = indexer.getIndexingQueue()
      res.header('Content-Type', 'application/json')
      res.status(200).send(JSON.stringify({ queue }))
    } else {
      res.status(400).send('Indexer queue not found!')
    }
  } catch (error) {
    HTTP_LOGGER.error(`Error getting indexer queue: ${error.message}`)
    res.status(500).send('Error getting indexer queue')
  }
})
