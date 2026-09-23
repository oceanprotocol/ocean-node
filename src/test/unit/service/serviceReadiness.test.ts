import { expect } from 'chai'
import { createServer, Server } from 'http'
import type { AddressInfo } from 'net'
import type {
  ServiceImagePullProgress,
  ServiceJob
} from '../../../@types/C2D/ServiceOnDemand.js'
import {
  ImagePullTracker,
  probeCandidates,
  runReadinessProbe
} from '../../../components/c2d/serviceReadiness.js'
import { resolveServiceEngine } from '../../../components/c2d/serviceEngines.js'
import {
  buildModelDownload,
  fetchModelTotalBytes,
  BLOB_EMPTY_REDISCOVER_MS,
  BLOB_REDISCOVER_MS,
  isModelDownloadComplete,
  ModelDownloadSampler,
  readModelDownloadBytes,
  selectBlobPaths
} from '../../../components/c2d/modelDownload.js'

describe('ImagePullTracker', () => {
  // The daemon's real event sequence for one layer, minus the narration lines.
  function pull(tracker: ImagePullTracker, id: string, bytes: number) {
    tracker.onEvent({ id, status: 'Pulling fs layer', progressDetail: {} })
    tracker.onEvent({
      id,
      status: 'Downloading',
      progressDetail: { current: bytes / 2, total: bytes }
    })
    tracker.onEvent({
      id,
      status: 'Downloading',
      progressDetail: { current: bytes, total: bytes }
    })
    tracker.onEvent({ id, status: 'Download complete', progressDetail: {} })
    tracker.onEvent({ id, status: 'Pull complete', progressDetail: {} })
  }

  it('aggregates layer bytes and reports 100% on finish', () => {
    const emitted: ServiceImagePullProgress[] = []
    const tracker = new ImagePullTracker((p) => emitted.push(p))
    pull(tracker, 'layer-a', 1000)
    pull(tracker, 'layer-b', 3000)
    tracker.finish()

    const last = emitted[emitted.length - 1]
    expect(last.phase).to.equal('complete')
    expect(last.percent).to.equal(100)
    expect(last.downloadedBytes).to.equal(4000)
    expect(last.totalBytes).to.equal(4000)
    expect(last.layersTotal).to.equal(2)
    expect(last.layersDone).to.equal(2)
  })

  it('never walks the percentage backwards when a later layer announces its size', () => {
    const emitted: ServiceImagePullProgress[] = []
    const tracker = new ImagePullTracker((p) => emitted.push(p))
    // First layer completes (100% of everything known so far)...
    tracker.onEvent({
      id: 'a',
      status: 'Downloading',
      progressDetail: { current: 100, total: 100 }
    })
    tracker.onEvent({ id: 'a', status: 'Pull complete', progressDetail: {} })
    // ...then a much bigger second layer appears, which would drop a naive ratio to 10%.
    tracker.onEvent({
      id: 'b',
      status: 'Downloading',
      progressDetail: { current: 0, total: 900 }
    })
    tracker.finish()

    const percents = emitted.map((e) => e.percent)
    for (let i = 1; i < percents.length; i++) {
      expect(percents[i]).to.be.at.least(percents[i - 1])
    }
  })

  it('reports a fully cached image as complete rather than stuck at 0%', () => {
    const emitted: ServiceImagePullProgress[] = []
    const tracker = new ImagePullTracker((p) => emitted.push(p))
    tracker.onEvent({ id: 'a', status: 'Already exists', progressDetail: {} })
    tracker.onEvent({ id: 'b', status: 'Already exists', progressDetail: {} })
    tracker.finish()

    const last = emitted[emitted.length - 1]
    expect(last.phase).to.equal('complete')
    expect(last.percent).to.equal(100)
    expect(last.downloadedBytes).to.equal(0)
    expect(last.layersDone).to.equal(2)
  })

  it('does not count the "Pulling from <repo>" line as a layer', () => {
    const emitted: ServiceImagePullProgress[] = []
    const tracker = new ImagePullTracker((p) => emitted.push(p))
    // The daemon sends this first, with the TAG as its id.
    tracker.onEvent({ id: '3.12-slim', status: 'Pulling from library/python' })
    pull(tracker, 'layer-a', 1000)
    tracker.finish()

    const last = emitted[emitted.length - 1]
    expect(last.layersTotal).to.equal(1)
    expect(last.layersDone).to.equal(1)
  })

  it("ignores events with no layer id (the pull's own narration)", () => {
    const emitted: ServiceImagePullProgress[] = []
    const tracker = new ImagePullTracker((p) => emitted.push(p))
    tracker.onEvent({ status: 'Digest: sha256:abc' })
    tracker.onEvent({ status: 'Status: Downloaded newer image for x:latest' })
    tracker.finish()
    expect(emitted[emitted.length - 1].layersTotal).to.equal(0)
  })
})

describe('resolveServiceEngine', () => {
  const job = (image: string) => ({ image }) as ServiceJob

  it('recognizes the vLLM image, including a registry mirror of it', () => {
    expect(resolveServiceEngine(job('vllm/vllm-openai'))?.id).to.equal('vllm')
    expect(resolveServiceEngine(job('ghcr.io/vllm/vllm-openai'))?.id).to.equal('vllm')
  })

  it('matches even when a tag or digest is folded into the image', () => {
    expect(resolveServiceEngine(job('vllm/vllm-openai:v0.28.0'))?.id).to.equal('vllm')
    expect(resolveServiceEngine(job('vllm/vllm-openai@sha256:abc'))?.id).to.equal('vllm')
    expect(
      resolveServiceEngine(job('localhost:5000/vllm/vllm-openai:latest'))?.id
    ).to.equal('vllm')
    expect(resolveServiceEngine(job('localhost:5000/vllm/vllm-openai'))?.id).to.equal(
      'vllm'
    )
    expect(
      resolveServiceEngine(job('ghcr.io/ggml-org/llama.cpp:server-cuda'))?.id
    ).to.equal('llamacpp')
  })

  it('falls back to containerImage when image is missing', () => {
    const noImage = { containerImage: 'vllm/vllm-openai:v0.28.0' } as ServiceJob
    expect(resolveServiceEngine(noImage)?.id).to.equal('vllm')
  })

  it('returns null for an image it does not know, so nothing is gated', () => {
    expect(resolveServiceEngine(job('nginxinc/nginx-unprivileged'))).to.equal(null)
    expect(resolveServiceEngine(job('someone/vllm-openai-fork'))).to.equal(null)
    expect(resolveServiceEngine(job(''))).to.equal(null)
  })

  it('reads the Hugging Face repo id out of the vLLM command', () => {
    const vllm = resolveServiceEngine(job('vllm/vllm-openai'))!
    expect(
      vllm.modelIdFromCommand!(['--model', 'Qwen/Qwen2.5-7B-Instruct', '--port', '8000'])
    ).to.equal('Qwen/Qwen2.5-7B-Instruct')
  })

  it('refuses to call a non-Hub source a repo id (no size can be claimed for it)', () => {
    const vllm = resolveServiceEngine(job('vllm/vllm-openai'))!
    // vLLM also serves weights already on disk, or from object storage — asking the Hub about
    // either would measure progress against a repo that has nothing to do with the download.
    expect(vllm.modelIdFromCommand!(['--model', '/models/local-weights'])).to.equal(null)
    expect(vllm.modelIdFromCommand!(['--model', 's3://bucket/model'])).to.equal(null)
    expect(vllm.modelIdFromCommand!(['--model'])).to.equal(null)
    expect(vllm.modelIdFromCommand!(undefined)).to.equal(null)
  })
})

describe('resolveServiceEngine — llama.cpp', () => {
  const job = (image: string, cmd?: string[]) => ({ image, dockerCmd: cmd }) as ServiceJob

  it('recognizes the llama.cpp image and probes /health', () => {
    const engine = resolveServiceEngine(job('ghcr.io/ggml-org/llama.cpp'))
    expect(engine?.id).to.equal('llamacpp')
    // Verified against the arm64 image: the port opens only at "model loaded", and /health then
    // answers 200 {"status":"ok"} — 503 "loading model" on builds that bind earlier.
    expect(engine?.probe.path).to.equal('/health')
    expect(engine?.probe.port).to.equal(8080)
  })

  it('splits `-hf repo:quant` into the repo and the file it pulls', () => {
    const engine = resolveServiceEngine(job('ghcr.io/ggml-org/llama.cpp'))!
    const cmd = ['-hf', 'Qwen/Qwen2.5-0.5B-Instruct-GGUF:Q4_K_M', '--port', '8080']
    expect(engine.modelIdFromCommand!(cmd)).to.equal('Qwen/Qwen2.5-0.5B-Instruct-GGUF')
    expect(engine.modelQuantFromCommand!(cmd)).to.equal('Q4_K_M')
  })

  it('handles a repo with no quant, and a local -m path', () => {
    const engine = resolveServiceEngine(job('ghcr.io/ggml-org/llama.cpp'))!
    expect(engine.modelIdFromCommand!(['-hf', 'org/repo'])).to.equal('org/repo')
    expect(engine.modelQuantFromCommand!(['-hf', 'org/repo'])).to.equal(null)
    // `-m` points at a file already on disk — no repo to size.
    expect(engine.modelIdFromCommand!(['-m', '/models/model.gguf'])).to.equal(null)
  })

  it('uses the same Hugging Face cache as vLLM', () => {
    // NOT /root/.cache/llama.cpp, which older guides name — confirmed absent on a live download.
    const llamacpp = resolveServiceEngine(job('ghcr.io/ggml-org/llama.cpp'))
    const vllm = resolveServiceEngine(job('vllm/vllm-openai'))
    expect(llamacpp?.modelCachePath).to.equal(vllm?.modelCachePath)
  })
})

describe('probeCandidates', () => {
  const job = {
    endpoints: [
      { containerPort: 8000, hostPort: 31000, url: 'http://node.example:31000' },
      { containerPort: 9000, hostPort: 31001, url: 'http://node.example:31001' }
    ]
  } as ServiceJob

  it('tries the container IP first, then the published port, then the public URL', () => {
    const urls = probeCandidates(job, ['172.18.0.2'], 8000, '/v1/models')
    expect(urls[0]).to.equal('http://172.18.0.2:8000/v1/models')
    expect(urls).to.include('http://127.0.0.1:31000/v1/models')
    expect(urls[urls.length - 1]).to.equal('http://node.example:31000/v1/models')
  })

  it('maps the probe port to ITS endpoint, not the first one', () => {
    const urls = probeCandidates(job, [], 9000, '/health')
    expect(urls).to.include('http://127.0.0.1:31001/health')
    expect(urls).to.not.include('http://127.0.0.1:31000/health')
  })
})

describe('runReadinessProbe', () => {
  let server: Server
  let base: string
  // Mimics the two engines: 503 while "loading", then 200 with a model list.
  let loaded = false

  before(async () => {
    server = createServer((req, res) => {
      if (req.url === '/hang') {
        return // never answers — exercises the timeout
      }
      if (!loaded) {
        res.writeHead(503, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ status: 'loading model' }))
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'my-org/my-model' }] }))
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  it('reports not-ready while the engine answers 503', async () => {
    loaded = false
    const result = await runReadinessProbe(`${base}/v1/models`, [200])
    expect(result.ok).to.equal(false)
    expect(result.httpStatus).to.equal(503)
  })

  it('reports ready once the engine answers 200 with the expected model', async () => {
    loaded = true
    const result = await runReadinessProbe(`${base}/v1/models`, [200])
    expect(result.ok).to.equal(true)
    expect(result.httpStatus).to.equal(200)
  })

  it('treats a refused connection as not-ready, with no http status', async () => {
    // Port 1 is reserved and never listening.
    const result = await runReadinessProbe('http://127.0.0.1:1/v1/models', [200])
    expect(result.ok).to.equal(false)
    expect(result.httpStatus).to.equal(undefined)
  })

  it('times out rather than hanging the loop', async () => {
    const result = await runReadinessProbe(`${base}/hang`, [200])
    expect(result.ok).to.equal(false)
    expect(result.error).to.equal('timeout')
  })
})

describe('buildModelDownload', () => {
  const sample = { downloadedBytes: 1_500_000_000, files: 3, inFlight: 1 }

  it('reports a percentage when the model size is known', () => {
    const result = buildModelDownload(sample, 3_000_000_000, 'Qwen/Qwen2.5-7B-Instruct')
    expect(result.percent).to.equal(50)
    expect(result.totalBytes).to.equal(3_000_000_000)
    expect(result.modelId).to.equal('Qwen/Qwen2.5-7B-Instruct')
    expect(result.filesInFlight).to.equal(1)
  })

  it('reports bytes with NO percentage when the size is unknown', () => {
    // A local path, an object-store URI or a repo the Hub has not indexed: the client shows an
    // indeterminate bar rather than a ratio against a guessed denominator.
    const result = buildModelDownload(sample, null, null)
    expect(result.downloadedBytes).to.equal(1_500_000_000)
    expect(result.percent).to.equal(undefined)
    expect(result.totalBytes).to.equal(undefined)
    expect(result.modelId).to.equal(undefined)
  })

  it('caps at 100% rather than reporting more than the whole model', () => {
    // The Hub reports the REPO's safetensors size while the engine downloads only what it needs,
    // so a repo carrying several variants can be exceeded.
    const result = buildModelDownload(
      { ...sample, downloadedBytes: 4_000_000_000 },
      3_000_000_000,
      'a/b'
    )
    expect(result.percent).to.equal(100)
  })
})

describe('model download bytes from container changes', () => {
  const cache = '/root/.cache/huggingface/hub'
  const repo = `${cache}/models--Qwen--Qwen2.5-7B`

  // A container double: `changes()` lists paths, `infoArchive()` answers Docker's stat header.
  function fakeContainer(
    changes: Array<{ Path: string; Kind: number }>,
    files: Record<string, { size: number; linkTarget?: string }>
  ) {
    return {
      changes: () => Promise.resolve(changes),
      infoArchive: ({ path }: { path: string }) => {
        const stat = files[path]
        if (!stat) {
          return Promise.reject(
            Object.assign(new Error('not found'), { statusCode: 404 })
          )
        }
        const header = Buffer.from(JSON.stringify(stat)).toString('base64')
        return Promise.resolve({ headers: { 'x-docker-container-path-stat': header } })
      }
    } as any
  }

  it('keeps only files directly inside a repo blobs folder', () => {
    const paths = selectBlobPaths([
      { Path: cache, Kind: 1 },
      { Path: `${cache}/.locks/models--Qwen--Qwen2.5-7B/abc.lock`, Kind: 1 },
      { Path: `${repo}/blobs`, Kind: 1 },
      { Path: `${repo}/blobs/abc`, Kind: 1 },
      { Path: `${repo}/blobs/def.1a2b3c4d.incomplete`, Kind: 1 },
      { Path: `${repo}/blobs/gone`, Kind: 2 },
      { Path: `${repo}/snapshots/sha/model.safetensors`, Kind: 1 },
      { Path: '/tmp/other', Kind: 1 },
      // HF_HOME moved the cache: still found by its layout.
      { Path: '/data/hf/hub/models--org--name/blobs/xyz', Kind: 1 }
    ])
    expect(paths).to.deep.equal([
      `${repo}/blobs/abc`,
      `${repo}/blobs/def.1a2b3c4d.incomplete`,
      '/data/hf/hub/models--org--name/blobs/xyz'
    ])
  })

  it('counts finished and in-flight files, whatever the partial file is named', async () => {
    const container = fakeContainer(
      [
        { Path: `${repo}/blobs/aaa`, Kind: 1 },
        { Path: `${repo}/blobs/bbb.1a2b3c4d.incomplete`, Kind: 1 },
        { Path: `${repo}/blobs/ccc.downloadInProgress`, Kind: 1 }
      ],
      {
        [`${repo}/blobs/aaa`]: { size: 1000 },
        [`${repo}/blobs/bbb.1a2b3c4d.incomplete`]: { size: 300 },
        [`${repo}/blobs/ccc.downloadInProgress`]: { size: 200 }
      }
    )
    expect(await readModelDownloadBytes(container)).to.deep.equal({
      downloadedBytes: 1500,
      files: 1,
      inFlight: 2
    })
  })

  it('counts a file that finished between the listing and the stat under its new name', async () => {
    const container = fakeContainer(
      [{ Path: `${repo}/blobs/bbb.1a2b3c4d.incomplete`, Kind: 1 }],
      { [`${repo}/blobs/bbb`]: { size: 900 } }
    )
    expect(await readModelDownloadBytes(container)).to.deep.equal({
      downloadedBytes: 900,
      files: 1,
      inFlight: 0
    })
  })

  it('follows a blob symlinked into a shared store', async () => {
    const container = fakeContainer([{ Path: `${repo}/blobs/aaa`, Kind: 1 }], {
      [`${repo}/blobs/aaa`]: { size: 40, linkTarget: '../../shared/aaa' },
      [`${repo}/blobs/../../shared/aaa`]: { size: 5000 }
    })
    expect((await readModelDownloadBytes(container))?.downloadedBytes).to.equal(5000)
  })

  it('reports nothing while the cache holds no blobs yet, or when Docker fails', async () => {
    expect(await readModelDownloadBytes(fakeContainer([], {}))).to.equal(null)
    const failing = { changes: () => Promise.reject(new Error('boom')) } as any
    expect(await readModelDownloadBytes(failing)).to.equal(null)
  })
})

describe('fetchModelTotalBytes', () => {
  const realFetch = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = realFetch
  })

  it('backs off after a transient Hub failure instead of retrying every sample', async () => {
    let calls = 0
    globalThis.fetch = (() => {
      calls++
      return Promise.resolve(new Response('busy', { status: 503 }))
    }) as typeof fetch
    expect(await fetchModelTotalBytes('backoff-test/model-a')).to.equal(null)
    expect(await fetchModelTotalBytes('backoff-test/model-a')).to.equal(null)
    expect(calls).to.equal(1)
  })

  it('caches a successful answer for good', async () => {
    let calls = 0
    globalThis.fetch = (() => {
      calls++
      return Promise.resolve(
        Response.json({ safetensors: { parameters: { BF16: 1000, F32: 10 } } })
      )
    }) as typeof fetch
    expect(await fetchModelTotalBytes('backoff-test/model-b')).to.equal(2040)
    expect(await fetchModelTotalBytes('backoff-test/model-b')).to.equal(2040)
    expect(calls).to.equal(1)
  })
})

describe('isModelDownloadComplete', () => {
  const record = (percent: number | undefined, filesInFlight: number) =>
    ({
      downloadedBytes: 1,
      percent,
      filesComplete: 1,
      filesInFlight,
      updatedAt: 0
    }) as any

  it('is complete only at 100% with nothing still arriving', () => {
    expect(isModelDownloadComplete(record(100, 0))).to.equal(true)
    // The total is an estimate: 100% with a shard still being written is not done.
    expect(isModelDownloadComplete(record(100, 1))).to.equal(false)
    expect(isModelDownloadComplete(record(99, 0))).to.equal(false)
    // No total known: never declared complete, sampling carries on.
    expect(isModelDownloadComplete(record(undefined, 0))).to.equal(false)
    expect(isModelDownloadComplete(undefined)).to.equal(false)
  })
})

describe('ModelDownloadSampler', () => {
  const repo = '/root/.cache/huggingface/hub/models--Qwen--Qwen2.5-7B'

  // A container whose cache the test mutates between samples; counts the expensive listing.
  function liveContainer(id = 'c1') {
    const files: Record<string, number> = {}
    const state = { changesCalls: 0 }
    const container = {
      id,
      changes: () => {
        state.changesCalls++
        return Promise.resolve(Object.keys(files).map((Path) => ({ Path, Kind: 1 })))
      },
      infoArchive: ({ path }: { path: string }) => {
        if (!(path in files)) {
          return Promise.reject(new Error('not found'))
        }
        const header = Buffer.from(JSON.stringify({ size: files[path] })).toString(
          'base64'
        )
        return Promise.resolve({ headers: { 'x-docker-container-path-stat': header } })
      }
    } as any
    return { container, files, state }
  }

  it('re-lists only on its own cadence, stat-ing known files in between', async () => {
    const sampler = new ModelDownloadSampler()
    const { container, files, state } = liveContainer()
    files[`${repo}/blobs/a.1a2b3c4d.incomplete`] = 100

    expect((await sampler.sample('svc', container, 0))?.downloadedBytes).to.equal(100)
    files[`${repo}/blobs/a.1a2b3c4d.incomplete`] = 700
    // Growth of a known file is seen without listing again.
    expect((await sampler.sample('svc', container, 5_000))?.downloadedBytes).to.equal(700)
    expect(state.changesCalls).to.equal(1)
    // A file that started on its own waits for the periodic re-list.
    files[`${repo}/blobs/b.5e6f7a8b.incomplete`] = 50
    expect((await sampler.sample('svc', container, 10_000))?.downloadedBytes).to.equal(
      700
    )
    expect(
      (await sampler.sample('svc', container, BLOB_REDISCOVER_MS))?.downloadedBytes
    ).to.equal(750)
    expect(state.changesCalls).to.equal(2)
  })

  it('re-lists right after a known download finishes', async () => {
    const sampler = new ModelDownloadSampler()
    const { container, files, state } = liveContainer()
    files[`${repo}/blobs/a.1a2b3c4d.incomplete`] = 100
    await sampler.sample('svc', container, 0)

    // `a` finishes and the downloader starts `b`.
    delete files[`${repo}/blobs/a.1a2b3c4d.incomplete`]
    files[`${repo}/blobs/a`] = 1000
    files[`${repo}/blobs/b.5e6f7a8b.incomplete`] = 20
    const finished = await sampler.sample('svc', container, 5_000)
    expect(finished).to.deep.equal({ downloadedBytes: 1000, files: 1, inFlight: 0 })
    expect(state.changesCalls).to.equal(1)
    // The finish marked the list stale: the next sample picks `b` up well before 30s.
    const next = await sampler.sample('svc', container, 10_000)
    expect(next).to.deep.equal({ downloadedBytes: 1020, files: 1, inFlight: 1 })
    expect(state.changesCalls).to.equal(2)
  })

  it('polls an empty cache on the shorter cadence', async () => {
    const sampler = new ModelDownloadSampler()
    const { container, files, state } = liveContainer()
    expect(await sampler.sample('svc', container, 0)).to.equal(null)
    files[`${repo}/blobs/a.1a2b3c4d.incomplete`] = 10
    expect(await sampler.sample('svc', container, 5_000)).to.equal(null)
    expect(
      (await sampler.sample('svc', container, BLOB_EMPTY_REDISCOVER_MS))?.downloadedBytes
    ).to.equal(10)
    expect(state.changesCalls).to.equal(2)
  })

  it('starts over for a new container and forgets services that ended', async () => {
    const sampler = new ModelDownloadSampler()
    const first = liveContainer('c1')
    first.files[`${repo}/blobs/a`] = 500
    await sampler.sample('svc', first.container, 0)

    // Restart: a new container with an empty cache must not be measured with the old paths.
    const second = liveContainer('c2')
    expect(await sampler.sample('svc', second.container, 1_000)).to.equal(null)
    expect(second.state.changesCalls).to.equal(1)

    sampler.retain(new Set())
    first.files[`${repo}/blobs/b`] = 1
    await sampler.sample('svc', first.container, 2_000)
    expect(first.state.changesCalls).to.equal(2)
  })
})
