import { expect } from 'chai'
import * as tarStream from 'tar-stream'
import { isModelDownloadComplete } from '../../../components/c2d/modelDownload.js'
import {
  MANIFEST_PATH,
  parseDownloadManifest,
  sampleDownloadManifest
} from '../../../components/c2d/downloadManifest.js'

const MODELS = '/data/outputs/comfy/models'
const GEMMA = '/data/outputs/comfy/.cache/huggingface/hub/models--google--gemma-4-31B-it'

describe('parseDownloadManifest', () => {
  it('reads file and dir entries, treating an unknown size as null', () => {
    const text = [
      `file\t1000\t${MODELS}/vae/a.safetensors\thttps://huggingface.co/org/repo/resolve/main/a.safetensors`,
      `file\t0\t${MODELS}/loras/b.safetensors`,
      `dir\t5000\t${GEMMA}`,
      ''
    ].join('\n')
    expect(parseDownloadManifest(text)).to.deep.equal({
      entries: [
        { kind: 'file', path: `${MODELS}/vae/a.safetensors`, bytes: 1000 },
        { kind: 'file', path: `${MODELS}/loras/b.safetensors`, bytes: null },
        { kind: 'dir', path: GEMMA, bytes: 5000 }
      ],
      truncated: false
    })
  })

  it('drops malformed lines and repeated paths', () => {
    const text = [
      `blob\t1\t${MODELS}/a`,
      `file\t-1\t${MODELS}/a`,
      `file\tlots\t${MODELS}/a`,
      'file\t1\trelative/path',
      `file\t1\t${MODELS}/a\u0000b`,
      `file\t1\t${MODELS}/a`,
      `file\t2\t${MODELS}/a`,
      'file\t1'
    ].join('\n')
    expect(parseDownloadManifest(text).entries).to.deep.equal([
      { kind: 'file', path: `${MODELS}/a`, bytes: 1 }
    ])
  })

  it('caps the entries and flags a manifest that names more', () => {
    const line = (i: number) => `file\t1\t${MODELS}/f${i}`
    const capped = Array.from({ length: 64 }, (_, i) => line(i))
    expect(parseDownloadManifest(capped.join('\n')).truncated).to.equal(false)
    const over = parseDownloadManifest([...capped, line(64)].join('\n'))
    expect(over.entries).to.have.length(64)
    expect(over.truncated).to.equal(true)
  })
})

describe('sampleDownloadManifest', () => {
  // A container double: `getArchive()` serves the manifest as a tar, `infoArchive()` answers stats.
  function fakeContainer(manifest: string | null, files: Record<string, number>) {
    return {
      getArchive: ({ path }: { path: string }) => {
        if (manifest === null || path !== MANIFEST_PATH) {
          return Promise.reject(new Error('no such file'))
        }
        const pack = tarStream.pack()
        pack.entry({ name: 'downloads.tsv' }, manifest)
        pack.finalize()
        return Promise.resolve(pack)
      },
      infoArchive: ({ path }: { path: string }) => {
        if (files[path] === undefined) {
          return Promise.reject(new Error('not found'))
        }
        const header = Buffer.from(JSON.stringify({ size: files[path] })).toString(
          'base64'
        )
        return Promise.resolve({ headers: { 'x-docker-container-path-stat': header } })
      }
    } as any
  }

  const manifest = [
    `file\t1000\t${MODELS}/vae/a.safetensors`,
    `file\t2000\t${MODELS}/loras/b.safetensors`,
    `dir\t7000\t${GEMMA}`
  ].join('\n')

  it('measures files and folders against the sizes the script declared', async () => {
    const container = fakeContainer(manifest, {
      [`${MODELS}/vae/a.safetensors`]: 1000,
      [`${MODELS}/loras/b.safetensors.part`]: 500
    })
    const download = await sampleDownloadManifest(container, (path) =>
      Promise.resolve(path === GEMMA ? 3000 : null)
    )
    expect(download).to.include({
      downloadedBytes: 4500,
      totalBytes: 10000,
      percent: 45,
      filesComplete: 1,
      filesInFlight: 2,
      filesTotal: 3
    })
    expect(isModelDownloadComplete(download)).to.equal(false)
  })

  it('is complete once every file is in place and every folder holds its size', async () => {
    const container = fakeContainer(manifest, {
      [`${MODELS}/vae/a.safetensors`]: 1000,
      [`${MODELS}/loras/b.safetensors`]: 2000
    })
    // A reused cache can hold more than declared; it counts only up to the declared size.
    const download = await sampleDownloadManifest(container, () => Promise.resolve(9000))
    expect(download).to.include({
      downloadedBytes: 10000,
      percent: 100,
      filesComplete: 3
    })
    expect(isModelDownloadComplete(download)).to.equal(true)
  })

  it('reports no total when a size is unknown', async () => {
    const container = fakeContainer(`file\t0\t${MODELS}/vae/a.safetensors`, {})
    const download = await sampleDownloadManifest(container, () => Promise.resolve(null))
    expect(download?.totalBytes).to.equal(undefined)
    expect(download?.filesTotal).to.equal(1)
  })

  it('returns null when the script writes no manifest, or an empty one', async () => {
    const none = () => Promise.resolve(null)
    expect(await sampleDownloadManifest(fakeContainer(null, {}), none)).to.equal(null)
    expect(await sampleDownloadManifest(fakeContainer('', {}), none)).to.equal(null)
  })
})
