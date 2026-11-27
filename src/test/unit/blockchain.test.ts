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

  // Regression tests for the "Cannot mix BigInt and other types" crash in collectFees.
  // On legacy / non-EIP-1559 chains (e.g. Ganache / barge chainId 8996) a block has no
  // `baseFeePerGas`, so it comes back as null and `null + priorityFee` used to throw.
  describe('calculateGasCost gas-fee math', () => {
    const DESTINATION = '0x0000000000000000000000000000000000000001'
    const ESTIMATED_GAS = 21000n
    // parseUnits('2', 'gwei')
    const PRIORITY_FEE = 2_000_000_000n

    let originalGetProvider: any
    function stubProvider(block: { baseFeePerGas: bigint | null } | null) {
      ;(blockchain as any).getProvider = () =>
        Promise.resolve({
          estimateGas: () => Promise.resolve(ESTIMATED_GAS),
          getBlock: () => Promise.resolve(block)
        })
    }
    beforeEach(() => {
      originalGetProvider = (blockchain as any).getProvider
    })
    afterEach(() => {
      ;(blockchain as any).getProvider = originalGetProvider
    })

    it('returns a bigint when baseFeePerGas is null (non-EIP-1559 chain)', async () => {
      stubProvider({ baseFeePerGas: null })
      const amount = 1n
      const cost = await blockchain.calculateGasCost(DESTINATION, amount)
      expect(typeof cost).to.equal('bigint')
      // baseFee defaults to 0n, so maxFee === priorityFee
      expect(cost).to.equal(amount + ESTIMATED_GAS * PRIORITY_FEE)
    })

    it('returns a bigint when getBlock returns null', async () => {
      stubProvider(null)
      const amount = 5n
      const cost = await blockchain.calculateGasCost(DESTINATION, amount)
      expect(typeof cost).to.equal('bigint')
      expect(cost).to.equal(amount + ESTIMATED_GAS * PRIORITY_FEE)
    })

    it('still includes the base fee on EIP-1559 chains', async () => {
      const baseFee = 100n
      stubProvider({ baseFeePerGas: baseFee })
      const amount = 1n
      const cost = await blockchain.calculateGasCost(DESTINATION, amount)
      expect(cost).to.equal(amount + ESTIMATED_GAS * (baseFee + PRIORITY_FEE))
    })
  })

  describe('getGasOptions fee-field handling', () => {
    let originalSigner: any
    function stubFeeData(feeData: any) {
      // eslint-disable-next-line require-await
      ;(blockchain as any).signer = { provider: { getFeeData: async () => feeData } }
    }
    beforeEach(() => {
      originalSigner = (blockchain as any).signer
    })
    afterEach(() => {
      ;(blockchain as any).signer = originalSigner
    })

    it('applies the multiplier on EIP-1559 fee data', async () => {
      stubFeeData({ maxPriorityFeePerGas: 100n, maxFeePerGas: 1000n, gasPrice: 7n })
      const opts: any = await blockchain.getGasOptions(21000n, 1.5)
      expect(opts.gasLimit).to.equal(41000n)
      expect(opts.maxPriorityFeePerGas).to.equal(150n)
      expect(opts.maxFeePerGas).to.equal(1500n)
    })

    it('falls back to gasPrice when maxFeePerGas is null (partial EIP-1559 data)', async () => {
      // A priority fee without a maxFeePerGas is a degenerate pair; rather than produce an
      // invalid (maxFee < priority) tx, getGasOptions falls through to the gasPrice branch.
      stubFeeData({ maxPriorityFeePerGas: 100n, maxFeePerGas: null, gasPrice: 7n })
      const opts: any = await blockchain.getGasOptions(21000n, 1)
      expect(opts.gasPrice).to.equal(7n)
      expect(opts.maxFeePerGas).to.equal(undefined)
      expect(opts.maxPriorityFeePerGas).to.equal(undefined)
    })

    it('falls back to gasPrice when maxPriorityFeePerGas is null (legacy chain)', async () => {
      stubFeeData({ maxPriorityFeePerGas: null, maxFeePerGas: null, gasPrice: 7n })
      const opts: any = await blockchain.getGasOptions(21000n, 1)
      expect(opts.gasPrice).to.equal(7n)
      expect(opts.maxFeePerGas).to.equal(undefined)
    })
  })

  after(async () => {
    await tearDownEnvironment(envOverrides)
  })
})
