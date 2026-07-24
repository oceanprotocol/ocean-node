import { expect } from 'chai'
import { resolveServiceImage } from '../../../components/c2d/serviceResourceMatching.js'

describe('resolveServiceImage', () => {
  it('image + tag → image:tag', () => {
    expect(resolveServiceImage('vllm/vllm-openai', 'latest')).to.equal(
      'vllm/vllm-openai:latest'
    )
  })
  it('image + checksum → image@sha256', () => {
    const c = 'sha256:' + 'a'.repeat(64)
    expect(resolveServiceImage('img', undefined, c)).to.equal(`img@${c}`)
  })
  it('image only → image:latest', () => {
    expect(resolveServiceImage('img')).to.equal('img:latest')
  })
  it('dockerfile → {serviceId}-svc-image:latest', () => {
    expect(
      resolveServiceImage('img', undefined, undefined, 'FROM x', 'SvcID123')
    ).to.equal('svcid123-svc-image:latest')
  })
})
