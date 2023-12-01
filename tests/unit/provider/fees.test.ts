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
import { setupEnvironment } from '../../utils/utils'
import { ethers } from 'ethers'

describe('Ocean Node fees', () => {
  let config: OceanNodeConfig
  const serviceId = '24654b91482a3351050510ff72694d88edae803cf31a5da993da963ba0087648'

  before(async () => {
    await setupEnvironment('../.env.test')
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
})
