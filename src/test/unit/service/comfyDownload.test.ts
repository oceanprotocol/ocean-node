import { expect } from 'chai'
import * as tarStream from 'tar-stream'
import type { ServiceJob } from '../../../@types/C2D/ServiceOnDemand.js'
import { resolveServiceEngine } from '../../../components/c2d/serviceEngines.js'
import { isModelDownloadComplete } from '../../../components/c2d/modelDownload.js'
import {
  parseComfyModelList,
  sampleComfyModelDownload
} from '../../../components/c2d/comfyDownload.js'

const HF = 'https://huggingface.co'

describe('ComfyUI engine profile', () => {
  const job = (image: string) => ({ image, exposedPorts: [8188] }) as ServiceJob

  it('recognizes the comfyui-boot image under any tag', () => {
    expect(resolveServiceEngine(job('yanwk/comfyui-boot'))?.id).to.equal('comfyui')
    expect(
      resolveServiceEngine(job('yanwk/comfyui-boot:cu130-megapak-pt211'))?.id
    ).to.equal('comfyui')
    expect(resolveServiceEngine(job('someone/comfyui-boot'))).to.equal(null)
  })
})

describe('parseComfyModelList', () => {
  it('keeps plain Hugging Face file URLs and derives the script destination', () => {
    const text = [
      `vae\t${HF}/org/repo/resolve/main/split_files/vae/a.safetensors`,
      `loras\t${HF}/org/repo/resolve/main/b.safetensors`,
      `loras\t${HF}/org/repo/resolve/main/b.safetensors`,
      ''
    ].join('\n')
    expect(parseComfyModelList(text, '/tmp/comfy')).to.deep.equal({
      entries: [
        {
          url: `${HF}/org/repo/resolve/main/split_files/vae/a.safetensors`,
          path: '/tmp/comfy/models/vae/a.safetensors'
        },
        {
          url: `${HF}/org/repo/resolve/main/b.safetensors`,
          path: '/tmp/comfy/models/loras/b.safetensors'
        }
      ],
      truncated: false
    })
  })

  it('caps the list and flags one that names more files than the cap', () => {
    const line = (i: number) => `vae\t${HF}/org/repo/resolve/main/f${i}.safetensors`
    const capped = Array.from({ length: 64 }, (_, i) => line(i))
    const exact = parseComfyModelList([...capped, line(0)].join('\n'), '/tmp/comfy')
    expect(exact.entries).to.have.length(64)
    expect(exact.truncated).to.equal(false)

    const over = parseComfyModelList([...capped, line(64)].join('\n'), '/tmp/comfy')
    expect(over.entries).to.have.length(64)
    expect(over.truncated).to.equal(true)
  })

  it('drops anything that is not a plain Hugging Face file URL or a safe directory', () => {
    const text = [
      `../etc\t${HF}/org/repo/resolve/main/a.safetensors`,
      `vae\thttps://example.com/org/repo/resolve/main/a.safetensors`,
      `vae\t${HF}/org/repo/resolve/main/a.safetensors?download=true`,
      `vae\t${HF}:8443/org/repo/resolve/main/a.safetensors`,
      `vae\t${HF}/org/repo/resolve/main/../a.safetensors`,
      `vae\t${HF}/org/repo/blob/main/a.safetensors`,
      `vae\t${HF}/org/repo/resolve/main/a.bin`,
      'vae'
    ].join('\n')
    expect(parseComfyModelList(text, '/tmp/comfy').entries).to.deep.equal([])
  })
})

describe('sampleComfyModelDownload', () => {
  const realFetch = globalThis.fetch
  const startedAt = Date.parse('2026-10-07T10:00:00Z')

  afterEach(() => {
    globalThis.fetch = realFetch
  })

  // A container double: `getArchive()` returns the list as a tar, `infoArchive()` answers stats.
  function fakeContainer(list: string, mtime: Date, files: Record<string, number>) {
    return {
      getArchive: () => {
        const pack = tarStream.pack()
        pack.entry({ name: '.models.tsv', mtime }, list)
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

  function hubSizes(sizes: Record<string, number>) {
    globalThis.fetch = ((url: string) =>
      Promise.resolve(
        new Response(null, {
          status: 302,
          headers: { 'x-linked-size': String(sizes[url]) }
        })
      )) as typeof fetch
  }

  it('measures finished and partial files against the listed total', async () => {
    const a = `${HF}/sample-test/repo/resolve/main/a.safetensors`
    const b = `${HF}/sample-test/repo/resolve/main/b.safetensors`
    const c = `${HF}/sample-test/repo/resolve/main/c.safetensors`
    hubSizes({ [a]: 1000, [b]: 2000, [c]: 1000 })
    const container = fakeContainer(
      `vae\t${a}\nloras\t${b}\nloras\t${c}\n`,
      new Date(startedAt + 5000),
      {
        '/data/outputs/comfy/models/vae/a.safetensors': 1000,
        '/data/outputs/comfy/models/loras/b.safetensors.part': 500
      }
    )
    const download = await sampleComfyModelDownload(container, true, startedAt)
    expect(download).to.include({
      downloadedBytes: 1500,
      totalBytes: 4000,
      percent: 38,
      filesComplete: 1,
      filesInFlight: 1,
      filesTotal: 3
    })
    expect(isModelDownloadComplete(download)).to.equal(false)
  })

  it('is complete once every listed file is finished', async () => {
    const a = `${HF}/complete-test/repo/resolve/main/a.safetensors`
    hubSizes({ [a]: 1000 })
    const container = fakeContainer(`vae\t${a}\n`, new Date(startedAt), {
      '/tmp/comfy/models/vae/a.safetensors': 1000
    })
    const download = await sampleComfyModelDownload(container, false, startedAt)
    expect(isModelDownloadComplete(download)).to.equal(true)
  })

  it('ignores a list left in the bucket by an earlier launch', async () => {
    const a = `${HF}/stale-test/repo/resolve/main/a.safetensors`
    const container = fakeContainer(`vae\t${a}\n`, new Date(startedAt - 60_000), {})
    expect(await sampleComfyModelDownload(container, true, startedAt)).to.equal(null)
  })

  it('reports no total when a size is unknown, and nothing when there is no list', async () => {
    const a = `${HF}/unknown-test/repo/resolve/main/a.safetensors`
    globalThis.fetch = (() =>
      Promise.resolve(new Response(null, { status: 401 }))) as typeof fetch
    const container = fakeContainer(`vae\t${a}\n`, new Date(startedAt), {})
    const download = await sampleComfyModelDownload(container, false, startedAt)
    expect(download?.totalBytes).to.equal(undefined)
    expect(download?.filesTotal).to.equal(1)

    const empty = { getArchive: () => Promise.reject(new Error('no such file')) } as any
    expect(await sampleComfyModelDownload(empty, false, startedAt)).to.equal(null)
  })

  it('reports bytes only for a list longer than the cap, so it never completes early', async () => {
    const url = (i: number) => `${HF}/overflow-test/repo/resolve/main/f${i}.safetensors`
    const list = Array.from({ length: 65 }, (_, i) => `vae\t${url(i)}`).join('\n')
    const files = Object.fromEntries(
      Array.from({ length: 64 }, (_, i) => [
        `/tmp/comfy/models/vae/f${i}.safetensors`,
        10
      ])
    )
    let lookups = 0
    globalThis.fetch = (() => {
      lookups++
      return Promise.resolve(new Response(null, { status: 302 }))
    }) as typeof fetch
    const container = fakeContainer(list, new Date(startedAt), files)
    const download = await sampleComfyModelDownload(container, false, startedAt)
    expect(download).to.include({ downloadedBytes: 640, filesComplete: 64 })
    expect(download?.filesTotal).to.equal(undefined)
    expect(download?.totalBytes).to.equal(undefined)
    expect(isModelDownloadComplete(download)).to.equal(false)
    expect(lookups).to.equal(0)
  })
})
