import { expect } from 'chai'
import { describe, it } from 'mocha'
import {
  addressCasingVariants,
  includesAddress,
  normalizeAddress,
  normalizeAddresses,
  normalizeCommandAddresses,
  sameAddress
} from '../../utils/evmAddress.js'

const CHECKSUMMED = '0x7C8226E267Cd509bCBE12B4e69fbE07052422Dbd'
const LOWERCASE = CHECKSUMMED.toLowerCase()
const UPPERCASE = '0x' + CHECKSUMMED.slice(2).toUpperCase()

describe('normalizeAddress', () => {
  it('checksums a lowercase address', () => {
    expect(normalizeAddress(LOWERCASE)).to.equal(CHECKSUMMED)
  })

  it('leaves an already checksummed address untouched', () => {
    expect(normalizeAddress(CHECKSUMMED)).to.equal(CHECKSUMMED)
  })

  it('checksums an all-uppercase address', () => {
    expect(normalizeAddress(UPPERCASE)).to.equal(CHECKSUMMED)
  })

  it('returns non-addresses unchanged so validators can still reject them', () => {
    // a mixed-case string with a BAD checksum is not a valid address: it must reach the
    // command validator as-is instead of throwing here
    const badChecksum = '0x7c8226E267Cd509bCBE12B4e69fbE07052422DBD'
    expect(normalizeAddress(badChecksum)).to.equal(badChecksum)
    expect(normalizeAddress('not-an-address')).to.equal('not-an-address')
    expect(normalizeAddress('')).to.equal('')
    expect(normalizeAddress(undefined as any)).to.equal(undefined)
    expect(normalizeAddress(null as any)).to.equal(null)
  })
})

describe('normalizeAddresses', () => {
  it('normalizes each entry and passes non-arrays through', () => {
    expect(normalizeAddresses([LOWERCASE, 'nope'])).to.deep.equal([CHECKSUMMED, 'nope'])
    expect(normalizeAddresses(undefined as any)).to.equal(undefined)
  })
})

describe('sameAddress / includesAddress', () => {
  it('compares addresses case-insensitively', () => {
    expect(sameAddress(LOWERCASE, CHECKSUMMED)).to.equal(true)
    expect(sameAddress(UPPERCASE, LOWERCASE)).to.equal(true)
  })

  it('is false for different addresses and for missing operands', () => {
    expect(sameAddress(CHECKSUMMED, '0x' + '1'.repeat(40))).to.equal(false)
    expect(sameAddress(undefined, CHECKSUMMED)).to.equal(false)
    expect(sameAddress(CHECKSUMMED, undefined)).to.equal(false)
    expect(sameAddress('', '')).to.equal(false)
  })

  it('matches list membership case-insensitively', () => {
    expect(includesAddress([LOWERCASE], CHECKSUMMED)).to.equal(true)
    expect(includesAddress([CHECKSUMMED], LOWERCASE)).to.equal(true)
    expect(includesAddress([], CHECKSUMMED)).to.equal(false)
    expect(includesAddress(undefined, CHECKSUMMED)).to.equal(false)
    expect(includesAddress([CHECKSUMMED], undefined)).to.equal(false)
  })
})

describe('addressCasingVariants', () => {
  it('offers the canonical and lowercase forms for a lowercase input, deduped', () => {
    const variants = addressCasingVariants(LOWERCASE)
    expect(variants).to.deep.equal([LOWERCASE, CHECKSUMMED])
  })

  it('offers both forms for a checksummed input, canonical first', () => {
    const variants = addressCasingVariants(CHECKSUMMED)
    expect(variants).to.deep.equal([CHECKSUMMED, LOWERCASE])
  })

  it('never returns duplicates', () => {
    for (const input of [LOWERCASE, CHECKSUMMED, UPPERCASE]) {
      const variants = addressCasingVariants(input)
      expect(variants.length).to.equal(new Set(variants).size)
    }
  })

  it('passes a non-string through as a single candidate', () => {
    expect(addressCasingVariants(undefined as any)).to.deep.equal([undefined])
  })
})

describe('normalizeCommandAddresses', () => {
  it('canonicalizes every known address field in place', () => {
    const task: any = {
      command: 'computeGetStatus',
      consumerAddress: LOWERCASE,
      owner: LOWERCASE,
      address: LOWERCASE,
      decrypterAddress: LOWERCASE,
      dataNftAddress: LOWERCASE,
      publisherAddress: LOWERCASE,
      consumerAddrs: [LOWERCASE, UPPERCASE],
      additionalViewers: [LOWERCASE]
    }
    const returned = normalizeCommandAddresses(task)
    expect(returned).to.equal(task) // mutated in place
    expect(task.consumerAddress).to.equal(CHECKSUMMED)
    expect(task.owner).to.equal(CHECKSUMMED)
    expect(task.address).to.equal(CHECKSUMMED)
    expect(task.decrypterAddress).to.equal(CHECKSUMMED)
    expect(task.dataNftAddress).to.equal(CHECKSUMMED)
    expect(task.publisherAddress).to.equal(CHECKSUMMED)
    expect(task.consumerAddrs).to.deep.equal([CHECKSUMMED, CHECKSUMMED])
    expect(task.additionalViewers).to.deep.equal([CHECKSUMMED])
  })

  it('leaves unrelated fields, absent fields and invalid values alone', () => {
    const task: any = {
      command: 'computeGetStatus',
      jobId: '0xNOTanADDRESS',
      // a JWT-ish token must not be touched even though it is a string field
      authorization: 'Bearer abc.def.ghi',
      consumerAddress: 'not-an-address',
      signature: '0xdeadbeef'
    }
    normalizeCommandAddresses(task)
    expect(task.jobId).to.equal('0xNOTanADDRESS')
    expect(task.authorization).to.equal('Bearer abc.def.ghi')
    expect(task.consumerAddress).to.equal('not-an-address')
    expect(task.signature).to.equal('0xdeadbeef')
    expect('owner' in task).to.equal(false)
  })

  it('tolerates null/undefined/non-object input', () => {
    expect(normalizeCommandAddresses(null)).to.equal(null)
    expect(normalizeCommandAddresses(undefined)).to.equal(undefined)
    expect(normalizeCommandAddresses('x' as any)).to.equal('x')
  })
})
