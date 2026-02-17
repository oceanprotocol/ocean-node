import express from 'express'
import { HTTP_LOGGER } from '../../utils/logging/common.js'
import { getConfiguration } from '../../utils/index.js'
import { getAllServiceEndpoints } from './index.js'
export const rootEndpointRoutes = express.Router()

rootEndpointRoutes.get('/', async (req, res) => {
  const config = await getConfiguration()
  if (!config.supportedNetworks) {
    HTTP_LOGGER.warn(`Supported networks not defined`)
  }
  const keyManager = req.oceanNode.getKeyManager()
  res.json({
    nodeId: keyManager.getPeerId().toString(),
    chainIds: config.supportedNetworks ? Object.keys(config.supportedNetworks) : [],
    providerAddress: keyManager.getEthAddress(),
    nodePublicKey: keyManager.getPublicKey(),
    serviceEndpoints: getAllServiceEndpoints(),
    software: 'Ocean-Node',
    version: '0.0.1'
  })
})
