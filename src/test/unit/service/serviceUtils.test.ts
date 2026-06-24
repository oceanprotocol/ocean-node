import { expect } from 'chai'
import type { ServiceJob } from '../../../@types/C2D/ServiceOnDemand.js'
import {
  userDataToEnv,
  toPublicServiceJob,
  decryptUserData,
  allocateHostPort,
  releaseHostPort
} from '../../../components/core/service/utils.js'

describe('service utils', () => {
  describe('userDataToEnv', () => {
    it('maps a decrypted userData object into a stringified env map', () => {
      expect(userDataToEnv({ MODEL_ID: 'm', PORT: 8000, FLAG: true })).to.deep.equal({
        MODEL_ID: 'm',
        PORT: '8000',
        FLAG: 'true'
      })
    })
    it('skips null/undefined values', () => {
      expect(userDataToEnv({ A: 'x', B: null, C: undefined })).to.deep.equal({ A: 'x' })
    })
    it('empty object → {}', () => {
      expect(userDataToEnv({})).to.deep.equal({})
    })
  })

  describe('toPublicServiceJob', () => {
    it('strips userData, keeps other fields', () => {
      const job = {
        serviceId: 's1',
        userData: 'ENCRYPTED',
        owner: '0xabc',
        endpoints: []
      } as unknown as ServiceJob
      const pub = toPublicServiceJob(job)
      expect(pub).to.not.have.property('userData')
      expect(pub).to.have.property('serviceId', 's1')
    })
    it('is null-safe', () => {
      expect(toPublicServiceJob(null)).to.equal(null)
    })
  })

  describe('decryptUserData', () => {
    const fakeKeyManager = {
      decrypt: (data: Uint8Array) => Promise.resolve(Buffer.from(data))
    } as any
    it('returns {} when undefined', async () => {
      expect(await decryptUserData(undefined, fakeKeyManager)).to.deep.equal({})
    })
    it('decrypts + JSON-parses a hex payload', async () => {
      const payload = JSON.stringify({ MODEL_ID: 'm' })
      const hex = Buffer.from(payload).toString('hex')
      const out = await decryptUserData(hex, fakeKeyManager)
      expect(out).to.deep.equal({ MODEL_ID: 'm' })
    })
    it('propagates when decrypted payload is not valid JSON', async () => {
      const hex = Buffer.from('not-json').toString('hex')
      let threw = false
      try {
        await decryptUserData(hex, fakeKeyManager)
      } catch {
        threw = true
      }
      expect(threw).to.equal(true)
    })
  })

  describe('allocateHostPort', () => {
    it('never hands out the same port to concurrent callers (TOCTOU)', async () => {
      // A range exactly the size of the request count: every port must be used
      // once and only once. Without reserving before the async isPortFree() check,
      // concurrent calls would race and return duplicates.
      const rangeStart = 41000
      const count = 12
      const rangeEnd = rangeStart + count - 1

      const ports = await Promise.all(
        Array.from({ length: count }, () => allocateHostPort(rangeStart, rangeEnd))
      )
      try {
        expect(new Set(ports).size).to.equal(count) // all unique
        ports.forEach((p) =>
          expect(p).to.be.within(rangeStart, rangeEnd, `port ${p} out of range`)
        )
      } finally {
        ports.forEach((p) => releaseHostPort(p))
      }
    })
  })
})
