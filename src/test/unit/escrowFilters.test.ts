import { expect } from 'chai'
import {
  isRangeFilter,
  validateEscrowRanges,
  splitRanges,
  passesClientRanges,
  buildTypesenseFilterBy,
  buildElasticQuery,
  NATIVE_RANGE_FIELDS,
  CLIENT_RANGE_FIELDS
} from '../../components/database/escrowSearch.js'

describe('escrow search filter helpers', () => {
  describe('isRangeFilter', () => {
    it('recognizes range objects and rejects scalars', () => {
      expect(isRangeFilter({ min: 1 })).to.equal(true)
      expect(isRangeFilter({ max: '10' })).to.equal(true)
      expect(isRangeFilter({ gt: 1, lt: 2 })).to.equal(true)
      expect(isRangeFilter('0xabc')).to.equal(false)
      expect(isRangeFilter(123)).to.equal(false)
      expect(isRangeFilter(true)).to.equal(false)
      expect(isRangeFilter(null)).to.equal(false)
      expect(isRangeFilter({})).to.equal(false)
      expect(isRangeFilter([1, 2])).to.equal(false)
    })
  })

  describe('validateEscrowRanges', () => {
    it('accepts undefined and empty ranges', () => {
      expect(validateEscrowRanges(undefined).valid).to.equal(true)
      expect(validateEscrowRanges({}).valid).to.equal(true)
    })

    it('accepts known native and client fields', () => {
      expect(validateEscrowRanges({ block: { min: 1, max: 2 } }).valid).to.equal(true)
      expect(validateEscrowRanges({ subsidyAmount: { min: '1000' } }).valid).to.equal(
        true
      )
    })

    it('rejects an unknown range field', () => {
      const res = validateEscrowRanges({ payer: { min: 1 } } as any)
      expect(res.valid).to.equal(false)
      expect(res.reason).to.contain('payer')
    })

    it('rejects a non-integer bound', () => {
      const res = validateEscrowRanges({ block: { min: 'abc' } })
      expect(res.valid).to.equal(false)
      expect(res.reason).to.contain('integer')
    })

    it('rejects min > max', () => {
      const res = validateEscrowRanges({ block: { min: 10, max: 5 } })
      expect(res.valid).to.equal(false)
      expect(res.reason).to.contain('min must be <= max')
    })

    it('rejects gt >= lt', () => {
      const res = validateEscrowRanges({ block: { gt: 5, lt: 5 } })
      expect(res.valid).to.equal(false)
      expect(res.reason).to.contain('gt must be < lt')
    })

    it('rejects a range object with no bounds', () => {
      const res = validateEscrowRanges({ block: {} as any })
      expect(res.valid).to.equal(false)
    })
  })

  describe('splitRanges', () => {
    it('routes native fields to the store and uint256 fields client-side', () => {
      const { nativeRanges, clientRanges } = splitRanges({
        block: { min: 1 },
        chainId: { max: 8996 },
        subsidyAmount: { min: '1000' },
        bonusAmount: { max: '5' }
      })
      expect(Object.keys(nativeRanges).sort()).to.deep.equal(['block', 'chainId'].sort())
      expect(Object.keys(clientRanges).sort()).to.deep.equal(
        ['bonusAmount', 'subsidyAmount'].sort()
      )
    })

    it('every native/client field list stays disjoint', () => {
      for (const f of NATIVE_RANGE_FIELDS) {
        expect(CLIENT_RANGE_FIELDS).to.not.include(f)
      }
    })
  })

  describe('passesClientRanges (BigInt comparison)', () => {
    it('compares numerically, not lexicographically', () => {
      // "9" > "100" lexicographically, but 9 < 100 numerically
      const record = { subsidyAmount: '9' }
      expect(passesClientRanges(record, { subsidyAmount: { max: '100' } })).to.equal(true)
      expect(passesClientRanges(record, { subsidyAmount: { min: '100' } })).to.equal(
        false
      )
    })

    it('handles very large uint256 values', () => {
      const big =
        '115792089237316195423570985008687907853269984665640564039457584007913129639935'
      const record = { amount: big }
      expect(
        passesClientRanges(record, {
          amount: {
            min: '115792089237316195423570985008687907853269984665640564039457584007913129639900'
          }
        })
      ).to.equal(true)
      expect(passesClientRanges(record, { amount: { gt: big } })).to.equal(false)
      expect(passesClientRanges(record, { amount: { max: big } })).to.equal(true)
    })

    it('respects inclusive vs exclusive bounds', () => {
      const record = { amount: '100' }
      expect(passesClientRanges(record, { amount: { min: '100' } })).to.equal(true)
      expect(passesClientRanges(record, { amount: { gt: '100' } })).to.equal(false)
      expect(passesClientRanges(record, { amount: { max: '100' } })).to.equal(true)
      expect(passesClientRanges(record, { amount: { lt: '100' } })).to.equal(false)
      expect(passesClientRanges(record, { amount: { min: '50', max: '150' } })).to.equal(
        true
      )
    })

    it('excludes records missing the field or with a non-numeric value', () => {
      expect(passesClientRanges({}, { amount: { min: '1' } })).to.equal(false)
      expect(
        passesClientRanges({ amount: 'not-a-number' }, { amount: { min: '1' } })
      ).to.equal(false)
    })
  })

  describe('buildTypesenseFilterBy', () => {
    it('builds exact-match clauses and backtick-escapes strings', () => {
      const out = buildTypesenseFilterBy({ chainId: 8996, payer: '0xABC' })
      expect(out).to.contain('chainId:=8996')
      expect(out).to.contain('payer:=`0xABC`')
      expect(out).to.contain(' && ')
    })

    it('strips backticks from string values', () => {
      const out = buildTypesenseFilterBy({ token: 'a`b' })
      expect(out).to.equal('token:=`ab`')
    })

    it('emits range operators for range objects', () => {
      const out = buildTypesenseFilterBy({ block: { min: 100, max: 200 } })
      expect(out).to.equal('block:>=100 && block:<=200')
      expect(buildTypesenseFilterBy({ block: { gt: 1, lt: 9 } })).to.equal(
        'block:>1 && block:<9'
      )
    })

    it('handles booleans and skips empty values', () => {
      const out = buildTypesenseFilterBy({
        reclaimable: true,
        payee: undefined,
        token: ''
      })
      expect(out).to.equal('reclaimable:=true')
    })
  })

  describe('buildElasticQuery', () => {
    it('builds term clauses for equality', () => {
      const q = buildElasticQuery({ chainId: 8996, payer: '0xabc' })
      expect(q).to.deep.equal({
        bool: {
          must: [{ term: { chainId: 8996 } }, { term: { payer: '0xabc' } }]
        }
      })
    })

    it('builds range clauses for range objects', () => {
      const q = buildElasticQuery({ block: { min: 100, max: 200 } })
      expect(q).to.deep.equal({
        bool: { must: [{ range: { block: { gte: 100, lte: 200 } } }] }
      })
    })

    it('returns match_all when there are no filters', () => {
      expect(buildElasticQuery({})).to.deep.equal({ match_all: {} })
      expect(buildElasticQuery({ a: undefined, b: '' })).to.deep.equal({
        match_all: {}
      })
    })
  })
})
