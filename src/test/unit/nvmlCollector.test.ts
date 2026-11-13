import { expect } from 'chai'
import {
  NvmlGpuCollector,
  NVML_RETRY_MAX_MS,
  NVML_RETRY_MIN_MS
} from '../../components/c2d/gpu/nvml.js'

// A stand-in for the koffi module, faithful where the bug lives: koffi type names are
// process-global, so defining the same struct name twice throws "Duplicate type name", exactly
// as real koffi does. `initRcs` scripts nvmlInit_v2's return codes call by call (the last one
// repeats); `failLoads` makes the first N koffi.load() calls throw (library not loadable yet).
function fakeKoffi(opts: { initRcs?: number[]; failLoads?: number } = {}) {
  const initRcs = [...(opts.initRcs ?? [0])]
  let failLoads = opts.failLoads ?? 0
  const typeNames = new Set<string>()
  const calls = { load: 0, init: 0, shutdown: 0 }
  const symbols: Record<string, (...a: any[]) => number> = {
    nvmlInit_v2: () => {
      calls.init++
      return initRcs.length > 1 ? initRcs.shift() : initRcs[0]
    },
    nvmlShutdown: () => {
      calls.shutdown++
      return 0
    },
    nvmlDeviceGetCount_v2: (out: any[]) => {
      out[0] = 1
      return 0
    },
    nvmlDeviceGetHandleByIndex_v2: (_i: number, out: any[]) => {
      out[0] = { dev: 0 }
      return 0
    },
    nvmlDeviceGetHandleByUUID: (_uuid: string, out: any[]) => {
      out[0] = { dev: 0 }
      return 0
    },
    nvmlDeviceGetUUID: (_d: any, buf: Buffer) => {
      buf.write('GPU-fake-0\0', 'latin1')
      return 0
    },
    nvmlDeviceGetUtilizationRates: (_d: any, u: any) => {
      u.gpu = 55
      return 0
    },
    nvmlDeviceGetMemoryInfo: (_d: any, m: any) => {
      m.total = 1000
      m.used = 250
      return 0
    },
    nvmlDeviceGetTemperature: (_d: any, _s: number, out: any[]) => {
      out[0] = 60
      return 0
    },
    nvmlDeviceGetPowerUsage: (_d: any, out: any[]) => {
      out[0] = 70000
      return 0
    }
  }
  const koffi = {
    load: (_name: string) => {
      calls.load++
      if (failLoads > 0) {
        failLoads--
        throw new Error('cannot open shared object file: No such file or directory')
      }
      return { func: (sym: string) => symbols[sym] }
    },
    opaque: () => ({ opaque: true }),
    pointer: (t: any) => ({ pointer: t }),
    out: (t: any) => ({ out: t }),
    struct: (name: string, _def: any) => {
      if (typeNames.has(name)) throw new Error(`Duplicate type name '${name}'`)
      typeNames.add(name)
      return { struct: name }
    }
  }
  return { koffi, calls }
}

// Injects the fake koffi and a steppable clock; everything else is the production collector.
class TestCollector extends NvmlGpuCollector {
  public clock = 1_000_000
  constructor(private readonly fake: any) {
    super()
  }

  protected override loadKoffi(): Promise<any> {
    return Promise.resolve(this.fake)
  }

  protected override now(): number {
    return this.clock
  }
}

describe('NvmlGpuCollector', () => {
  it('a second collector in the same process can still bind NVML (no duplicate koffi types)', async () => {
    const { koffi } = fakeKoffi()
    const first = new TestCollector(koffi)
    const second = new TestCollector(koffi)
    expect(await first.detect()).to.equal(true)
    // Before the fix this rebuilt the struct types and failed with "Duplicate type name".
    expect(await second.detect()).to.equal(true)
    expect(await second.sampleAll()).to.have.length(1)
  })

  it('re-binds after dispose(), as when addC2DEngines() rebuilds the engines on pushConfig', async () => {
    const { koffi, calls } = fakeKoffi()
    const collector = new TestCollector(koffi)
    expect(await collector.detect()).to.equal(true)
    collector.dispose()
    expect(calls.shutdown).to.equal(1)
    expect(await collector.detect()).to.equal(true)
    expect(calls.init).to.equal(2)
    const [device] = await collector.sampleAll()
    expect(device.utilizationPercent).to.equal(55)
    expect(device.memoryUsedBytes).to.equal(250)
    expect(device.uuid).to.equal('GPU-fake-0')
  })

  it('concurrent first detect() calls share one probe (parallel job/service sampling)', async () => {
    const { koffi, calls } = fakeKoffi()
    const collector = new TestCollector(koffi)
    // Before the fix the second concurrent caller rebuilt the types, hit "Duplicate type name"
    // and left the collector permanently disabled.
    const results = await Promise.all([
      collector.detect(),
      collector.detect(),
      collector.sampleAll()
    ])
    expect(results[0]).to.equal(true)
    expect(results[1]).to.equal(true)
    expect(results[2]).to.have.length(1)
    expect(calls.init).to.equal(1)
  })

  it('a concurrent failed probe counts once towards the backoff', async () => {
    const { koffi, calls } = fakeKoffi({ initRcs: [9, 0] })
    const collector = new TestCollector(koffi)
    expect(await Promise.all([collector.detect(), collector.detect()])).to.deep.equal([
      false,
      false
    ])
    expect(calls.init).to.equal(1)
    // one failure → the first (shortest) backoff applies
    collector.clock += NVML_RETRY_MIN_MS
    expect(await collector.detect()).to.equal(true)
  })

  it('does not re-probe before the retry backoff has elapsed', async () => {
    const { koffi, calls } = fakeKoffi({ initRcs: [9] })
    const collector = new TestCollector(koffi)
    expect(await collector.detect()).to.equal(false)
    collector.clock += NVML_RETRY_MIN_MS - 1
    expect(await collector.detect()).to.equal(false)
    expect(calls.init).to.equal(1)
  })

  it('retries a failed nvmlInit after the backoff and enables metrics once it succeeds', async () => {
    const { koffi, calls } = fakeKoffi({ initRcs: [9, 0] })
    const collector = new TestCollector(koffi)
    expect(await collector.detect()).to.equal(false)
    collector.clock += NVML_RETRY_MIN_MS
    expect(await collector.detect()).to.equal(true)
    expect(calls.init).to.equal(2)
    // success is cached: no further probes
    collector.clock += NVML_RETRY_MAX_MS * 10
    expect(await collector.detect()).to.equal(true)
    expect(calls.init).to.equal(2)
  })

  it('binds once the library becomes loadable (boot race), without duplicate types', async () => {
    const { koffi, calls } = fakeKoffi({ failLoads: 2 })
    const collector = new TestCollector(koffi)
    expect(await collector.detect()).to.equal(false)
    collector.clock += NVML_RETRY_MIN_MS
    expect(await collector.detect()).to.equal(false)
    collector.clock += NVML_RETRY_MIN_MS * 2
    expect(await collector.detect()).to.equal(true)
    expect(calls.load).to.equal(3)
  })

  it('doubles the backoff per consecutive failure, capped at the maximum', async () => {
    const { koffi, calls } = fakeKoffi({ initRcs: [9] })
    const collector = new TestCollector(koffi)
    let expectedDelay = NVML_RETRY_MIN_MS
    for (let i = 0; i < 8; i++) {
      expect(await collector.detect()).to.equal(false)
      expect(calls.init).to.equal(i + 1)
      // one ms short of the delay: still backing off
      collector.clock += expectedDelay - 1
      expect(await collector.detect()).to.equal(false)
      expect(calls.init).to.equal(i + 1)
      collector.clock += 1
      expectedDelay = Math.min(expectedDelay * 2, NVML_RETRY_MAX_MS)
    }
    expect(expectedDelay).to.equal(NVML_RETRY_MAX_MS)
  })
})
