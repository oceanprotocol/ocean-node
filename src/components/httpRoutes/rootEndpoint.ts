import express from 'express'
export const rootEndpointRoutes = express.Router()

rootEndpointRoutes.get('/', async (req, res) => {
  res.json({
    chainIds: [1, 5, 10, 137, 80001, 11155111],
    providerAddresses: {
      '1': '0xeAFDC69612a8bF720FBfE6A5520Cfede69a9a5b5',
      '5': '0x00c6A0BC5cD0078d6Cd0b659E8061B404cfa5704',
      '10': '0xeAFDC69612a8bF720FBfE6A5520Cfede69a9a5b5',
      '137': '0xC96ED22751eF6bE3e2432118B944A0cDAEDe10E8',
      '80001': '0x4256Df50c94D9a7e04610976cde01aED91eB531E',
      '11155111': '0x00c6A0BC5cD0078d6Cd0b659E8061B404cfa5704'
    },
    serviceEndpoints: {
      computeDelete: ['DELETE', '/api/services/compute'],
      computeEnvironments: ['GET', '/api/services/computeEnvironments'],
      computeResult: ['GET', '/api/services/computeResult'],
      computeStart: ['POST', '/api/services/compute'],
      computeStatus: ['GET', '/api/services/compute'],
      computeStop: ['PUT', '/api/services/compute'],
      create_auth_token: ['GET', '/api/services/createAuthToken'],
      decrypt: ['POST', '/api/services/decrypt'],
      delete_auth_token: ['DELETE', '/api/services/deleteAuthToken'],
      download: ['GET', '/api/services/download'],
      encrypt: ['POST', '/api/services/encrypt'],
      fileinfo: ['POST', '/api/services/fileinfo'],
      initialize: ['GET', '/api/services/initialize'],
      initializeCompute: ['POST', '/api/services/initializeCompute'],
      nonce: ['GET', '/api/services/nonce'],
      validateContainer: ['POST', '/api/services/validateContainer']
    },
    software: 'Ocean-Node',
    version: '0.0.1'
  })
})
