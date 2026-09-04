import { expect } from 'chai'
import { mapHostGpuDevices } from '../../../components/c2d/gpu/index.js'
import type { GpuDeviceMetrics } from '../../../components/c2d/gpu/types.js'
import type { ComputeResource } from '../../../@types/C2D/C2D.js'

/**
 * `mapHostGpuDevices` aligns host-enumerated GPU devices (from NVML `sampleAll`) to their
 * configured resource ids so the host-wide GPU series (`ocean_compute_gpu_*`, which now exist even
 * when idle) carry the same `gpu` label as `ocean_compute_env_resource_*`. That label alignment is
 * what lets the dashboard derive per-device `in_use` and dedupe the job-scoped fallback — if it is
 * wrong, series silently mis-label instead of failing, so it is pinned down here. This is the
 * NVML-free half of the host-GPU path; end-to-end enumeration needs a real NVIDIA host.
 */

// Minimal declared GPU resources: id 'gpu0'/'gpu1' each pinned to an NVML UUID, plus a non-GPU
// resource that must be ignored when building the UUID → id map.
const gpuResources = [
  {
    id: 'gpu0',
    type: 'gpu',
    init: { deviceRequests: { DeviceIDs: ['GPU-1111'] } }
  },
  {
    id: 'gpu1',
    type: 'gpu',
    init: { deviceRequests: { DeviceIDs: ['GPU-2222'] } }
  },
  { id: 'cpu', type: 'cpu' }
] as unknown as ComputeResource[]

function device(overrides: Partial<GpuDeviceMetrics>): GpuDeviceMetrics {
  return {
    resourceId: 'placeholder',
    vendor: 'nvidia',
    utilizationPercent: null,
    memoryUsedBytes: null,
    memoryTotalBytes: null,
    ...overrides
  }
}

describe('mapHostGpuDevices (host-wide GPU label mapping)', () => {
  it('maps an enumerated device to its configured resource id by NVML UUID', () => {
    const out = mapHostGpuDevices(
      [device({ uuid: 'GPU-2222', index: 3, utilizationPercent: 42 })],
      gpuResources
    )
    expect(out).to.have.length(1)
    expect(out[0].resourceId).to.equal('gpu1')
    expect(out[0].utilizationPercent).to.equal(42)
  })

  it('falls back to vendor+index when the UUID matches no configured resource', () => {
    const out = mapHostGpuDevices(
      [device({ uuid: 'GPU-UNKNOWN', index: 5 })],
      gpuResources
    )
    expect(out[0].resourceId).to.equal('nvidia5')
  })

  it('falls back to vendor+index when the device carries no UUID at all', () => {
    const out = mapHostGpuDevices([device({ index: 0 })], gpuResources)
    expect(out[0].resourceId).to.equal('nvidia0')
  })

  it('ignores non-GPU resources when building the UUID map', () => {
    // 'cpu' resource has no DeviceIDs; a device claiming to be it must not resolve to 'cpu'.
    const out = mapHostGpuDevices([device({ uuid: 'GPU-1111', index: 0 })], [
      { id: 'cpu', type: 'cpu', init: { deviceRequests: { DeviceIDs: ['GPU-1111'] } } }
    ] as unknown as ComputeResource[])
    expect(out[0].resourceId).to.equal('nvidia0')
  })

  it('preserves the sampled metric values, shared flag, and null-vs-number distinction', () => {
    const out = mapHostGpuDevices(
      [
        device({
          uuid: 'GPU-1111',
          index: 0,
          utilizationPercent: 0,
          memoryUsedBytes: 1024,
          memoryTotalBytes: 4096,
          temperatureC: 55,
          powerWatts: 120.5,
          shared: true
        })
      ],
      gpuResources
    )
    const g = out[0]
    expect(g.resourceId).to.equal('gpu0')
    expect(g.utilizationPercent).to.equal(0) // 0 (idle) is kept, not treated as "missing"
    expect(g.memoryUsedBytes).to.equal(1024)
    expect(g.memoryTotalBytes).to.equal(4096)
    expect(g.temperatureC).to.equal(55)
    expect(g.powerWatts).to.equal(120.5)
    expect(g.shared).to.equal(true)
  })

  it('returns an empty array for no devices (host has no visible GPUs)', () => {
    expect(mapHostGpuDevices([], gpuResources)).to.deep.equal([])
  })
})
