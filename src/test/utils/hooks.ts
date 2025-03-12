// Global hooks for mocha tests.
// beforeAll() and afterAll() are called before starting the tests
// and after finishing them respectively.

import {
  DEVELOPMENT_CHAIN_ID,
  getOceanArtifactsAdresses,
  getOceanArtifactsAdressesByChainId
} from '../../utils/address.js'
import { DB_TYPES, ENVIRONMENT_VARIABLES, EnvVariable } from '../../utils/constants.js'
import { CONFIG_LOGGER } from '../../utils/logging/common.js'
import { deployAccessListContract, getContract } from './contracts.js'
import {
  setupEnvironment,
  OverrideEnvConfig,
  tearDownEnvironment,
  getExistingEnvironment,
  TEST_ENV_CONFIG_FILE,
  buildEnvOverrideConfig,
  DEFAULT_TEST_TIMEOUT,
  SELECTED_RUN_DATABASE
} from './utils.js'

import AccessListFactory from '@oceanprotocol/contracts/artifacts/contracts/accesslists/AccessListFactory.sol/AccessListFactory.json' assert { type: 'json' }
import AccessList from '@oceanprotocol/contracts/artifacts/contracts/accesslists/AccessList.sol/AccessList.json' assert { type: 'json' }
import { ethers, JsonRpcProvider, Signer } from 'ethers'
import { AccessListContract } from '../../@types/OceanNode.js'
import { printCurrentConfig } from '../../utils/index.js'

// current process.env environment
// save any existing configuration before starting the tests
const initialConfiguration: Map<string, OverrideEnvConfig> = getExistingEnvironment()
let envOverrides: OverrideEnvConfig[] = []
let initialSetupDone = false
// if you want to override some variables, just use the
// OverrideEnvConfig type and build an array to pass to setupEnvironment() (on before() function)
// this function returns the new configuration together with any variables that were overrided
// at the end call tearDownEnvironment() with the previously saved configuration (on after() function)
// example of override configuration:
function getEnvOverrides(
  envVars: EnvVariable[] = [],
  envValues: any[] = []
): OverrideEnvConfig[] {
  const initialEnvVariables = [
    ENVIRONMENT_VARIABLES.IPFS_GATEWAY,
    ENVIRONMENT_VARIABLES.ARWEAVE_GATEWAY,
    ENVIRONMENT_VARIABLES.RPCS,
    ENVIRONMENT_VARIABLES.PRIVATE_KEY,
    ENVIRONMENT_VARIABLES.DB_TYPE,
    ENVIRONMENT_VARIABLES.DB_URL,
    ...envVars
  ]

  const initialEnvValues = [
    'http://172.15.0.16:8080/',
    'https://arweave.net/',
    '{ "1": {"rpc": "https://rpc.eth.gateway.fm", "chainId": 1, "network": "mainet", "chunkSize": 100}, "137": {"rpc": "https://polygon.meowrpc.com", "chainId": 137, "network": "polygon", "chunkSize": 100 }}',
    '0xc594c6e5def4bab63ac29eed19a134c130388f74f019bc74b8f4389df2837a58',
    SELECTED_RUN_DATABASE,
    SELECTED_RUN_DATABASE === DB_TYPES.ELASTIC_SEARCH
      ? 'http://localhost:9200'
      : 'http://localhost:8108/?apiKey=xyz',
    ...envValues
  ]
  console.log('initialEnvVariables:', initialEnvVariables)
  console.log('initialEnvValues:', initialEnvValues)
  // we can also use the function buildEnvOverrideConfig([variables],[values]) to build that array
  return buildEnvOverrideConfig(initialEnvVariables, initialEnvValues)
}

async function deployAccessLists(
  envVariable: string
): Promise<AccessListContract | null> {
  const provider = new JsonRpcProvider('http://127.0.0.1:8545')
  let networkArtifacts = getOceanArtifactsAdressesByChainId(DEVELOPMENT_CHAIN_ID)
  if (!networkArtifacts) {
    networkArtifacts = getOceanArtifactsAdresses().development
  }

  const owner = new ethers.Wallet(ENVIRONMENT_VARIABLES.PRIVATE_KEY.value) as Signer

  const wallets = [
    (await provider.getSigner(0)) as Signer,
    (await provider.getSigner(1)) as Signer,
    (await provider.getSigner(2)) as Signer,
    (await provider.getSigner(3)) as Signer
  ]
  const txAddress = await deployAccessListContract(
    owner, // owner is first account
    networkArtifacts.AccessListFactory,
    AccessListFactory.abi,
    'AllowList',
    'ALLOW',
    false,
    await owner.getAddress(),
    [
      await wallets[0].getAddress(),
      await wallets[1].getAddress(),
      await wallets[2].getAddress(),
      await wallets[3].getAddress()
    ],
    ['https://oceanprotocol.com/nft/']
  )

  const contractAcessList = getContract(txAddress, AccessList.abi, owner)
  return contractAcessList ? { DEVELOPMENT_CHAIN_ID: [txAddress] } : null
}

export const mochaHooks = {
  beforeAll() {
    deployAccessLists(ENVIRONMENT_VARIABLES.ALLOWED_VALIDATORS_LIST.name).then(
      (accessListAddress) => {
        if (accessListAddress) {
          const envVars: EnvVariable[] = [ENVIRONMENT_VARIABLES.ALLOWED_VALIDATORS_LIST]
          const envValues: any[] = [JSON.stringify(accessListAddress)]
          envOverrides = getEnvOverrides(envVars, envValues)
        } else {
          // get stuff we want to override
          envOverrides = getEnvOverrides()
        }
        // if it exists will use it, otherwise nothing happens
        // in any case it WILL NOT override the existing configuration
        // it returns the original object with the original value preserved to be restored later
        setupEnvironment(TEST_ENV_CONFIG_FILE, envOverrides).then((overrides) => {
          envOverrides = overrides
        })
        initialSetupDone = true
        CONFIG_LOGGER.debug(`(Hook) Initial test setup: ${JSON.stringify(envOverrides)} `)
        printCurrentConfig()

        // just in case the configuration value fails
        this.timeout(DEFAULT_TEST_TIMEOUT)
      }
    )
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
        CONFIG_LOGGER.debug(
          `(Hook) Restoring environment variable: ${varName} \ncurrent:\n ${process.env[varName]} \noriginal:\n ${initialVariable.originalValue}`
        )
        process.env[varName] = initialVariable.originalValue
      }
    })
  }
}
// some test code might call getConfiguration() before the beforeAll() hook gets called (before actual tests)
// if that happens we might not have any inital env vars yet, that are mandatory (like PRIVATE_KEY)
// so we need to make sure that we have the basics in place
async function doInitialSetup() {
  if (!initialSetupDone) {
    envOverrides = await setupEnvironment(TEST_ENV_CONFIG_FILE, getEnvOverrides())
  }
}
await doInitialSetup()
