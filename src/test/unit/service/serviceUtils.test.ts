import { expect } from 'chai'
import type { ServiceJob } from '../../../@types/C2D/ServiceOnDemand.js'
import {
  userDataToEnv,
  toPublicServiceJob,
  decryptUserData,
  allocateHostPort,
  releaseHostPort,
  parseSinceParam
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

  describe('parseSinceParam', () => {
    it('returns undefined when omitted', () => {
      expect(parseSinceParam(undefined)).to.equal(undefined)
    })
    it('parses an all-digit string as an absolute Unix timestamp', () => {
      expect(parseSinceParam('1735689600')).to.equal(1735689600)
    })
    for (const [input, seconds] of [
      ['30s', 30],
      ['45m', 45 * 60],
      ['2h', 2 * 3600],
      ['7d', 7 * 86400]
    ] as [string, number][]) {
      it(`converts relative duration "${input}" to now - ${seconds}s`, () => {
        const before = Math.floor(Date.now() / 1000) - seconds
        const result = parseSinceParam(input)
        const after = Math.floor(Date.now() / 1000) - seconds
        expect(result).to.be.within(before, after)
      })
    }
    it('throws on an invalid format', () => {
      expect(() => parseSinceParam('not-valid')).to.throw(/Invalid "since" parameter/)
    })
    it('throws on an unsupported unit', () => {
      expect(() => parseSinceParam('5w')).to.throw(/Invalid "since" parameter/)
    })
  })

  describe('allocateHostPort', () => {
    it('never hands out the same port to concurrent callers (TOCTOU)', async () => {
      // Property under test: concurrent allocations are always unique. allocateHostPort
      // reserves a candidate synchronously (allocatedPorts.add) before the async
      // isPortFree() check, so no two concurrent callers can return the same port.
      // Use a range far larger than the request count — the allocator probes randomly with
      // a bounded retry budget, so an exact-fit range would flake (and CI may already hold
      // some ports); ample headroom isolates the uniqueness guarantee from exhaustion.
      const rangeStart = 41000
      const rangeEnd = 41999 // 1000 ports
      const count = 25

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
