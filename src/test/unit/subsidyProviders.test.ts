import { expect } from 'chai'
import { getAddress } from 'ethers'
import { resolveUserSubsidyProviders } from '../../components/core/utils/subsidyProviders.js'
import { OceanNodeConfig } from '../../@types/OceanNode.js'

// Pure-logic unit test of the user-supplied subsidy-provider resolver: the tri-state semantics
// (undefined/empty/array), address validation + checksum normalization, and the whitelist filter.
describe('resolveUserSubsidyProviders', () => {
  const CHAIN = 8996
  // lowercase on purpose, to prove the resolver + whitelist comparison are checksum-insensitive
  const A = '0x1111111111111111111111111111111111111111'
  const B = '0x2222222222222222222222222222222222222222'
  const C = '0x3333333333333333333333333333333333333333'

  function cfg(partial: Partial<OceanNodeConfig>): OceanNodeConfig {
    return partial as OceanNodeConfig
  }

  it('undefined → use node config (resolved undefined)', () => {
    const r = resolveUserSubsidyProviders(undefined, CHAIN, cfg({}))
    expect(r.valid).to.equal(true)
    expect(r.resolved).to.equal(undefined)
  })

  it('null → use node config (treated like undefined)', () => {
    const r = resolveUserSubsidyProviders(null as any, CHAIN, cfg({}))
    expect(r.valid).to.equal(true)
    expect(r.resolved).to.equal(undefined)
  })

  it('empty array → explicit no-providers (resolved [])', () => {
    const r = resolveUserSubsidyProviders([], CHAIN, cfg({}))
    expect(r.valid).to.equal(true)
    expect(r.resolved).to.deep.equal([])
  })

  it('keeps duplicate addresses (no dedup), checksummed', () => {
    const r = resolveUserSubsidyProviders([A, A], CHAIN, cfg({}))
    expect(r.valid).to.equal(true)
    // current behavior preserves duplicates (no dedup) — asserted so a future change is deliberate
    expect(r.resolved).to.deep.equal([getAddress(A), getAddress(A)])
  })

  it('valid array → checksummed, filter off', () => {
    const r = resolveUserSubsidyProviders([A, B], CHAIN, cfg({}))
    expect(r.valid).to.equal(true)
    expect(r.resolved).to.deep.equal([getAddress(A), getAddress(B)])
  })

  it('rejects an invalid address', () => {
    const r = resolveUserSubsidyProviders([A, 'not-an-address'], CHAIN, cfg({}))
    expect(r.valid).to.equal(false)
    expect(r.reason).to.contain('not-an-address')
    expect(r.resolved).to.equal(undefined)
  })

  it('rejects a non-array value', () => {
    const r = resolveUserSubsidyProviders('nope' as any, CHAIN, cfg({}))
    expect(r.valid).to.equal(false)
  })

  describe('SUBSIDY_PROVIDER_FILTER on', () => {
    const config = cfg({
      subsidyProviderFilter: true,
      subsidyProviders: { [String(CHAIN)]: [A, B] }
    })

    it('allows a subset of the whitelist', () => {
      const r = resolveUserSubsidyProviders([A], CHAIN, config)
      expect(r.valid).to.equal(true)
      expect(r.resolved).to.deep.equal([getAddress(A)])
    })

    it('allows an empty list even when the whitelist is non-empty', () => {
      const r = resolveUserSubsidyProviders([], CHAIN, config)
      expect(r.valid).to.equal(true)
      expect(r.resolved).to.deep.equal([])
    })

    it('rejects an address outside the whitelist', () => {
      const r = resolveUserSubsidyProviders([A, C], CHAIN, config)
      expect(r.valid).to.equal(false)
      expect(r.reason).to.contain(getAddress(C))
    })

    it('rejects any list on a chain with no whitelist entry', () => {
      const r = resolveUserSubsidyProviders([A], 1, config)
      expect(r.valid).to.equal(false)
    })

    it('undefined still passes through (node config used at claim time)', () => {
      const r = resolveUserSubsidyProviders(undefined, CHAIN, config)
      expect(r.valid).to.equal(true)
      expect(r.resolved).to.equal(undefined)
    })
  })
})
