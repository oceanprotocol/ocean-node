import { expect } from 'chai'
import net from 'net'
import type { ServiceJob } from '../../../@types/C2D/ServiceOnDemand.js'
import {
  userDataToEnv,
  toPublicServiceJob,
  toListedServiceJob,
  decryptUserData,
  allocateHostPort,
  releaseHostPort,
  reserveHostPort,
  reserveSpecificHostPort,
  isHostPortFree,
  portInRange,
  normalizePortSpec,
  parseSinceParam
} from '../../../components/core/service/utils.js'

// The repo does not use chai-as-promised; assert async rejections explicitly.
async function assertRejects(p: Promise<unknown>, re: RegExp) {
  try {
    await p
    expect.fail('expected the promise to reject')
  } catch (e: any) {
    expect(e.message).to.match(re)
  }
}

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
    it('keeps user metadata (returned to the owner on SERVICE_GET_STATUS)', () => {
      const job = {
        serviceId: 's1',
        userData: 'ENCRYPTED',
        owner: '0xabc',
        endpoints: [],
        metadata: { run: 'exp-7', attempt: 2 }
      } as unknown as ServiceJob
      const pub = toPublicServiceJob(job)
      expect(pub).to.have.property('metadata')
      expect((pub as ServiceJob).metadata).to.deep.equal({ run: 'exp-7', attempt: 2 })
    })
    it('is null-safe', () => {
      expect(toPublicServiceJob(null)).to.equal(null)
    })
  })

  describe('toListedServiceJob', () => {
    it('keeps metadata but strips userData/config fields from the anonymous listing', () => {
      const job = {
        serviceId: 's1',
        userData: 'ENCRYPTED',
        owner: '0xabc',
        endpoints: [],
        dockerCmd: ['a'],
        dockerEntrypoint: ['/e'],
        dockerfile: 'FROM x',
        metadata: { run: 'exp-7', attempt: 2 }
      } as unknown as ServiceJob
      const listed = toListedServiceJob(job)
      expect(listed).to.have.property('metadata')
      expect((listed as ServiceJob).metadata).to.deep.equal({ run: 'exp-7', attempt: 2 })
      expect(listed).to.not.have.property('userData')
      expect(listed).to.not.have.property('dockerCmd')
      expect(listed).to.not.have.property('dockerEntrypoint')
      expect(listed).to.not.have.property('dockerfile')
      expect(listed).to.have.property('serviceId', 's1')
    })
    it('leaves out what the service produced: output archives and saved logs', () => {
      const archive = {
        index: 0,
        filesize: 1,
        createdAt: 0,
        containerId: 'c1'
      }
      const job = {
        serviceId: 's1',
        owner: '0xabc',
        endpoints: [],
        outputArchives: [{ ...archive, filename: 'outputs-0.zip' }],
        logArchives: [{ ...archive, filename: 'logs-0.log' }]
      } as unknown as ServiceJob
      const listed = toListedServiceJob(job)
      expect(listed).to.not.have.property('outputArchives')
      expect(listed).to.not.have.property('logArchives')
      // stripped from the node-wide list only: the owner still needs them on their own status
      expect(toPublicServiceJob(job)).to.have.property('logArchives')
    })
    it('is null-safe', () => {
      expect(toListedServiceJob(null)).to.equal(null)
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

  describe('portInRange', () => {
    it('true inside, false outside, false for non-integers', () => {
      expect(portInRange(30000, [30000, 32767])).to.equal(true)
      expect(portInRange(32767, [30000, 32767])).to.equal(true)
      expect(portInRange(29999, [30000, 32767])).to.equal(false)
      expect(portInRange(32768, [30000, 32767])).to.equal(false)
      expect(portInRange(30000.5, [30000, 32767])).to.equal(false)
    })
  })

  describe('reserveSpecificHostPort', () => {
    it('rejects an out-of-range port', () =>
      assertRejects(reserveSpecificHostPort(100, 41000, 41999), /range/))

    it('rejects a port already reserved in-memory', async () => {
      await reserveSpecificHostPort(41500, 41000, 41999)
      try {
        await assertRejects(reserveSpecificHostPort(41500, 41000, 41999), /not free/)
      } finally {
        releaseHostPort(41500)
      }
    })

    it('ownedBusyOk skips the OS check ONLY for a port already reserved in-memory', async () => {
      const srv = net.createServer()
      await new Promise<void>((resolve) => srv.listen(41777, '0.0.0.0', () => resolve()))
      try {
        // Not owned (absent from allocatedPorts) + OS-busy → rejected even with ownedBusyOk. A
        // Stopped/Error service's port is NOT seeded (seedAllocatedPorts seeds running jobs only),
        // so "owned" inferred from job.endpoints must not blindly bypass the freeness check for a
        // port that may have been reassigned after a node restart (regression for fix #4).
        await assertRejects(
          reserveSpecificHostPort(41777, 41000, 41999, { ownedBusyOk: true }),
          /not free/
        )
        // Genuinely owned: the port IS in allocatedPorts (as a running service's own port is) and
        // its container still binds it at the OS level → ownedBusyOk keeps it reserved, skipping
        // both the in-memory and OS checks.
        reserveHostPort(41777)
        await reserveSpecificHostPort(41777, 41000, 41999, { ownedBusyOk: true })
      } finally {
        await new Promise((resolve) => srv.close(() => resolve(null)))
        releaseHostPort(41777)
      }
    })

    it('ownedBusyOk succeeds when the port is already reserved in-memory', async () => {
      // Production state: a running service's own host ports are already in allocatedPorts, so a
      // restart re-pinning its own port must still succeed via ownedBusyOk (regression test).
      await reserveSpecificHostPort(41888, 41000, 41999)
      try {
        await reserveSpecificHostPort(41888, 41000, 41999, { ownedBusyOk: true })
      } finally {
        releaseHostPort(41888)
      }
    })

    it('two concurrent reservations of the same port: exactly one wins', async () => {
      const results = await Promise.allSettled([
        reserveSpecificHostPort(41999, 41000, 41999),
        reserveSpecificHostPort(41999, 41000, 41999)
      ])
      const fulfilled = results.filter((r) => r.status === 'fulfilled')
      try {
        expect(fulfilled).to.have.length(1)
      } finally {
        releaseHostPort(41999)
      }
    })
  })

  describe('isHostPortFree', () => {
    it('false when reserved, true after release', async () => {
      await reserveSpecificHostPort(41600, 41000, 41999)
      expect(await isHostPortFree(41600)).to.equal(false)
      releaseHostPort(41600)
      expect(await isHostPortFree(41600)).to.equal(true)
    })
  })

  describe('normalizePortSpec', () => {
    it('maps pairs; pinned entries land in requestedHostPorts, auto entries do not', () => {
      expect(
        normalizePortSpec([
          { containerPort: 8080, hostPort: 30010 },
          { containerPort: 9090 }
        ])
      ).to.deep.equal({
        exposedPorts: [8080, 9090],
        requestedHostPorts: { '8080': 30010 }
      })
    })
    it('omits requestedHostPorts when no entry is pinned', () => {
      expect(normalizePortSpec([{ containerPort: 8080 }])).to.deep.equal({
        exposedPorts: [8080],
        requestedHostPorts: undefined
      })
    })
    it('legacy exposedPorts path is unchanged (no requestedHostPorts)', () => {
      expect(normalizePortSpec(undefined, [7000, 7001])).to.deep.equal({
        exposedPorts: [7000, 7001]
      })
    })
    it('ports supersedes exposedPorts when both are given', () => {
      expect(normalizePortSpec([{ containerPort: 8080 }], [9999])).to.deep.equal({
        exposedPorts: [8080],
        requestedHostPorts: undefined
      })
    })
    it('both omitted → empty exposedPorts (unchanged behaviour)', () => {
      expect(normalizePortSpec(undefined, undefined)).to.deep.equal({ exposedPorts: [] })
    })
  })
})
