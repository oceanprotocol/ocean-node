import express from 'express'
// import { SERVICES_API_BASE_PATH } from '../../utils/constants.js'
// import { AQUARIUS_API_BASE_PATH } from './aquarius.js'
import { HTTP_LOGGER } from '../../utils/logging/common.js'
import { getConfiguration } from '../../utils/index.js'
import { getAllServiceEndpoints } from './index.js'
export const rootEndpointRoutes = express.Router()

rootEndpointRoutes.get('/', async (req, res) => {
  const config = await getConfiguration()
  if (!config.supportedNetworks) {
    HTTP_LOGGER.error(`Supported networks not defined`)
    res.status(400).send(`Supported networks not defined`)
  }
  res.json({
    chainIds: Object.keys(config.supportedNetworks),
    providerAddress: config.keys.ethAddress,
    serviceEndpoints: getAllServiceEndpoints(),
    // Not yet implemented
    // validateContainer: ['POST', `${SERVICES_API_BASE_PATH}/validateContainer`],
    // create_auth_token: ['GET', `${SERVICES_API_BASE_PATH}/createAuthToken`],
    // delete_auth_token: ['DELETE', `${SERVICES_API_BASE_PATH}/deleteAuthToken`],
    // },
    software: 'Ocean-Node',
    version: '0.0.1'
  })
})
