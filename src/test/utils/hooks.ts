// Global hooks for mocha tests.
// beforeAll() and afterAll() are called before starting the tests
// and after finishing them respectively.

import { ENVIRONMENT_VARIABLES } from '../../utils/constants.js'
import { CONFIG_LOGGER } from '../../utils/logging/common.js'
import {
  setupEnvironment,
  OverrideEnvConfig,
  tearDownEnvironment,
  getExistingEnvironment,
  TEST_ENV_CONFIG_FILE,
  buildEnvOverrideConfig
} from './utils.js'

// current process.env environment
// save any existing configuration before starting the tests
const initialConfiguration: Map<string, OverrideEnvConfig> = getExistingEnvironment()
let envOverrides: OverrideEnvConfig[] = []

// if you want to override some variables, just use the
// OverrideEnvConfig type and build an array to pass to setupEnvironment() (on before() function)
// this function returns the new configuration together with any variables that were overrided
// at the end call tearDownEnvironment() with the previously saved configuration (on after() function)
// example of override configuration:
function getEnvOverrides(): OverrideEnvConfig[] {
  // we can also use the function buildEnvOverrideConfig([variables],[values]) to build that array
  return buildEnvOverrideConfig(
    [
      ENVIRONMENT_VARIABLES.IPFS_GATEWAY,
      ENVIRONMENT_VARIABLES.ARWEAVE_GATEWAY,
      ENVIRONMENT_VARIABLES.RPCS,
      ENVIRONMENT_VARIABLES.PRIVATE_KEY
    ],
    [
      'http://172.15.0.16:8080/',
      'https://arweave.net/',
      '{ "1": {"rpc": "https://rpc.eth.gateway.fm", "chainId": 1, "network": "mainet", "chunkSize": 100}, "137": {"rpc": "https://polygon.meowrpc.com", "chainId": 137, "network": "polygon", "chunkSize": 100 }, "80001": {"rpc": "https://rpc-mumbai.maticvigil.com","chainId": 80001, "network": "polygon-mumbai", "chunkSize": 100 } }',
      '0xc594c6e5def4bab63ac29eed19a134c130388f74f019bc74b8f4389df2837a58'
    ]
  )
}

export const mochaHooks = {
  beforeAll() {
    // get stuff we want to override
    envOverrides = getEnvOverrides()
    // if it exists will use it, otherwise nothing happens
    // in any case it WILL NOT override the existing configuration
    // it returns the original object with the original value preserved to be restored later
    setupEnvironment(TEST_ENV_CONFIG_FILE, envOverrides).then((overrides) => {
      envOverrides = overrides
    })
  },

  afterAll() {
    // restore stuff
    tearDownEnvironment(envOverrides)
    // double check any other possible changes,
    // get the final configuration and compare both
    // restore any value that could have been modified
    const finalConfiguration = getExistingEnvironment()
    finalConfiguration.forEach((currentEnvVariable, varName) => {
      const initialVariable: OverrideEnvConfig = initialConfiguration.get(varName)
      if (initialVariable.originalValue !== currentEnvVariable.originalValue) {
        // reset it to the original
        CONFIG_LOGGER.debug('Restoring environment variable: ' + varName)
        process.env[varName] = initialVariable.originalValue
      }
    })
  }
}
