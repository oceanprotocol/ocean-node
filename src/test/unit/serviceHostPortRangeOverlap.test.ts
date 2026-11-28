import { expect } from 'chai'
import type { C2DDockerConfig } from '../../@types/C2D/C2D.js'
import { assertNoOverlappingServiceHostPortRanges } from '../../utils/config/builder.js'

// assertNoOverlappingServiceHostPortRanges rejects configs where two service-enabled docker
// daemons would share part of the single process-wide host-port reservation pool.
function daemon(serviceOnDemand: any): C2DDockerConfig {
  return { socketPath: '/var/run/docker.sock', serviceOnDemand } as C2DDockerConfig
}

const sod = (extra: any = {}) => ({
  enabled: true,
  nodeHost: 'localhost',
  ...extra
})

describe('assertNoOverlappingServiceHostPortRanges', () => {
  it('accepts an empty / undefined list', () => {
    expect(() =>
      assertNoOverlappingServiceHostPortRanges(undefined as any)
    ).to.not.throw()
    expect(() => assertNoOverlappingServiceHostPortRanges([])).to.not.throw()
  })

  it('accepts a single service-enabled daemon', () => {
    expect(() =>
      assertNoOverlappingServiceHostPortRanges([
        daemon(sod({ hostPortRange: [30000, 31000] }))
      ])
    ).to.not.throw()
  })

  it('accepts disjoint ranges', () => {
    expect(() =>
      assertNoOverlappingServiceHostPortRanges([
        daemon(sod({ hostPortRange: [30000, 31000] })),
        daemon(sod({ hostPortRange: [31001, 32000] }))
      ])
    ).to.not.throw()
  })

  it('rejects overlapping ranges', () => {
    expect(() =>
      assertNoOverlappingServiceHostPortRanges([
        daemon(sod({ hostPortRange: [30000, 31000] })),
        daemon(sod({ hostPortRange: [30900, 32000] }))
      ])
    ).to.throw(/overlap/i)
  })

  it('rejects a boundary (single-port) overlap', () => {
    expect(() =>
      assertNoOverlappingServiceHostPortRanges([
        daemon(sod({ hostPortRange: [30000, 31000] })),
        daemon(sod({ hostPortRange: [31000, 32000] })) // shares 31000
      ])
    ).to.throw(/overlap/i)
  })

  it('rejects two daemons that both omit hostPortRange (shared default)', () => {
    expect(() =>
      assertNoOverlappingServiceHostPortRanges([daemon(sod()), daemon(sod())])
    ).to.throw(/overlap/i)
  })

  it('ignores daemons with Service-on-Demand disabled or absent', () => {
    // A disabled daemon reserves no host ports, so its range cannot collide.
    expect(() =>
      assertNoOverlappingServiceHostPortRanges([
        daemon(sod({ enabled: false, hostPortRange: [30000, 32000] })),
        daemon(sod({ hostPortRange: [30000, 32000] })),
        { socketPath: '/var/run/docker.sock' } as C2DDockerConfig // no serviceOnDemand
      ])
    ).to.not.throw()
  })
})
