import { expect } from 'chai'
import { getConfig } from '../../../src/utils'
import { ProviderFeeData } from '../../../src/@types/Fees'
import {
  checkFee,
  createFee,
  getProviderFeeAmount,
  getProviderFeeToken,
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
  const serviceId = '24654b91482a3351050510ff72694d88edae803cf31a5da993da963ba0087648'
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

  it('should should create provider fees data', async () => {
    const asset: any = DDOExample
    const address = getProviderWalletAddress()

    const service: Service = {
      id: serviceId,
      type: '',
      files: '',
      datatokenAddress: '',
      serviceEndpoint: '',
      timeout: 0
    }
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

  it('should should check the fees data', async () => {
    const asset: any = DDOExample
    const address = getProviderWalletAddress()

    const service: Service = {
      id: serviceId,
      type: '',
      files: '',
      datatokenAddress: '',
      serviceEndpoint: '',
      timeout: 0
    }
    const { chainId } = asset // this chain id is a number
    const providerFeeToken = getProviderFeeToken(String(chainId))
    const providerAmount = getProviderFeeAmount()

    const data: ProviderFeeData | undefined = await createFee(asset, 0, 'null', service)
    if (data) {
      expect(data.providerFeeAddress).to.be.equal(address)
      expect(data.providerFeeToken).to.be.equal(providerFeeToken)
      expect(data.providerFeeAmount).to.be.equal(providerAmount)
      const txID =
        '0x698926822f2e6f511e3cd6e0e2339f170b355b5212e31bbee3267bc094f7f5b92974d3ae66887f382be28408a07d24db6364ca84021994a3e2a435b6371851d91c'

      const checkFeeResult = await checkFee(txID, data)
      expect(checkFeeResult).to.be.equal(true)
    }
  })

  after(async () => {
    tearDownEnvironment(envBefore)
  })
})
