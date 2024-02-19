import { expect } from 'chai'
import {
  ENVIRONMENT_VARIABLES,
  PROTOCOL_COMMANDS,
  getConfiguration
} from '../../utils/index.js'
import { ProviderFeeData } from '../../@types/Fees.js'
import {
  createFee,
  checkFee,
  getProviderFeeToken,
  getProviderWallet,
  getProviderWalletAddress
} from '../../components/core/utils/feesHandler.js'
import { FeesHandler } from '../../components/core/feesHandler.js'
import { OceanNodeConfig, P2PCommandResponse } from '../../@types/index.js'
import { Service } from '../../@types/DDO/Service.js'
import { DDOExample } from '../data/ddo.js'
import {
  buildEnvOverrideConfig,
  OverrideEnvConfig,
  setupEnvironment,
  tearDownEnvironment,
  TEST_ENV_CONFIG_FILE,
  getMockSupportedNetworks
} from '../utils/utils.js'
import { ethers } from 'ethers'
import { Database } from '../../components/database/index.js'
import { OceanNode } from '../../OceanNode.js'
import { getOceanArtifactsAdresses } from '../../utils/address.js'
import { RPCS } from '../../@types/blockchain.js'

const service: Service = {
  id: '24654b91482a3351050510ff72694d88edae803cf31a5da993da963ba0087648', // matches the service ID on the example DDO
  type: '',
  files: '',
  datatokenAddress: '',
  serviceEndpoint: '',
  timeout: 0
}

describe('Ocean Node fees', () => {
  let config: OceanNodeConfig
  let envBefore: OverrideEnvConfig[] | undefined
  const mockSupportedNetworks: RPCS = getMockSupportedNetworks()
  const data = getOceanArtifactsAdresses()
  const oceanToken = data.polygon.Ocean

  before(async () => {
    // we're gonna override these
    envBefore = await setupEnvironment(
      TEST_ENV_CONFIG_FILE,
      buildEnvOverrideConfig(
        [
          ENVIRONMENT_VARIABLES.RPCS,
          ENVIRONMENT_VARIABLES.FEE_TOKENS,
          ENVIRONMENT_VARIABLES.FEE_AMOUNT
        ],
        [
          JSON.stringify(mockSupportedNetworks),
          JSON.stringify({ 137: oceanToken }),
          '{ "amount": 1, "unit": "MB" }'
        ]
      )
    )
    // avoid overriding the local environment, use the .env.test
    config = await getConfiguration(true)
  })

  it('should get provider wallet address', async () => {
    const address = await getProviderWalletAddress()
    expect(address).to.be.equal(config.keys.ethAddress)
  })

  it('should create provider fees data', async () => {
    const asset: any = DDOExample
    const address = await getProviderWalletAddress()
    const { chainId } = asset // this chain id is a number
    const providerFeeToken = await getProviderFeeToken(chainId)
    const data: ProviderFeeData | undefined = await createFee(asset, 0, 'null', service)
    if (data) {
      expect(data.providerFeeAddress).to.be.equal(address)
      expect(data.providerFeeToken).to.be.equal(providerFeeToken)
      expect(data.providerFeeAmount).to.be.equal(1000000000000000000n) // 1 converted to 18 decimals
    }
  })

  it('should check the fees data and validate signature', async () => {
    const asset: any = DDOExample
    const wallet = await getProviderWallet()
    const { address } = wallet
    const { chainId } = asset // this chain id is a number
    const providerFeeToken = await getProviderFeeToken(chainId)

    const data: ProviderFeeData | undefined = await createFee(asset, 0, 'null', service)
    if (data) {
      expect(data.providerFeeAddress).to.be.equal(address)
      expect(data.providerFeeToken).to.be.equal(providerFeeToken)
      expect(data.providerFeeAmount).to.be.equal(1000000000000000000n) // 1 converted to 18 decimals

      // will sign a new message with this data to simulate the txId and then check it
      const providerDataAsArray = ethers.toBeArray(data.providerData)
      const providerDataStr = Buffer.from(providerDataAsArray).toString('utf8')
      const providerData = JSON.parse(providerDataStr)

      // done previously as ethers.hexlify(ethers.toUtf8Bytes(JSON.stringify(providerData))),
      // check signature stuff now

      const messageHash = ethers.solidityPackedKeccak256(
        ['bytes', 'address', 'address', 'uint256', 'uint256'],
        [
          ethers.hexlify(ethers.toUtf8Bytes(JSON.stringify(providerData))),
          ethers.getAddress(data.providerFeeAddress), // signer address
          ethers.getAddress(data.providerFeeToken),
          data.providerFeeAmount,
          data.validUntil
        ]
      )

      const signableHash = ethers.solidityPackedKeccak256(
        ['bytes'],
        [ethers.toUtf8Bytes(messageHash)]
      )

      const txID = await wallet.signMessage(ethers.toBeArray(signableHash))
      const checkFeeResult = await checkFee(txID, chainId, data)
      expect(checkFeeResult).to.be.equal(true)
    }
  })

  it('should get fees data from API call', async () => {
    const asset: any = DDOExample
    const wallet = await getProviderWallet()
    const { address } = wallet
    const { chainId } = asset // this chain id is a number
    const providerFeeToken = await getProviderFeeToken(chainId)

    const config = await getConfiguration(true)
    config.supportedNetworks[8996] = {
      chainId: 8996,
      network: 'development',
      rpc: 'http://127.0.0.1:8545',
      chunkSize: 100
    }

    const dbconn = await new Database(config.dbConfig)
    const oceanNode = OceanNode.getInstance(dbconn)

    const data: P2PCommandResponse = await new FeesHandler(oceanNode).handle({
      ddo: asset,
      serviceId: service.id,
      command: PROTOCOL_COMMANDS.GET_FEES
    })
    console.log('data log: ', data.status)
    console.log('data stream: ', data.stream)
    expect(data.status.httpStatus).to.equal(200)
    const { stream } = data
    if (stream) {
      let buffer = '' // Use a string instead of an array
      stream.on('data', (data) => {
        // read streamed data to buffer
        console.log('data inside stream: ', data)
        buffer += data.toString() // Concatenate the streamed data
        console.log('buffer: ', buffer)
      })
      stream.on('end', () => {
        // check that we got a valid response
        const feesData: ProviderFeeData = JSON.parse(buffer.toString()) as ProviderFeeData
        console.log('fees data json: ', feesData)
        expect(feesData.providerFeeAddress).to.be.equal(address)
        expect(feesData.providerFeeToken).to.be.equal(providerFeeToken)
        expect(feesData.providerFeeAmount).to.be.equal(1000000000000000000n)
        expect(feesData.v).to.be.gte(27) // 27 OR 28
        expect(Object.keys(feesData.r).length).to.be.equal(66) // 32 bytes in hex + 0x
        expect(Object.keys(feesData.s).length).to.be.equal(66) // 32 bytes in hex + 0x
      })
    }
  })

  it('should always get some token fees default data', () => {
    expect(config.feeStrategy.feeTokens.length).to.be.gte(1)
    expect(config.feeStrategy.feeAmount.amount).to.be.gte(0)
  })

  it('should return some defaults for fees token', async () => {
    process.env[ENVIRONMENT_VARIABLES.FEE_TOKENS.name] = undefined
    process.env[ENVIRONMENT_VARIABLES.FEE_AMOUNT.name] = undefined
    const conf = await getConfiguration(true)
    expect(Object.keys(conf.feeStrategy.feeTokens).length).to.be.gte(1)
    expect(conf.feeStrategy.feeAmount.amount).to.be.gte(0)
  })

  after(async () => {
    tearDownEnvironment(envBefore)
  })
})
