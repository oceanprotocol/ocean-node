import { expect } from 'chai'
import { OceanNodeConfig } from '../../@types/OceanNode.js'
import { RPCS, SupportedNetwork } from '../../@types/blockchain.js'
import { Blockchain } from '../../utils/blockchain.js'
import { getConfiguration } from '../../utils/config.js'
import { ENVIRONMENT_VARIABLES } from '../../utils/constants.js'
import {
  DEFAULT_TEST_TIMEOUT,
  OverrideEnvConfig,
  buildEnvOverrideConfig,
  setupEnvironment,
  tearDownEnvironment
} from '../utils/utils.js'

let envOverrides: OverrideEnvConfig[]
let config: OceanNodeConfig
let rpcs: RPCS
let network: SupportedNetwork
let blockchain: Blockchain
describe('Should validate blockchain network connections', () => {
  before(async () => {
    envOverrides = buildEnvOverrideConfig(
      [ENVIRONMENT_VARIABLES.RPCS],
      [
        '{ "11155420":{ "rpc":"https://sepolia.optimism.FAKE", "fallbackRPCs": ["https://sepolia.optimism.io","https://public.stackup.sh/api/v1/node/optimism-sepolia","https://optimism-sepolia.blockpi.network/v1/rpc/public","https://endpoints.omniatech.io/v1/op/sepolia/public"], "chainId": 11155420, "network": "optimism-sepolia", "chunkSize": 100 }}'
      ]
    )
    envOverrides = await setupEnvironment(null, envOverrides)
    config = await getConfiguration(true)

    rpcs = config.supportedNetworks
    network = rpcs['11155420']
    blockchain = new Blockchain(
      network.rpc,
      network.network,
      network.chainId,
      network.fallbackRPCs
    )
  })

  it('should get known rpcs', () => {
    expect(blockchain.getKnownRPCs().length).to.be.equal(5)
  })

  it('should get network not ready (wrong RPC setting)', async () => {
    const isReady = await blockchain.isNetworkReady()
    expect(isReady).to.be.equal(false)
  })

  it('should get network ready after retry other RPCs', async function () {
    this.timeout(DEFAULT_TEST_TIMEOUT * 2)
    let isReady = await blockchain.isNetworkReady()
    expect(isReady).to.be.equal(false)
    // at least one should be OK
    const retryResult = await blockchain.tryFallbackRPCs()
    expect(retryResult).to.be.equal(true)
    isReady = await blockchain.isNetworkReady()
    expect(isReady).to.be.equal(true)
  })

  after(async () => {
    await tearDownEnvironment(envOverrides)
  })
})
