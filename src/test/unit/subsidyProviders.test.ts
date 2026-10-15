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

  it('collapses duplicate addresses to a single unique sponsor, checksummed', () => {
    const r = resolveUserSubsidyProviders([A, A], CHAIN, cfg({}))
    expect(r.valid).to.equal(true)
    // the escrow counts UNIQUE sponsors, so duplicates are collapsed
    expect(r.resolved).to.deep.equal([getAddress(A)])
  })

  it('valid array → checksummed, filter off', () => {
    const r = resolveUserSubsidyProviders([A, B], CHAIN, cfg({}))
    expect(r.valid).to.equal(true)
    expect(r.resolved).to.deep.equal([getAddress(A), getAddress(B)])
  })

  // The escrow caps unique sponsors per lock at MAX_SUBSIDY_PROVIDERS_PER_LOCK (10). The resolver
  // enforces that locally (unique count) so an over-long list is a cheap 400, not an estimateGas
  // round-trip on a guaranteed "Too many sponsors" revert.
  const mkAddrs = (n: number) =>
    Array.from({ length: n }, (_, i) => '0x' + String(i + 1).padStart(40, '0'))

  it('rejects more than the per-lock unique-sponsor cap', () => {
    const r = resolveUserSubsidyProviders(mkAddrs(11), CHAIN, cfg({}))
    expect(r.valid).to.equal(false)
    expect(r.reason).to.contain('Too many subsidy providers')
  })

  it('allows exactly the cap, and the cap counts UNIQUE sponsors (dupes collapse under it)', () => {
    const ten = mkAddrs(10)
    const r = resolveUserSubsidyProviders(ten, CHAIN, cfg({}))
    expect(r.valid).to.equal(true)
    expect(r.resolved).to.have.length(10)
    // 12 entries but only 10 unique → valid after dedup (cap is on unique count, not raw length)
    const r2 = resolveUserSubsidyProviders([...ten, ten[0], ten[1]], CHAIN, cfg({}))
    expect(r2.valid).to.equal(true)
    expect(r2.resolved).to.have.length(10)
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
