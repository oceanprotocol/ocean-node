import { expect } from 'chai'
import { OceanNodeP2PConfigSchema } from '../../../utils/config/schemas.js'
import { dhtFilterMethod } from '../../../@types/OceanNode.js'

/**
 * dhtFilter is a string enum (filterPrivate/filterPublic/filterNone), but the config schema
 * used to run every string through parseInt before comparing it to 1/2. `parseInt('filterPrivate',
 * 10)` is NaN, which fell through to the `default` branch and silently resolved to filterNone -
 * the opposite of what an operator asking for `P2P_DHT_FILTER=filterPrivate` wanted, on the
 * code path that controls whether private addresses get stripped from the DHT for every peer
 * this node learns about. What is pinned here is that the readable enum names resolve to
 * themselves, the legacy numeric form (string or number) still works, and a value that is
 * neither falls back to the documented default (filterPrivate) instead of silently landing on
 * filterNone - the least safe outcome for a typo on a security-relevant knob.
 */
describe('dhtFilter: readable enum names and legacy numbers both resolve correctly', () => {
  const cases: Array<{ raw: unknown; expected: dhtFilterMethod; why: string }> = [
    {
      raw: 'filterPrivate',
      expected: dhtFilterMethod.filterPrivate,
      why: 'the readable name, e.g. from P2P_DHT_FILTER=filterPrivate'
    },
    {
      raw: 'filterPublic',
      expected: dhtFilterMethod.filterPublic,
      why: 'the readable name'
    },
    {
      raw: 'filterNone',
      expected: dhtFilterMethod.filterNone,
      why: 'the readable name'
    },
    { raw: 1, expected: dhtFilterMethod.filterPrivate, why: 'legacy numeric form' },
    { raw: 2, expected: dhtFilterMethod.filterPublic, why: 'legacy numeric form' },
    { raw: 0, expected: dhtFilterMethod.filterNone, why: 'legacy numeric form' },
    {
      raw: '1',
      expected: dhtFilterMethod.filterPrivate,
      why: 'legacy numeric form as a string, e.g. from an env var'
    },
    {
      raw: '2',
      expected: dhtFilterMethod.filterPublic,
      why: 'legacy numeric form as a string'
    },
    {
      raw: '0',
      expected: dhtFilterMethod.filterNone,
      why: 'legacy numeric form as a string'
    },
    {
      raw: null,
      expected: dhtFilterMethod.filterNone,
      why: 'explicit null, as src/test/config.json ships so loopback tests keep private addresses'
    }
  ]

  for (const { raw, expected, why } of cases) {
    it(`resolves ${JSON.stringify(raw)} to ${expected} (${why})`, () => {
      const parsed = OceanNodeP2PConfigSchema.parse({ dhtFilter: raw })
      expect(parsed.dhtFilter).to.equal(expected)
    })
  }

  it('defaults to filterPrivate when absent', () => {
    const parsed = OceanNodeP2PConfigSchema.parse({})
    expect(parsed.dhtFilter).to.equal(dhtFilterMethod.filterPrivate)
  })

  // This is the exact case the bug hid behind: an unrecognised value used to fall through
  // parseInt's NaN into the default branch and land on filterNone. It must not any more.
  for (const raw of ['filterPrivatte', 'banana', 7, '7']) {
    it(`falls back to the default filterPrivate, not filterNone, for unrecognised value ${JSON.stringify(
      raw
    )}`, () => {
      const parsed = OceanNodeP2PConfigSchema.parse({ dhtFilter: raw })
      expect(parsed.dhtFilter).to.equal(dhtFilterMethod.filterPrivate)
      expect(parsed.dhtFilter).to.not.equal(dhtFilterMethod.filterNone)
    })
  }

  it('never rejects a malformed dhtFilter hard enough to stop the node booting', () => {
    expect(() =>
      OceanNodeP2PConfigSchema.parse({ dhtFilter: 'not-a-real-value' })
    ).to.not.throw()
  })
})
