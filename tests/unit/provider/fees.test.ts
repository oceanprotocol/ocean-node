import { expect } from 'chai'
import { getConfig } from '../../../src/utils'
import { ProviderFeeData } from '../../../src/@types/Fees'
import {
  checkFee,
  createFee,
  getProviderFeeAmount,
  getProviderFeeToken,
  getProviderWallet,
  getProviderWalletAddress
} from '../../../src/components/core/feesHandler'
import { OceanNodeConfig } from '../../../src/@types'
import { Service } from '../../../src/@types/DDO/Service'
import { DDOExample } from '../../data/ddo'
import {
  OverrideEnvConfig,
  setupEnvironment,
  tearDownEnvironment
} from '../../utils/utils'
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
      name: 'FEE_TOKENS',
      newValue:
        '{ "1": "0x967da4048cD07aB37855c090aAF366e4ce1b9F48", "137": "0x282d8efCe846A88B159800bd4130ad77443Fa1A1", "80001": "0xd8992Ed72C445c35Cb4A2be468568Ed1079357c8", "56": "0xDCe07662CA8EbC241316a15B611c89711414Dd1a" }',
      override: true,
      originalValue: process.env.FEE_TOKENS
    },
    {
      name: 'FEE_AMOUNT',
      newValue: '{ "amount": 1, "unit": "MB" }',
      override: true,
      originalValue: process.env.FEE_AMOUNT
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
    const address = getProviderWalletAddress()
    expect(address).to.be.equal(config.keys.ethAddress)
  })

  it('should create provider fees data', async () => {
    const asset: any = DDOExample
    const address = getProviderWalletAddress()
    const { chainId } = asset // this chain id is a number
    const providerFeeToken = getProviderFeeToken(String(chainId))
    const providerAmount = getProviderFeeAmount()
    const data: ProviderFeeData | undefined = await createFee(asset, 0, 'null', service)
    if (data) {
      expect(data.providerFeeAddress).to.be.equal(address)
      expect(data.providerFeeToken).to.be.equal(providerFeeToken)
      expect(data.providerFeeAmount).to.be.equal(providerAmount)
    }
  })

  it('should check the fees data and validate signature', async () => {
    const asset: any = DDOExample
    const wallet = getProviderWallet()
    const { address } = wallet
    const { chainId } = asset // this chain id is a number
    const providerFeeToken = getProviderFeeToken(String(chainId))
    const providerAmount = getProviderFeeAmount()

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

  after(async () => {
    tearDownEnvironment(envBefore)
  })
})
