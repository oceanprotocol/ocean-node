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
