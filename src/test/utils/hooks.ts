// Global hooks for mocha tests.
// beforeAll() and afterAll() are called before starting the tests
// and after finishing them respectively.

import { ENVIRONMENT_VARIABLES } from '../../utils/constants.js'
import { setupEnvironment, OverrideEnvConfig, tearDownEnvironment } from './utils.js'

// current process.env environment
let previousConfiguration: OverrideEnvConfig[] = []

// if you want to override some variables, just use the
// OverrideEnvConfig type and build an array to pass to setupEnvironment() (on before() function)
// this function returns the new configuration together with any variables that were overrided
// at the end call tearDownEnvironment() with the previously saved configuration (on after() function)
// example of override configuration:
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
    // if it exists will use it, otherwise nothing happens
    // in any case it WILL NOT override the existing configuration
    setupEnvironment('../.env.test', getEnvOverrides()).then((overrides) => {
      previousConfiguration = overrides
    })
  },

  afterAll() {
    tearDownEnvironment(previousConfiguration)
  }
}
