import { expect } from 'chai'
import {
  ENVIRONMENT_VARIABLES,
  PROTOCOL_COMMANDS,
  getConfig
} from '../../../utils/index.js'
import { ProviderFeeData } from '../../../@types/Fees'
import {
  checkFee,
  createFee,
  getProviderFeeAmount,
  getProviderFeeToken,
  getProviderWallet,
  getProviderWalletAddress
} from '../../../components/core/handlers/utils/feesHandler.js'
import { FeesHandler } from '../../../components/core/handler.js'
import { OceanNodeConfig, P2PCommandResponse } from '../../../@types'
import { Service } from '../../../@types/DDO/Service.js'
import { DDOExample } from '../../data/ddo.js'
import {
  OverrideEnvConfig,
  setupEnvironment,
  tearDownEnvironment
} from '../../utils/utils.js'
import { ethers } from 'ethers'

const service: Service = {
  id: '24654b91482a3351050510ff72694d88edae803cf31a5da993da963ba0087648', // matches the service ID on the example DDO
  type: '',
  files: '',
  datatokenAddress: '',
  serviceEndpoint: '',
  timeout: 0
}
// we're gonna override these
function getEnvOverrides(): OverrideEnvConfig[] {
  return [
    {
      name: ENVIRONMENT_VARIABLES.FEE_TOKENS.name,
      newValue:
        '{ "1": "0x967da4048cD07aB37855c090aAF366e4ce1b9F48", "137": "0x282d8efCe846A88B159800bd4130ad77443Fa1A1", "80001": "0xd8992Ed72C445c35Cb4A2be468568Ed1079357c8", "56": "0xDCe07662CA8EbC241316a15B611c89711414Dd1a" }',
      override: true,
      originalValue: ENVIRONMENT_VARIABLES.FEE_TOKENS.value
    },
    {
      name: ENVIRONMENT_VARIABLES.FEE_AMOUNT.name,
      newValue: '{ "amount": 1, "unit": "MB" }',
      override: true,
      originalValue: ENVIRONMENT_VARIABLES.FEE_AMOUNT.value
    }
  ]
}

describe('Ocean Node fees', () => {
  let config: OceanNodeConfig
  let envBefore: OverrideEnvConfig[] | undefined

  before(async () => {
    envBefore = await setupEnvironment('../.env.test', getEnvOverrides())
    // avoid overriding the local environment, use the .env.test
    config = await getConfig()
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
    const providerAmount = await getProviderFeeAmount()
    const data: ProviderFeeData | undefined = await createFee(asset, 0, 'null', service)
    if (data) {
      expect(data.providerFeeAddress).to.be.equal(address)
      expect(data.providerFeeToken).to.be.equal(providerFeeToken)
      expect(data.providerFeeAmount).to.be.equal(providerAmount)
    }
  })

  it('should check the fees data and validate signature', async () => {
    const asset: any = DDOExample
    const wallet = await getProviderWallet()
    const { address } = wallet
    const { chainId } = asset // this chain id is a number
    const providerFeeToken = await getProviderFeeToken(chainId)
    const providerAmount = await getProviderFeeAmount()

    const data: ProviderFeeData | undefined = await createFee(asset, 0, 'null', service)
    if (data) {
      expect(data.providerFeeAddress).to.be.equal(address)
      expect(data.providerFeeToken).to.be.equal(providerFeeToken)
      expect(data.providerFeeAmount).to.be.equal(providerAmount)

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
          ethers.getAddress(data.providerFeeToken), // TODO check decimals on contract?
          data.providerFeeAmount,
          data.validUntil
        ]
      )

      const signableHash = ethers.solidityPackedKeccak256(
        ['bytes'],
        [ethers.toUtf8Bytes(messageHash)]
      )

      const txID = await wallet.signMessage(ethers.toBeArray(signableHash))
      const checkFeeResult = await checkFee(txID, data)
      expect(checkFeeResult).to.be.equal(true)
    }
  })

  it('should get fees data from API call', async () => {
    const asset: any = DDOExample
    const wallet = await getProviderWallet()
    const { address } = wallet
    const { chainId } = asset // this chain id is a number
    const providerFeeToken = await getProviderFeeToken(chainId)
    const providerAmount = await getProviderFeeAmount()

    const data: P2PCommandResponse = await new FeesHandler({
      ddo: asset,
      serviceId: service.id,
      command: PROTOCOL_COMMANDS.GET_FEES
    }).handle()
    expect(data.status.httpStatus).to.equal(200)
    const { stream } = data
    if (stream) {
      const buffer: any[] = []
      stream.on('data', (data) => {
        // read streamed data to buffer
        buffer.push(data)
      })
      stream.on('end', () => {
        // check that we got a valid response
        const feesData: ProviderFeeData = JSON.parse(buffer.toString()) as ProviderFeeData
        expect(feesData.providerFeeAddress).to.be.equal(address)
        expect(feesData.providerFeeToken).to.be.equal(providerFeeToken)
        expect(feesData.providerFeeAmount).to.be.equal(providerAmount)
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
    const conf = await getConfig()
    expect(Object.keys(conf.feeStrategy.feeTokens).length).to.be.gte(1)
    expect(conf.feeStrategy.feeAmount.amount).to.be.gte(0)
  })

  after(async () => {
    tearDownEnvironment(envBefore)
  })
})
