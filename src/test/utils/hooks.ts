// test/hooks.js

import { ENVIRONMENT_VARIABLES } from '../../utils/constants.js'
import { setupEnvironment, OverrideEnvConfig, tearDownEnvironment } from './utils.js'

// current environment
let previousConfiguration: OverrideEnvConfig[] = []

function getEnvOverrides(): OverrideEnvConfig[] {
  return [
    {
      name: ENVIRONMENT_VARIABLES.IPFS_GATEWAY.name,
      newValue: 'http://172.15.0.16:8080/',
      override: false,
      originalValue: ENVIRONMENT_VARIABLES.IPFS_GATEWAY.value,
      required: ENVIRONMENT_VARIABLES.IPFS_GATEWAY.required
    },
    {
      name: ENVIRONMENT_VARIABLES.ARWEAVE_GATEWAY.name,
      newValue: 'https://arweave.net/',
      override: false,
      originalValue: ENVIRONMENT_VARIABLES.ARWEAVE_GATEWAY.value,
      required: ENVIRONMENT_VARIABLES.ARWEAVE_GATEWAY.required
    },
    {
      name: ENVIRONMENT_VARIABLES.RPCS.name,
      newValue:
        '{ "1": {"rpc": "https://rpc.eth.gateway.fm", "chainId": 1, "network": "mainet", "chunkSize": 100}, "137": {"rpc": "https://polygon.meowrpc.com", "chainId": 137, "network": "polygon", "chunkSize": 100 }, "80001": {"rpc": "https://rpc-mumbai.maticvigil.com","chainId": 80001, "network": "polygon-mumbai", "chunkSize": 100 } }',
      override: false,
      originalValue: ENVIRONMENT_VARIABLES.RPCS.value,
      required: ENVIRONMENT_VARIABLES.RPCS.required
    },
    {
      name: ENVIRONMENT_VARIABLES.PRIVATE_KEY.name,
      newValue: '0xbee525d70c715bee6ca15ea5113e544d13cc1bb2817e07113d0af7755ddb6391',
      override: true,
      originalValue: ENVIRONMENT_VARIABLES.PRIVATE_KEY.value,
      required: ENVIRONMENT_VARIABLES.PRIVATE_KEY.required
    }
  ]
}

previousConfiguration = getEnvOverrides()

export const mochaHooks = {
  beforeAll() {
    console.log('key: ', process.env.PRIVATE_KEY)
    console.log('RPCS: ', process.env.RPCS)
    // if it exists will use it, otherwise nothing happens
    // in any case it WILL NOT override the existing configuration
    setupEnvironment('../.env.test', getEnvOverrides()).then((overrides) => {
      console.log('overrides: ', overrides)
      previousConfiguration = overrides
    })
  },

  afterAll() {
    tearDownEnvironment(previousConfiguration)
  }
}
