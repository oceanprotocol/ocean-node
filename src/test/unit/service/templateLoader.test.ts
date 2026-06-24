import { expect } from 'chai'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { loadServiceTemplates } from '../../../components/core/service/templateLoader.js'

const valid = (id: string) => ({
  id,
  image: 'quay.io/jupyter/datascience-notebook',
  tag: 'latest',
  exposedPorts: [8888]
})

describe('loadServiceTemplates', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'svc-templates-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('1. undefined dir → []', async () => {
    expect(await loadServiceTemplates(undefined)).to.deep.equal([])
  })

  it('2. non-existent dir → [] (quiet)', async () => {
    expect(await loadServiceTemplates(join(dir, 'does-not-exist'))).to.deep.equal([])
  })

  it('3. two valid single-template files → both returned', async () => {
    writeFileSync(join(dir, 'a.json'), JSON.stringify(valid('jupyter-cpu')))
    writeFileSync(join(dir, 'b.json'), JSON.stringify(valid('jupyter-gpu')))
    const templates = await loadServiceTemplates(dir)
    expect(templates.map((t) => t.id).sort()).to.deep.equal([
      'jupyter-cpu',
      'jupyter-gpu'
    ])
  })

  it('4. file containing an array of templates → all returned', async () => {
    writeFileSync(join(dir, 'multi.json'), JSON.stringify([valid('one'), valid('two')]))
    const templates = await loadServiceTemplates(dir)
    expect(templates.map((t) => t.id).sort()).to.deep.equal(['one', 'two'])
  })

  it('5. malformed JSON skipped; others still load', async () => {
    writeFileSync(join(dir, 'bad.json'), '{ not json')
    writeFileSync(join(dir, 'good.json'), JSON.stringify(valid('good')))
    const templates = await loadServiceTemplates(dir)
    expect(templates.map((t) => t.id)).to.deep.equal(['good'])
  })

  it('6. schema-invalid template skipped (tag + dockerfile together)', async () => {
    writeFileSync(
      join(dir, 'invalid.json'),
      JSON.stringify({ ...valid('inv'), dockerfile: 'FROM x' })
    )
    writeFileSync(join(dir, 'ok.json'), JSON.stringify(valid('ok')))
    const templates = await loadServiceTemplates(dir)
    expect(templates.map((t) => t.id)).to.deep.equal(['ok'])
  })

  it('7. duplicate id → first (filename-sorted) wins', async () => {
    writeFileSync(join(dir, 'a.json'), JSON.stringify({ ...valid('dup'), tag: 'first' }))
    writeFileSync(join(dir, 'b.json'), JSON.stringify({ ...valid('dup'), tag: 'second' }))
    const templates = await loadServiceTemplates(dir)
    expect(templates).to.have.length(1)
    expect(templates[0].tag).to.equal('first')
  })

  it('8. non-.json files ignored', async () => {
    writeFileSync(join(dir, 'readme.txt'), 'hello')
    writeFileSync(join(dir, 'good.json'), JSON.stringify(valid('good')))
    const templates = await loadServiceTemplates(dir)
    expect(templates.map((t) => t.id)).to.deep.equal(['good'])
  })

  it('9. re-read picks up newly added files (no caching)', async () => {
    writeFileSync(join(dir, 'a.json'), JSON.stringify(valid('a')))
    expect(await loadServiceTemplates(dir)).to.have.length(1)
    writeFileSync(join(dir, 'b.json'), JSON.stringify(valid('b')))
    expect(await loadServiceTemplates(dir)).to.have.length(2)
  })
})
