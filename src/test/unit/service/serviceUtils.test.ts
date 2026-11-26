import { expect } from 'chai'
import net from 'net'
import type { ServiceJob } from '../../../@types/C2D/ServiceOnDemand.js'
import { ServiceStatusNumber } from '../../../@types/C2D/ServiceOnDemand.js'
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
  reservedHostPortsInRange,
  seedAllocatedPorts,
  reclaimExpiredHostPorts,
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

  describe('reservedHostPortsInRange', () => {
    it('returns only in-memory reservations that fall inside the range', () => {
      // Reserve inside and outside the probe range, plus a boundary value.
      reserveHostPort(42000) // inside
      reserveHostPort(42999) // inside (upper boundary)
      reserveHostPort(41999) // just below range → excluded
      reserveHostPort(43000) // just above range → excluded
      try {
        const got = reservedHostPortsInRange([42000, 42999]).sort((a, b) => a - b)
        expect(got).to.include(42000)
        expect(got).to.include(42999)
        expect(got).to.not.include(41999)
        expect(got).to.not.include(43000)
      } finally {
        ;[42000, 42999, 41999, 43000].forEach((p) => releaseHostPort(p))
      }
    })

    it('reflects release (a freed port no longer appears)', () => {
      reserveHostPort(42500)
      try {
        expect(reservedHostPortsInRange([42000, 42999])).to.include(42500)
      } finally {
        releaseHostPort(42500)
      }
      expect(reservedHostPortsInRange([42000, 42999])).to.not.include(42500)
    })

    it('returns a fresh array and [] for an empty range', () => {
      const a = reservedHostPortsInRange([44000, 44100])
      const b = reservedHostPortsInRange([44000, 44100])
      expect(a).to.deep.equal([])
      expect(a).to.not.equal(b) // a new array each call; mutating one must not affect the next
    })
  })

  describe('seedAllocatedPorts (host-wide; reserved until finalized)', () => {
    const future = Date.now() + 60 * 60 * 1000
    const past = Date.now() - 1000
    // getRunningServiceJobs() returns exactly the NON-TERMINAL jobs (it excludes Expired), across
    // every cluster, as it would after a restart. 47001 is on a removed daemon; 47002 is past its
    // paid window but NOT yet finalized; 47003 has no expiresAt. All three are still reserved —
    // release is driven by finalization (Expired), not by expiresAt.
    const db: any = {
      getRunningServiceJobs: () =>
        Promise.resolve([
          { clusterHash: 'removed', endpoints: [{ hostPort: 47001 }], expiresAt: future },
          { clusterHash: 'other', endpoints: [{ hostPort: 47002 }], expiresAt: past },
          { clusterHash: 'current', endpoints: [{ hostPort: 47003 }] }
        ])
    }

    it('reserves every non-terminal job across clusters (no expiresAt skip)', async () => {
      await seedAllocatedPorts(db)
      try {
        const got = reservedHostPortsInRange([47000, 47999])
        expect(got).to.include(47001) // orphan from a removed daemon
        expect(got).to.include(47002) // past paid window but not finalized → still reserved
        expect(got).to.include(47003) // no expiresAt
      } finally {
        ;[47001, 47002, 47003].forEach((p) => releaseHostPort(p))
      }
    })

    it('a seeded orphan port cannot be stolen by another daemon after restart', async () => {
      // Regression: removed daemon + stopped (unbound) paid service + restart. seedAllocatedPorts
      // must make the allocator refuse that still-reserved port even though nothing binds it at the
      // OS level.
      await seedAllocatedPorts(db)
      try {
        await assertRejects(reserveSpecificHostPort(47001, 47000, 47999), /not free/)
      } finally {
        ;[47001, 47002, 47003].forEach((p) => releaseHostPort(p))
      }
    })
  })

  describe('reclaimExpiredHostPorts (mid-run orphan release, no restart)', () => {
    const CONFIGURED = new Set(['current'])
    const LOCAL_RANGES: [number, number][] = [[48000, 48999]]

    it('releases an orphan port once its window has passed, keeps active and in-flight ports', async () => {
      // Mutable job list so the SAME process can "advance past expiry" between calls — no restart.
      let orphanExpiresAt = Date.now() + 60 * 60 * 1000 // in-window at first
      const db: any = {
        updateServiceJob: () => Promise.resolve(1),
        getRunningServiceJobs: () =>
          Promise.resolve([
            {
              serviceId: 'orphan',
              clusterHash: 'removed',
              endpoints: [{ hostPort: 48001 }],
              expiresAt: orphanExpiresAt
            },
            {
              serviceId: 'live',
              clusterHash: 'current',
              endpoints: [{ hostPort: 48002 }],
              expiresAt: Date.now() + 60 * 60 * 1000
            } // stays active
          ])
      }

      // Boot: seed reserves both. Also simulate an in-flight reservation with no persisted job.
      await seedAllocatedPorts(db)
      reserveHostPort(48003) // in-flight: reserved, on no job's endpoints
      try {
        // Nothing expired yet → reclaim is a no-op.
        expect(await reclaimExpiredHostPorts(db, CONFIGURED, LOCAL_RANGES)).to.equal(0)
        expect(reservedHostPortsInRange([48000, 48999])).to.deep.equal([
          48001, 48002, 48003
        ])

        // Advance past the orphan's window (same process), then reclaim.
        orphanExpiresAt = Date.now() - 1000
        const released = await reclaimExpiredHostPorts(db, CONFIGURED, LOCAL_RANGES)
        expect(released).to.equal(1)
        const left = reservedHostPortsInRange([48000, 48999])
        expect(left).to.not.include(48001) // orphan freed mid-run
        expect(left).to.include(48002) // active job's port kept
        expect(left).to.include(48003) // in-flight reservation kept
      } finally {
        ;[48001, 48002, 48003].forEach((p) => releaseHostPort(p))
      }
    })

    it('never reclaims an expired job on a still-configured cluster (its engine owns teardown)', async () => {
      const db: any = {
        updateServiceJob: () => Promise.resolve(1),
        getRunningServiceJobs: () =>
          Promise.resolve([
            {
              serviceId: 'live-expired',
              clusterHash: 'current', // configured → left to its own engine
              endpoints: [{ hostPort: 48010 }],
              expiresAt: Date.now() - 1000
            }
          ])
      }
      await seedAllocatedPorts(db) // non-terminal → reserved (held until its engine finalizes it)
      try {
        expect(await reclaimExpiredHostPorts(db, CONFIGURED, LOCAL_RANGES)).to.equal(0)
        expect(reservedHostPortsInRange([48000, 48999])).to.include(48010)
      } finally {
        releaseHostPort(48010)
      }
    })

    it('never reclaims an orphan port outside every local daemon range (remote-unsafe)', async () => {
      // isPortFree is a LOCAL probe; a port outside any local daemon's range may be on a remote
      // host, so a free local port must not finalize it. Left reserved.
      const db: any = {
        updateServiceJob: () => Promise.resolve(1),
        getRunningServiceJobs: () =>
          Promise.resolve([
            {
              serviceId: 'remote-orphan',
              clusterHash: 'removed',
              endpoints: [{ hostPort: 49500 }], // outside LOCAL_RANGES ([48000,48999])
              expiresAt: Date.now() - 1000
            }
          ])
      }
      await seedAllocatedPorts(db)
      try {
        expect(await reclaimExpiredHostPorts(db, CONFIGURED, LOCAL_RANGES)).to.equal(0)
        expect(reservedHostPortsInRange([49000, 49999])).to.include(49500)
      } finally {
        releaseHostPort(49500)
      }
    })

    it('finalizes the orphan so a reused port is not reclaimed by a later sweep (race)', async () => {
      // The CodeRabbit race: reclaim frees an orphan's port, a NEW start reuses it (endpoint not
      // yet persisted), and a SECOND sweep must NOT treat that reused port as the orphan's and
      // delete the new reservation. The fix finalizes the orphan (status Expired) so it drops out
      // of getRunningServiceJobs() and can never re-flag the port.
      const orphan: any = {
        serviceId: 'orphan',
        clusterHash: 'removed',
        endpoints: [{ hostPort: 48020 }],
        expiresAt: Date.now() - 1000
      }
      const jobs: any[] = [orphan]
      const db: any = {
        getRunningServiceJobs: () => Promise.resolve(jobs.slice()),
        // Mirror the real query: it returns only NON-TERMINAL jobs, so a job drops out ONLY when it
        // is finalized to Expired. Removing on any other status would hide a finalization bug, so
        // the test fails unless reclaim writes exactly ServiceStatusNumber.Expired.
        updateServiceJob: (j: any) => {
          if (j.status === ServiceStatusNumber.Expired) {
            const i = jobs.findIndex((x) => x.serviceId === j.serviceId)
            if (i >= 0) jobs.splice(i, 1)
          }
          return Promise.resolve(1)
        }
      }
      reserveHostPort(48020) // the orphan's still-held reservation after restart
      try {
        // Sweep 1: orphan expired + local-range + unbound → finalized (Expired) and released.
        expect(await reclaimExpiredHostPorts(db, CONFIGURED, LOCAL_RANGES)).to.equal(1)
        expect(reservedHostPortsInRange([48000, 48999])).to.not.include(48020)

        // A NEW start reuses the freed port (its job/endpoint not persisted yet).
        reserveHostPort(48020)
        // Sweep 2: the orphan is now Expired (gone from the query) → the reused port is NOT touched.
        expect(await reclaimExpiredHostPorts(db, CONFIGURED, LOCAL_RANGES)).to.equal(0)
        expect(reservedHostPortsInRange([48000, 48999])).to.include(48020)
      } finally {
        releaseHostPort(48020)
      }
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
