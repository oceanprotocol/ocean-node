import { expect } from 'chai'
import { AbiCoder } from 'ethers'
import {
  checkAddressOnAccessList,
  checkAddressOnAccessListWithSigner
} from '../../utils/accessList.js'

const USER = '0x1111111111111111111111111111111111111111'
const LIST = '0x2222222222222222222222222222222222222222'

function makeNode(opts: { signerCalls?: string[]; networks?: any } = {}): any {
  return {
    getConfig: () => ({
      supportedNetworks: opts.networks ?? { '8996': { chainId: 8996 } }
    }),
    getBlockchain: (): any => ({
      // a signer that makes every contract call fail, so a valid-looking address resolves to false
      getSigner: (): any => {
        opts.signerCalls?.push('signer')
        return {}
      }
    })
  }
}

describe('checkAddressOnAccessList', () => {
  it('does not grant access for an empty-string entry', async () => {
    expect(await checkAddressOnAccessList(USER, [{ '8996': [''] }], makeNode())).to.equal(
      false
    )
  })

  it('does not grant access for a non-address entry', async () => {
    expect(
      await checkAddressOnAccessList(USER, [{ '8996': ['not-an-address'] }], makeNode())
    ).to.equal(false)
  })

  it('skips an unknown chain key instead of throwing', async () => {
    const result = await checkAddressOnAccessList(
      USER,
      [{ '9999': [LIST] }, { '8996': [''] }],
      makeNode()
    )
    expect(result).to.equal(false)
  })

  it('does not throw when supportedNetworks is missing', async () => {
    const node: any = { getConfig: () => ({}), getBlockchain: (): any => null }
    expect(await checkAddressOnAccessList(USER, [{ '8996': [LIST] }], node)).to.equal(
      false
    )
  })

  it('still evaluates valid entries on later lists after an unknown chain', async () => {
    const calls: string[] = []
    await checkAddressOnAccessList(
      USER,
      [{ '9999': [LIST] }, { '8996': [LIST] }],
      makeNode({ signerCalls: calls })
    )
    expect(calls.length).to.equal(1)
  })

  describe('with a signer that reports a balance', () => {
    const signerWithBalance = (balance: number): any => ({
      provider: {},
      call: (): Promise<string> =>
        Promise.resolve(AbiCoder.defaultAbiCoder().encode(['uint256'], [balance]))
    })
    const nodeWith = (balance: number): any => ({
      getConfig: () => ({ supportedNetworks: { '8996': { chainId: 8996 } } }),
      getBlockchain: (): any => ({ getSigner: () => signerWithBalance(balance) })
    })

    it('grants access when balanceOf > 0', async () => {
      expect(
        await checkAddressOnAccessList(USER, [{ '8996': [LIST] }], nodeWith(1))
      ).to.equal(true)
    })

    it('denies when balanceOf is 0', async () => {
      expect(
        await checkAddressOnAccessList(USER, [{ '8996': [LIST] }], nodeWith(0))
      ).to.equal(false)
    })

    it('ignores an empty entry but still evaluates a valid one after it', async () => {
      expect(
        await checkAddressOnAccessList(USER, [{ '8996': ['', LIST] }], nodeWith(1))
      ).to.equal(true)
    })

    it('signer-level helper fails closed on empty/invalid contract address', async () => {
      expect(
        await checkAddressOnAccessListWithSigner('', USER, signerWithBalance(1))
      ).to.equal(false)
      expect(
        await checkAddressOnAccessListWithSigner('nope', USER, signerWithBalance(1))
      ).to.equal(false)
      expect(
        await checkAddressOnAccessListWithSigner(LIST, USER, signerWithBalance(1))
      ).to.equal(true)
    })
  })
})
