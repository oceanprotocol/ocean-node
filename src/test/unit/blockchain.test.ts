import { expect } from 'chai'
import { OceanNodeConfig } from '../../@types/OceanNode.js'

import { BlockchainRegistry } from '../../components/BlockchainRegistry/index.js'
import { KeyManager } from '../../components/KeyManager/index.js'
import { Blockchain } from '../../utils/blockchain.js'
import { getConfiguration } from '../../utils/config.js'
import { ENVIRONMENT_VARIABLES } from '../../utils/constants.js'
import {
  DEFAULT_TEST_TIMEOUT,
  OverrideEnvConfig,
  TEST_ENV_CONFIG_FILE,
  buildEnvOverrideConfig,
  setupEnvironment,
  tearDownEnvironment
} from '../utils/utils.js'

import { DEVELOPMENT_CHAIN_ID, KNOWN_CONFIDENTIAL_EVMS } from '../../utils/address.js'
import { isConfidentialEVM } from '../../utils/asset.js'

let envOverrides: OverrideEnvConfig[]
let config: OceanNodeConfig
let blockchain: Blockchain
describe('Should validate blockchain network connections', () => {
  before(async () => {
    envOverrides = buildEnvOverrideConfig(
      [ENVIRONMENT_VARIABLES.RPCS],
      [
        '{ "8996":{ "rpc":"http://127.0.0.254:8545", "fallbackRPCs": ["http://127.0.0.3:8545","http://127.0.0.1:8545"], "chainId": 8996, "network": "development", "chunkSize": 100 }}'
      ]
    )
    envOverrides = await setupEnvironment(TEST_ENV_CONFIG_FILE, envOverrides)
    config = await getConfiguration(true)
    const keyManager = new KeyManager(config)
    const blockchainRegistry = new BlockchainRegistry(keyManager, config)
    // network = rpcs['8996']
    blockchain = blockchainRegistry.getBlockchain(8996)
  })

  it('should get known rpcs', () => {
    expect(blockchain.getKnownRPCs().length).to.be.equal(3)
  })

  it('should get network not ready', async function () {
    this.timeout(DEFAULT_TEST_TIMEOUT * 2)
    const status = await blockchain.isNetworkReady()
    expect(status.ready).to.be.equal(false)
  })

  it('should check if chain is confidential EVM', () => {
    for (const chain of KNOWN_CONFIDENTIAL_EVMS) {
      expect(isConfidentialEVM(chain)).to.be.equal(true)
    }
    expect(isConfidentialEVM(BigInt(DEVELOPMENT_CHAIN_ID))).to.be.equal(false)
  })

  after(async () => {
    await tearDownEnvironment(envOverrides)
  })
})
