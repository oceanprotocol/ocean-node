import { expect } from 'chai'
import { OceanNodeConfig } from '../../@types/OceanNode.js'
import { RPCS, SupportedNetwork } from '../../@types/blockchain.js'
import { Blockchain } from '../../utils/blockchain.js'
import { getConfiguration } from '../../utils/config.js'
import {
  DEFAULT_TEST_TIMEOUT,
  setupEnvironment,
  TEST_ENV_CONFIG_FILE
} from '../utils/utils.js'
import { expectedTimeoutFailure } from '../integration/testUtils.js'
import { DEVELOPMENT_CHAIN_ID, KNOWN_CONFIDENTIAL_EVMS } from '../../utils/address.js'
import { isConfidentialEVM } from '../../utils/asset.js'

let config: OceanNodeConfig
let rpcs: RPCS
let network: SupportedNetwork
let blockchain: Blockchain
describe('Should validate blockchain network connections', () => {
  before(async () => {
    setupEnvironment(TEST_ENV_CONFIG_FILE)
    config = await getConfiguration(true)

    rpcs = config.supportedNetworks
    network = rpcs['8996']
    blockchain = new Blockchain(
      network.rpc,
      network.network,
      network.chainId,
      network.fallbackRPCs
    )
  })

  it('should get known rpcs', () => {
    expect(blockchain.getKnownRPCs().length).to.be.equal(3)
  })

  it('should get network not ready (wrong RPC setting)', async () => {
    const status = await blockchain.isNetworkReady()
    expect(status.ready).to.be.equal(false)
  })

  it('should get network ready after retry other RPCs', async function () {
    this.timeout(DEFAULT_TEST_TIMEOUT * 2)
    let status = await blockchain.isNetworkReady()
    expect(status.ready).to.be.equal(false)
    // at least one should be OK
    const retryResult = await blockchain.tryFallbackRPCs()
    // ignore node network errors (on ci there are network issues sometimes)
    // we can't do much if we have timeouts, bad urls or connections refused
    if (!retryResult.ready && retryResult.error) {
      const networkIssue =
        retryResult.error.includes('TIMEOUT') ||
        retryResult.error.includes('ECONNREFUSED') ||
        retryResult.error.includes('ENOTFOUND')

      expect(expectedTimeoutFailure(this.test.title)).to.be.equal(networkIssue)
    } else {
      expect(retryResult.ready).to.be.equal(true)
      status = await blockchain.isNetworkReady()
      expect(status.ready).to.be.equal(true)
    }
  })

  it('should check if chain is confidential EVM', () => {
    for (const chain of KNOWN_CONFIDENTIAL_EVMS) {
      expect(isConfidentialEVM(chain)).to.be.equal(true)
    }
    expect(isConfidentialEVM(DEVELOPMENT_CHAIN_ID)).to.be.equal(false)
  })
})
