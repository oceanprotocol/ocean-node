import { expect } from 'chai'
import {
  ServiceTemplateSchema,
  ServiceOnDemandConfigSchema,
  C2DEnvironmentConfigSchema
} from '../../../utils/config/schemas.js'

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
  it('requiredResources: neither id nor kind → invalid', () => {
    expect(
      ServiceTemplateSchema.safeParse({
        ...baseTemplate,
        requiredResources: [{ min: 1 }]
      }).success
    ).to.equal(false)
  })
  it('requiredResources: both id and kind → invalid', () => {
    expect(
      ServiceTemplateSchema.safeParse({
        ...baseTemplate,
        requiredResources: [{ id: 'cpu', kind: 'fungible', min: 1 }]
      }).success
    ).to.equal(false)
  })
  it('recommended < min → invalid', () => {
    expect(
      ServiceTemplateSchema.safeParse({
        ...baseTemplate,
        requiredResources: [{ id: 'cpu', min: 4, recommended: 2 }]
      }).success
    ).to.equal(false)
  })
  it('valid required + recommended resources → valid', () => {
    expect(
      ServiceTemplateSchema.safeParse({
        ...baseTemplate,
        requiredResources: [{ id: 'cpu', min: 2, recommended: 4 }],
        recommendedResources: [{ kind: 'discrete', type: 'gpu', min: 1, recommended: 2 }]
      }).success
    ).to.equal(true)
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
      requiredResources: [{ kind: 'discrete', type: 'gpu', min: 1, recommended: 1 }],
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
