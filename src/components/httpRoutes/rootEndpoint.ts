import express from 'express'
import { SERVICES_API_BASE_PATH } from '../../utils/constants.js'
import { AQUARIUS_API_BASE_PATH } from './aquarius.js'
import { HTTP_LOGGER } from '../../utils/logging/common.js'
export const rootEndpointRoutes = express.Router()

rootEndpointRoutes.get('/', (req, res) => {
  const config = req.oceanNode.getConfig()
  if (!config.supportedNetworks) {
    HTTP_LOGGER.error(`Supported networks not defined`)
    res.status(400).send(`Supported networks not defined`)
  }
  res.json({
    chainIds: config.supportedNetworks.keys,
    providerAddresses: {
      '1': '0xeAFDC69612a8bF720FBfE6A5520Cfede69a9a5b5',
      '5': '0x00c6A0BC5cD0078d6Cd0b659E8061B404cfa5704',
      '10': '0xeAFDC69612a8bF720FBfE6A5520Cfede69a9a5b5',
      '137': '0xC96ED22751eF6bE3e2432118B944A0cDAEDe10E8',
      '80001': '0x4256Df50c94D9a7e04610976cde01aED91eB531E',
      '11155111': '0x00c6A0BC5cD0078d6Cd0b659E8061B404cfa5704'
    },
    serviceEndpoints: {
      // compute service endpoints
      computeEnvironments: ['GET', `${SERVICES_API_BASE_PATH}/computeEnvironments`],
      computeResult: ['GET', `${SERVICES_API_BASE_PATH}/computeResult`],
      initializeCompute: ['POST', `${SERVICES_API_BASE_PATH}/initializeCompute`],
      computeStart: ['POST', `${SERVICES_API_BASE_PATH}/compute`],
      computeStatus: ['GET', `${SERVICES_API_BASE_PATH}/compute`],
      computeDelete: ['DELETE', `${SERVICES_API_BASE_PATH}/compute`],
      computeStop: ['PUT', `${SERVICES_API_BASE_PATH}/compute`],
      // provider
      download: ['GET', `${SERVICES_API_BASE_PATH}/download`],
      decrypt: ['POST', `${SERVICES_API_BASE_PATH}/decrypt`],
      encrypt: ['POST', `${SERVICES_API_BASE_PATH}/encrypt`],
      encryptFile: ['POST', `${SERVICES_API_BASE_PATH}/encryptFile`],
      initialize: ['GET', `${SERVICES_API_BASE_PATH}/initialize`],
      nonce: ['GET', `${SERVICES_API_BASE_PATH}/nonce`],
      // fileinfo
      fileinfo: ['POST', '/api/fileinfo'],
      directCommand: ['POST', `${SERVICES_API_BASE_PATH}/directCommand`],
      broadcastCommand: ['POST', `${SERVICES_API_BASE_PATH}/broadcastCommand`],
      // queue
      indexQueue: ['GET', `${SERVICES_API_BASE_PATH}/indexQueue`],
      // Aquarius
      getDDO: ['GET', `${AQUARIUS_API_BASE_PATH}/assets/ddo/:did`],
      getDDOMetadata: ['GET', `${AQUARIUS_API_BASE_PATH}/assets/metadata/:did`],
      ddoMetadataQuery: ['POST', `${AQUARIUS_API_BASE_PATH}/assets/metadata/query`],
      getDDOState: ['GET', `${AQUARIUS_API_BASE_PATH}/state/ddo`],
      validateDDO: ['POST', `${AQUARIUS_API_BASE_PATH}/assets/ddo/validate`],
      // P2P related
      getOceanPeers: ['GET', '/getOceanPeers'],
      getP2PPeers: ['GET', '/getP2PPeers'],
      getP2PPeer: ['GET', '/getP2PPeer']
      // Not implemented
      // validateContainer: ['POST', `${SERVICES_API_BASE_PATH}/validateContainer`],
      // create_auth_token: ['GET', `${SERVICES_API_BASE_PATH}/createAuthToken`],
      // delete_auth_token: ['DELETE', `${SERVICES_API_BASE_PATH}/deleteAuthToken`],
    },
    software: 'Ocean-Node',
    version: '0.0.1'
  })
})
