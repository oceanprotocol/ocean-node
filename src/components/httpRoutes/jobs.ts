import express from 'express'
import { OceanIndexer } from '../Indexer'
import { HTTP_LOGGER } from '../../utils/logging/common.js'
import { SERVICES_API_BASE_PATH } from '../../utils/constants.js'

export const jobsRoutes = express.Router()

jobsRoutes.get(`${SERVICES_API_BASE_PATH}/jobs/:job`, (req, res) => {
  try {
    const indexer: OceanIndexer = req.oceanNode.getIndexer()
    if (indexer) {
      const jobs = indexer.getJobsPool((req.params.job as string) || null)
      res.header('Content-Type', 'application/json')
      res.status(200).send(JSON.stringify({ jobs }))
    } else {
      res.status(400).send('Indexer jobs not available!')
    }
  } catch (error) {
    HTTP_LOGGER.error(`Error getting indexer jobs pool: ${error.message}`)
    res.status(500).send('Error getting indexer jobs pool')
  }
})
