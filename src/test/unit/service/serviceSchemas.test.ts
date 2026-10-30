import { expect } from 'chai'
import {
  ServiceTemplateSchema,
  ServiceOnDemandConfigSchema,
  C2DEnvironmentConfigSchema
} from '../../../utils/config/schemas.js'
import {
  DEFAULT_SERVICE_MAX_DURATION_SECONDS,
  DEFAULT_SERVICE_MIN_DURATION_SECONDS
} from '../../../@types/C2D/ServiceOnDemand.js'
import { C2DEngine } from '../../../components/c2d/compute_engine_base.js'

const baseTemplate = {
  id: 'jupyter-cpu',
  image: 'quay.io/jupyter/datascience-notebook',
  exposedPorts: [8888]
}

describe('ServiceTemplateSchema', () => {
  it('image + tag → valid', () => {
    expect(
      ServiceTemplateSchema.safeParse({ ...baseTemplate, tag: 'latest' }).success
    ).to.equal(true)
  })
  it('image + checksum (sha256) → valid', () => {
    const checksum = 'sha256:' + 'a'.repeat(64)
    expect(
      ServiceTemplateSchema.safeParse({ ...baseTemplate, checksum }).success
    ).to.equal(true)
  })
  it('image + dockerfile → valid', () => {
    expect(
      ServiceTemplateSchema.safeParse({ ...baseTemplate, dockerfile: 'FROM x' }).success
    ).to.equal(true)
  })
  it('tag + dockerfile together → invalid', () => {
    expect(
      ServiceTemplateSchema.safeParse({ ...baseTemplate, tag: 'l', dockerfile: 'FROM x' })
        .success
    ).to.equal(false)
  })
  it('additionalDockerFiles without dockerfile → invalid', () => {
    expect(
      ServiceTemplateSchema.safeParse({
        ...baseTemplate,
        tag: 'l',
        additionalDockerFiles: { 'a.txt': 'x' }
      }).success
    ).to.equal(false)
  })
  it('no tag/checksum/dockerfile → valid (defaults to image:latest at runtime)', () => {
    expect(ServiceTemplateSchema.safeParse(baseTemplate).success).to.equal(true)
  })
  it('bad id → invalid', () => {
    expect(
      ServiceTemplateSchema.safeParse({ ...baseTemplate, id: 'Bad Id!' }).success
    ).to.equal(false)
  })
  describe('recommendedResources', () => {
    const cpu = { id: 'cpu', recommended: 4, unit: 'cores' }
    const ram = { id: 'ram', recommended: 16, unit: 'GB' }
    const disk = { id: 'disk', recommended: 100, unit: 'GB' }
    const gpuSingle = {
      kind: 'discrete',
      type: 'gpu',
      recommended: 48,
      unit: 'GB',
      layouts: [{ gpuCount: 1 }]
    }
    const gpuMulti = {
      kind: 'discrete',
      type: 'gpu',
      recommended: 564,
      unit: 'GB',
      layouts: [
        { gpuCount: 2, vramPerGpu: 282 },
        { gpuCount: 4, vramPerGpu: 141 },
        { gpuCount: 8, vramPerGpu: 141 }
      ],
      description: 'two, four or eight H200-class cards'
    }
    const parse = (recommendedResources: unknown, extra: object = {}) =>
      ServiceTemplateSchema.safeParse({ ...baseTemplate, ...extra, recommendedResources })
    const tpEnv = (validation?: string) => ({
      userConfigurableEnvVars: [{ key: 'QWEN_TP_SIZE', validation }]
    })

    it('valid cpu / ram / disk + single-GPU layout → valid', () => {
      expect(parse([cpu, ram, disk, gpuSingle]).success).to.equal(true)
    })
    it('valid multi-layout GPU (2x282 / 4x141 / 8x141) → valid', () => {
      expect(parse([cpu, gpuMulti]).success).to.equal(true)
    })
    it('mixed single + multi layout ({1}, {2,80}) → valid', () => {
      expect(
        parse([
          {
            ...gpuSingle,
            recommended: 141,
            layouts: [{ gpuCount: 1 }, { gpuCount: 2, vramPerGpu: 80 }]
          }
        ]).success
      ).to.equal(true)
    })
    it('recommended 0 for cpu/ram/disk → valid; negative → invalid', () => {
      expect(parse([{ ...cpu, recommended: 0 }]).success).to.equal(true)
      expect(parse([{ ...ram, recommended: -1 }]).success).to.equal(false)
    })
    it('retired `min` key → invalid', () => {
      expect(parse([{ ...cpu, min: 2 }]).success).to.equal(false)
      expect(parse([{ ...gpuSingle, min: 1 }]).success).to.equal(false)
    })
    it('retired requiredResources key → invalid', () => {
      expect(
        ServiceTemplateSchema.safeParse({
          ...baseTemplate,
          requiredResources: [{ id: 'cpu', min: 1 }]
        }).success
      ).to.equal(false)
      expect(
        ServiceTemplateSchema.safeParse({ ...baseTemplate, requiredResources: [cpu] })
          .success
      ).to.equal(false)
    })
    it('GPU in device count (old shape: unit "count", no layouts) → invalid', () => {
      expect(
        parse([{ kind: 'discrete', type: 'gpu', recommended: 2, unit: 'count' }]).success
      ).to.equal(false)
      expect(parse([{ ...gpuSingle, unit: 'count' }]).success).to.equal(false)
    })
    it('wrong unit for cpu / ram → invalid', () => {
      expect(parse([{ ...cpu, unit: 'GB' }]).success).to.equal(false)
      expect(parse([{ ...ram, unit: 'GiB' }]).success).to.equal(false)
    })
    it('GPU addressed by id instead of kind/type → invalid', () => {
      expect(parse([{ ...gpuSingle, id: 'gpu' }]).success).to.equal(false)
      expect(parse([{ id: 'gpu', recommended: 48, unit: 'GB' }]).success).to.equal(false)
    })
    it('missing or empty layouts → invalid', () => {
      const { layouts, ...noLayouts } = gpuSingle
      expect(layouts).to.have.length(1)
      expect(parse([noLayouts]).success).to.equal(false)
      expect(parse([{ ...gpuSingle, layouts: [] }]).success).to.equal(false)
    })
    it('more than 8 layouts → invalid', () => {
      const layouts = Array.from({ length: 9 }, (_, i) =>
        i === 0 ? { gpuCount: 1 } : { gpuCount: i + 1, vramPerGpu: 48 }
      )
      expect(parse([{ ...gpuSingle, layouts }]).success).to.equal(false)
    })
    it('gpuCount not an integer in 1..64 → invalid', () => {
      for (const gpuCount of [0, 1.5, 65]) {
        expect(
          parse([{ ...gpuSingle, layouts: [{ gpuCount, vramPerGpu: 48 }] }]).success,
          `gpuCount=${gpuCount}`
        ).to.equal(false)
      }
    })
    it('unknown key inside a layout → invalid', () => {
      expect(
        parse([{ ...gpuSingle, layouts: [{ gpuCount: 1, tp: 1 }] }]).success
      ).to.equal(false)
    })
    it('vramPerGpu on a one-GPU layout → invalid', () => {
      expect(
        parse([{ ...gpuSingle, layouts: [{ gpuCount: 1, vramPerGpu: 48 }] }]).success
      ).to.equal(false)
    })
    it('missing vramPerGpu on a multi-GPU layout → invalid', () => {
      expect(
        parse([
          { ...gpuMulti, layouts: [{ gpuCount: 2 }, { gpuCount: 4, vramPerGpu: 141 }] }
        ]).success
      ).to.equal(false)
    })
    it('non-positive / non-finite recommended or vramPerGpu → invalid', () => {
      expect(parse([{ ...gpuSingle, recommended: 0 }]).success).to.equal(false)
      expect(parse([{ ...gpuSingle, recommended: Infinity }]).success).to.equal(false)
      expect(
        parse([{ ...gpuMulti, layouts: [{ gpuCount: 4, vramPerGpu: 0 }] }]).success
      ).to.equal(false)
    })
    it('layouts not strictly ascending by gpuCount → invalid', () => {
      expect(
        parse([
          {
            ...gpuMulti,
            layouts: [
              { gpuCount: 4, vramPerGpu: 141 },
              { gpuCount: 2, vramPerGpu: 282 }
            ]
          }
        ]).success
      ).to.equal(false)
      expect(
        parse([
          {
            ...gpuMulti,
            layouts: [
              { gpuCount: 4, vramPerGpu: 141 },
              { gpuCount: 4, vramPerGpu: 160 }
            ]
          }
        ]).success
      ).to.equal(false)
    })
    it('layout total below recommended → invalid', () => {
      // 4 x 80 = 320 < 564
      expect(
        parse([{ ...gpuMulti, layouts: [{ gpuCount: 4, vramPerGpu: 80 }] }]).success
      ).to.equal(false)
    })
    it('duplicate resource entries → invalid', () => {
      expect(parse([cpu, { ...cpu, recommended: 8 }]).success).to.equal(false)
      expect(parse([ram, disk, ram]).success).to.equal(false)
      expect(parse([gpuSingle, gpuMulti]).success).to.equal(false)
    })

    it('gpuCountEnv referencing a declared userConfigurableEnvVars key → valid', () => {
      expect(
        parse([{ ...gpuMulti, gpuCountEnv: 'QWEN_TP_SIZE' }], tpEnv('^(2|4|8)$')).success
      ).to.equal(true)
      // no validation regex on the key → nothing to check the widths against
      expect(
        parse([{ ...gpuMulti, gpuCountEnv: 'QWEN_TP_SIZE' }], tpEnv()).success
      ).to.equal(true)
    })
    it('gpuCountEnv naming an undeclared key → invalid', () => {
      expect(parse([{ ...gpuMulti, gpuCountEnv: 'QWEN_TP_SIZE' }]).success).to.equal(
        false
      )
      expect(
        parse([{ ...gpuMulti, gpuCountEnv: 'OTHER_KEY' }], tpEnv('^(2|4|8)$')).success
      ).to.equal(false)
    })
    it('gpuCountEnv that is not an env var name → invalid', () => {
      expect(
        parse([{ ...gpuMulti, gpuCountEnv: '1BAD-KEY' }], {
          userConfigurableEnvVars: [{ key: '1BAD-KEY' }]
        }).success
      ).to.equal(false)
    })
    it("a layout width rejected by the key's validation regex → invalid", () => {
      const result = parse(
        [
          {
            ...gpuMulti,
            gpuCountEnv: 'QWEN_TP_SIZE',
            layouts: [...gpuMulti.layouts, { gpuCount: 16, vramPerGpu: 80 }]
          }
        ],
        tpEnv('^(2|4|8)$')
      )
      expect(result.success).to.equal(false)
      expect(result.error.issues.map((i) => i.message).join(' ')).to.contain(
        'gpuCount 16'
      )
    })
    it('gpuCountEnv that is also an operator-fixed envVars key → invalid', () => {
      expect(
        parse([{ ...gpuMulti, gpuCountEnv: 'QWEN_TP_SIZE' }], {
          ...tpEnv('^(2|4|8)$'),
          envVars: { QWEN_TP_SIZE: '4' }
        }).success
      ).to.equal(false)
    })
    it('gpuCountEnv named like an Object.prototype member is not mistaken for an envVars key', () => {
      expect(
        parse([{ ...gpuMulti, gpuCountEnv: 'constructor' }], {
          userConfigurableEnvVars: [{ key: 'constructor', validation: '^(2|4|8)$' }],
          envVars: { OTHER: 'x' }
        }).success
      ).to.equal(true)
    })
    it('duplicate userConfigurableEnvVars keys → invalid (both orders), closing the gpuCountEnv regex bypass', () => {
      // Two declarations of the same key: gpuCountEnv resolves it with .find(), so only the
      // first regex was ever checked against the layouts and a second, contradictory regex
      // (^8$, which rejects the 2 and 4 layouts) used to slip through.
      const dupLax = parse([{ ...gpuMulti, gpuCountEnv: 'QWEN_TP_SIZE' }], {
        userConfigurableEnvVars: [
          { key: 'QWEN_TP_SIZE', validation: '^(2|4|8)$' },
          { key: 'QWEN_TP_SIZE', validation: '^8$' }
        ]
      })
      expect(dupLax.success).to.equal(false)
      expect(dupLax.error.issues.map((i) => i.message).join(' ')).to.contain(
        'declared more than once'
      )
      // Reverse declaration order is just as invalid.
      expect(
        parse([{ ...gpuMulti, gpuCountEnv: 'QWEN_TP_SIZE' }], {
          userConfigurableEnvVars: [
            { key: 'QWEN_TP_SIZE', validation: '^8$' },
            { key: 'QWEN_TP_SIZE', validation: '^(2|4|8)$' }
          ]
        }).success
      ).to.equal(false)
      // Duplicates are rejected even without a gpuCountEnv link.
      expect(
        parse([cpu, gpuMulti], {
          userConfigurableEnvVars: [{ key: 'DUP' }, { key: 'DUP' }]
        }).success
      ).to.equal(false)
    })
  })
  it('a ComfyUI-shaped bundle (parent, commandFile, workflows) matches ServiceTemplateSchema', () => {
    const bundle = {
      id: 'ltx-video-ugc-product',
      name: 'LTX product video',
      description: 'ComfyUI with an LTX product-video graph.',
      kind: 'bundle',
      service: 'comfyui',
      outcome: 'A short product video from one product photo.',
      category: 'video',
      includes: [
        { name: 'LTX-Video 2B', kind: 'model', repoId: 'Lightricks/LTX-Video' },
        { name: 'ocean_ugc_product', kind: 'workflow' }
      ],
      image: 'yanwk/comfyui-boot',
      tag: 'latest',
      exposedPorts: [8188],
      commandFile: 'bootstrap.sh',
      userConfigurableEnvVars: [
        {
          key: 'HF_TOKEN',
          required: true,
          sensitive: true,
          validation: '^hf_[A-Za-z0-9]+$'
        }
      ],
      recommendedResources: [
        {
          kind: 'discrete',
          type: 'gpu',
          recommended: 48,
          unit: 'GB',
          layouts: [{ gpuCount: 1 }]
        }
      ],
      workflows: [
        {
          id: 'ocean_ugc_product',
          name: 'Product video',
          file: 'workflows/ocean_ugc_product.json'
        }
      ]
    }
    expect(ServiceTemplateSchema.safeParse(bundle).success).to.equal(true)
  })

  it('unlisted must be a boolean', () => {
    expect(
      ServiceTemplateSchema.safeParse({ ...baseTemplate, unlisted: true }).success
    ).to.equal(true)
    expect(
      ServiceTemplateSchema.safeParse({ ...baseTemplate, unlisted: 'yes' }).success
    ).to.equal(false)
  })

  it('a bundle without its parent service id is rejected', () => {
    const orphan = {
      id: 'orphan-bundle',
      kind: 'bundle',
      image: 'yanwk/comfyui-boot',
      tag: 'latest',
      exposedPorts: [8188]
    }
    expect(ServiceTemplateSchema.safeParse(orphan).success).to.equal(false)
  })
})

describe('ServiceOnDemandConfigSchema', () => {
  it('applies defaults', () => {
    const parsed = ServiceOnDemandConfigSchema.parse({
      enabled: true,
      nodeHost: 'localhost'
    })
    expect(parsed.maxDurationSeconds).to.equal(86400)
    expect(parsed.allowImageBuild).to.equal(false)
  })
  it('minDurationSeconds defaults to no daemon floor', () => {
    const parsed = ServiceOnDemandConfigSchema.parse({
      enabled: true,
      nodeHost: 'localhost'
    })
    expect(parsed.minDurationSeconds).to.equal(DEFAULT_SERVICE_MIN_DURATION_SECONDS)
    expect(parsed.minDurationSeconds).to.equal(0)
  })
  it('default is the shared constant, not an independent literal', () => {
    // The schema default, the SERVICE_START / SERVICE_EXTEND fallback and the
    // maxServiceDuration every env advertises all read this one constant. Pinning it here
    // means a change to it can never leave the advertised cap disagreeing with the
    // enforced one.
    const parsed = ServiceOnDemandConfigSchema.parse({
      enabled: true,
      nodeHost: 'localhost'
    })
    expect(parsed.maxDurationSeconds).to.equal(DEFAULT_SERVICE_MAX_DURATION_SECONDS)
  })
  it('requires nodeHost', () => {
    expect(ServiceOnDemandConfigSchema.safeParse({ enabled: true }).success).to.equal(
      false
    )
  })
  it('rejects unknown keys (strict)', () => {
    expect(
      ServiceOnDemandConfigSchema.safeParse({
        enabled: true,
        nodeHost: 'localhost',
        bogus: 1
      }).success
    ).to.equal(false)
  })
})

describe('C2DEnvironmentConfigSchema maxServiceDuration', () => {
  const baseEnv = {
    fees: { '1': [{ feeToken: '0xabc', prices: [{ id: 'cpu', price: 1 }] }] }
  }

  it('absent → undefined, so the env inherits the daemon cap at engine start', () => {
    const parsed = C2DEnvironmentConfigSchema.parse({ ...baseEnv })
    expect(parsed.maxServiceDuration).to.equal(undefined)
  })
  it('accepts a positive integer', () => {
    const parsed = C2DEnvironmentConfigSchema.parse({
      ...baseEnv,
      maxServiceDuration: 600
    })
    expect(parsed.maxServiceDuration).to.equal(600)
  })
  it('rejects zero and negatives', () => {
    for (const bad of [0, -1]) {
      expect(
        C2DEnvironmentConfigSchema.safeParse({ ...baseEnv, maxServiceDuration: bad })
          .success,
        `maxServiceDuration=${bad}`
      ).to.equal(false)
    }
  })
})

describe('C2DEnvironmentConfigSchema minServiceDuration', () => {
  const baseEnv = {
    fees: { '1': [{ feeToken: '0xabc', prices: [{ id: 'cpu', price: 1 }] }] }
  }

  it('absent → undefined, so the env falls back to its minJobDuration', () => {
    const parsed = C2DEnvironmentConfigSchema.parse({ ...baseEnv })
    expect(parsed.minServiceDuration).to.equal(undefined)
  })
  it('accepts 0 — an env may explicitly opt out of any floor', () => {
    const parsed = C2DEnvironmentConfigSchema.parse({ ...baseEnv, minServiceDuration: 0 })
    expect(parsed.minServiceDuration).to.equal(0)
  })
  it('rejects negatives', () => {
    expect(
      C2DEnvironmentConfigSchema.safeParse({ ...baseEnv, minServiceDuration: -1 }).success
    ).to.equal(false)
  })
})

describe('C2DEngine.getMinServiceDuration', () => {
  const engineWith = (connection: any): C2DEngine => {
    const engine: any = Object.create(C2DEngine.prototype)
    engine.clusterConfig = { hash: 'hash-1', connection }
    return engine
  }

  it("returns the daemon's configured floor", () => {
    expect(
      engineWith({ serviceOnDemand: { minDurationSeconds: 600 } }).getMinServiceDuration()
    ).to.equal(600)
  })
  it('falls back to no floor when the daemon does not set one', () => {
    expect(
      engineWith({ serviceOnDemand: { enabled: true } }).getMinServiceDuration()
    ).to.equal(DEFAULT_SERVICE_MIN_DURATION_SECONDS)
    expect(engineWith({}).getMinServiceDuration()).to.equal(
      DEFAULT_SERVICE_MIN_DURATION_SECONDS
    )
    expect(engineWith(undefined).getMinServiceDuration()).to.equal(
      DEFAULT_SERVICE_MIN_DURATION_SECONDS
    )
  })
})

describe('C2DEngine.getMaxServiceDuration', () => {
  // Object.create skips the abstract class's constructor (which wants a db, escrow and key
  // manager) — the getter only ever reads clusterConfig.
  const engineWith = (connection: any): C2DEngine => {
    const engine: any = Object.create(C2DEngine.prototype)
    engine.clusterConfig = { hash: 'hash-1', connection }
    return engine
  }

  it("returns the daemon's configured cap", () => {
    const engine = engineWith({ serviceOnDemand: { maxDurationSeconds: 7200 } })
    expect(engine.getMaxServiceDuration()).to.equal(7200)
  })
  it('falls back to the shared default when serviceOnDemand omits maxDurationSeconds', () => {
    const engine = engineWith({ serviceOnDemand: { enabled: true } })
    expect(engine.getMaxServiceDuration()).to.equal(DEFAULT_SERVICE_MAX_DURATION_SECONDS)
  })
  it('falls back to the shared default when there is no serviceOnDemand block at all', () => {
    expect(engineWith({}).getMaxServiceDuration()).to.equal(
      DEFAULT_SERVICE_MAX_DURATION_SECONDS
    )
    expect(engineWith(undefined).getMaxServiceDuration()).to.equal(
      DEFAULT_SERVICE_MAX_DURATION_SECONDS
    )
  })
})

describe('C2DEnvironmentConfigSchema features', () => {
  const base: any = {
    fees: { '8996': [{ feeToken: '0x0', prices: [] as any[] }] },
    storageExpiry: 604800,
    maxJobDuration: 3600
  }
  it('no features block → both default true', () => {
    const parsed: any = C2DEnvironmentConfigSchema.parse(base)
    expect(parsed.features).to.deep.equal({ computeJobs: true, services: true })
  })
  it('partial features { computeJobs:false } → services defaults true', () => {
    const parsed: any = C2DEnvironmentConfigSchema.parse({
      ...base,
      features: { computeJobs: false }
    })
    expect(parsed.features).to.deep.equal({ computeJobs: false, services: true })
  })
  it('unknown feature key → invalid (strict)', () => {
    expect(
      C2DEnvironmentConfigSchema.safeParse({ ...base, features: { compute: true } })
        .success
    ).to.equal(false)
  })
})
