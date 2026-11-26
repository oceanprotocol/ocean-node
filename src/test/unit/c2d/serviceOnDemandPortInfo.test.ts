import { expect } from 'chai'
import sinon from 'sinon'
import { C2DEngineDocker } from '../../../components/c2d/compute_engine_docker.js'
import {
  reserveHostPort,
  releaseHostPort
} from '../../../components/core/service/utils.js'
import { DEFAULT_SERVICE_HOST_PORT_RANGE } from '../../../@types/C2D/ServiceOnDemand.js'

// Unit tests for C2DEngineDocker.buildServiceOnDemandPortInfo() — the daemon-level service
// port-discovery block surfaced on each env by getComputeEnvironments. Driven with the same
// Object.create(prototype) + sinon-stub harness the other c2d engine unit tests use, so the
// private method runs without a real Docker socket or DB.
//
// NOTE: the in-memory reservation set in service/utils.ts is process-global and this file runs
// in the same mocha process as other suites, so every test reserves ports in its own band and
// releases them in finally.

function makeEngine(sodOverride: any, runningJobs: any): any {
  const engine: any = Object.create(C2DEngineDocker.prototype)
  engine.db = {
    getRunningServiceJobs: sinon.stub().resolves(runningJobs ?? [])
  }
  engine.getC2DConfig = () => ({
    hash: 'cluster-hash-1',
    connection: sodOverride === undefined ? {} : { serviceOnDemand: sodOverride }
  })
  return engine
}

const enabledSod = (extra: any = {}) => ({
  enabled: true,
  nodeHost: 'node1.example.com',
  hostPortRange: [45000, 45999] as [number, number],
  ...extra
})

describe('C2D engine — buildServiceOnDemandPortInfo', () => {
  afterEach(() => sinon.restore())

  describe('omission guards (returns undefined, never queries the DB)', () => {
    it('serviceOnDemand absent', async () => {
      const engine = makeEngine(undefined, [])
      expect(await engine.buildServiceOnDemandPortInfo()).to.equal(undefined)
      expect(engine.db.getRunningServiceJobs.called).to.equal(false)
    })

    it('enabled: false', async () => {
      const engine = makeEngine(enabledSod({ enabled: false }), [])
      expect(await engine.buildServiceOnDemandPortInfo()).to.equal(undefined)
      expect(engine.db.getRunningServiceJobs.called).to.equal(false)
    })

    it('missing nodeHost', async () => {
      const engine = makeEngine(enabledSod({ nodeHost: '' }), [])
      expect(await engine.buildServiceOnDemandPortInfo()).to.equal(undefined)
      expect(engine.db.getRunningServiceJobs.called).to.equal(false)
    })
  })

  describe('used-port union, filtering and ordering', () => {
    it('unions DB endpoint ports with in-memory reservations, range-filtered, deduped, ascending', async () => {
      const jobs = [
        { endpoints: [{ hostPort: 45010 }, { hostPort: 45005 }] },
        { endpoints: [{ hostPort: 45030 }] },
        { endpoints: undefined }, // ?? [] branch
        { endpoints: [{ hostPort: 44000 }] }, // below range → excluded
        { endpoints: [{ hostPort: 46000 }] } // above range → excluded
      ]
      const engine = makeEngine(enabledSod(), jobs)
      // In-memory reservations: one duplicates a DB port, one is unique, one is out of range.
      reserveHostPort(45010) // dup with DB → collapses
      reserveHostPort(45020) // unique in-range
      reserveHostPort(46500) // out of range → excluded
      try {
        const info = await engine.buildServiceOnDemandPortInfo()
        expect(info.nodeHost).to.equal('node1.example.com')
        expect(info.hostPortRange).to.deep.equal([45000, 45999])
        expect(info.maxPortsPerService).to.equal(64)
        expect(info.usedHostPorts).to.deep.equal([45005, 45010, 45020, 45030])
        // host-wide query (NOT scoped to a cluster hash): a host port is a host-wide resource,
        // and ranges are disjoint, so range-filtering across all clusters is what keeps a stale
        // port from a disabled/re-ranged daemon in this range visible.
        expect(engine.db.getRunningServiceJobs.calledWithExactly()).to.equal(true)
      } finally {
        ;[45010, 45020, 46500].forEach((p) => releaseHostPort(p))
      }
    })

    it('includes a stale port from another cluster that now falls in this range', async () => {
      // Transition case: a paid service of a daemon that was disabled/re-ranged still holds a
      // port that now sits inside THIS daemon's range. Host-wide range-filtering must surface it.
      const jobs = [
        { clusterHash: 'old-daemon', endpoints: [{ hostPort: 45040 }] },
        { clusterHash: 'cluster-hash-1', endpoints: [{ hostPort: 45041 }] }
      ]
      const engine = makeEngine(enabledSod(), jobs)
      const info = await engine.buildServiceOnDemandPortInfo()
      expect(info.usedHostPorts).to.deep.equal([45040, 45041])
    })

    it('defaults hostPortRange to DEFAULT_SERVICE_HOST_PORT_RANGE when unset', async () => {
      const engine = makeEngine(
        { enabled: true, nodeHost: 'node1.example.com' }, // no hostPortRange
        []
      )
      const info = await engine.buildServiceOnDemandPortInfo()
      expect(info.hostPortRange).to.deep.equal(DEFAULT_SERVICE_HOST_PORT_RANGE)
    })
  })

  describe('DB-failure degradation', () => {
    it('resolves (does not throw) and still returns the in-memory reservations', async () => {
      const engine = makeEngine(enabledSod(), [])
      engine.db.getRunningServiceJobs = sinon.stub().rejects(new Error('db down'))
      reserveHostPort(45111)
      try {
        const info = await engine.buildServiceOnDemandPortInfo()
        expect(info.usedHostPorts).to.deep.equal([45111])
      } finally {
        releaseHostPort(45111)
      }
    })
  })
})
