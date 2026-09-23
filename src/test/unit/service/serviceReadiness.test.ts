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
import { buildModelDownload } from '../../../components/c2d/modelDownload.js'

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
