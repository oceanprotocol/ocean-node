import { expect } from 'chai'
import type { ComputeAccessList } from '../../@types/C2D/C2D.js'
import { validateAccess } from '../../components/core/compute/startCompute.js'

const ALLOWED = '0x1111111111111111111111111111111111111111'
const OTHER = '0x2222222222222222222222222222222222222222'

// Stub node: no blockchain available, so any on-chain access list check resolves to "not on list"
const node: any = {
  getConfig: () => ({ supportedNetworks: { '8996': { chainId: 8996 } } }),
  getBlockchain: (): any => null
}

describe('validateAccess', () => {
  it('is open when access is undefined', async () => {
    expect(await validateAccess(OTHER, undefined, node)).to.equal(true)
  })

  it('is open when both lists are empty (accessLists [])', async () => {
    expect(
      await validateAccess(OTHER, { addresses: [], accessLists: [] }, node)
    ).to.equal(true)
  })

  it('is open when addresses is empty and accessLists is null', async () => {
    expect(
      await validateAccess(OTHER, { addresses: [], accessLists: null }, node)
    ).to.equal(true)
  })

  it('enforces addresses when accessLists is null (regression)', async () => {
    const access: ComputeAccessList = { addresses: [ALLOWED], accessLists: null }
    expect(await validateAccess(OTHER, access, node)).to.equal(false)
    expect(await validateAccess(ALLOWED, access, node)).to.equal(true)
  })

  it('enforces addresses when accessLists is undefined', async () => {
    const access: any = { addresses: [ALLOWED] }
    expect(await validateAccess(OTHER, access, node)).to.equal(false)
    expect(await validateAccess(ALLOWED, access, node)).to.equal(true)
  })

  it('enforces addresses when accessLists is []', async () => {
    const access: ComputeAccessList = { addresses: [ALLOWED], accessLists: [] }
    expect(await validateAccess(OTHER, access, node)).to.equal(false)
    expect(await validateAccess(ALLOWED, access, node)).to.equal(true)
  })

  it('matches addresses case-insensitively', async () => {
    const mixed = '0xAbCdEf0123456789aBcDeF0123456789AbCdEf01'
    const access: ComputeAccessList = {
      addresses: [mixed.toLowerCase()],
      accessLists: null
    }
    expect(await validateAccess(mixed, access, node)).to.equal(true)
    expect(
      await validateAccess(
        mixed.toLowerCase(),
        { addresses: [mixed], accessLists: null },
        node
      )
    ).to.equal(true)
  })

  it('denies a non-listed caller when only accessLists is set and not on chain list', async () => {
    const access: ComputeAccessList = {
      addresses: [],
      accessLists: [{ '8996': ['0x3333333333333333333333333333333333333333'] }]
    }
    expect(await validateAccess(OTHER, access, node)).to.equal(false)
  })

  it('still allows a listed address when accessLists is also set', async () => {
    const access: ComputeAccessList = {
      addresses: [ALLOWED],
      accessLists: [{ '8996': ['0x3333333333333333333333333333333333333333'] }]
    }
    expect(await validateAccess(ALLOWED, access, node)).to.equal(true)
  })
})
