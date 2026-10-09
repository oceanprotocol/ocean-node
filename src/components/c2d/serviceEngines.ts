import type { ServiceJob } from '../../@types/C2D/ServiceOnDemand.js'

/**
 * What the node knows about the workloads it can report readiness and model-download progress for.
 *
 * Deliberately a closed table rather than something the client declares. A service's container
 * reports Running the moment its process starts, but an inference engine then spends minutes
 * downloading weights and warming up — during which its port either refuses connections or answers
 * 503. Only the engine knows when that ends, and only the node can ask it (the endpoint is plain
 * http, so a browser on an https page cannot). Knowing WHICH question to ask is engine-specific, so
 * it lives here: one row per engine the node understands.
 *
 * An unrecognized image matches nothing, and the node then reports no readiness at all — which every
 * client reads as "this node cannot tell me", falling back to the pre-existing behaviour where
 * Running means the endpoint is handed over. New engines are added by adding a row.
 */
export interface ServiceEngineProfile {
  /** Identifier carried on the job's readiness record, so a client can tell what was probed. */
  id: string
  /** Matches the image reference (without tag/digest) this engine ships as. */
  matchesImage: (image: string) => boolean
  /** The request that proves the engine can serve traffic. */
  probe: {
    path: string
    /** Container port to probe; defaults to the service's first exposed port when absent. */
    port?: number
    expectStatus: number[]
  }
  /**
   * Where this engine caches the model it downloads at startup, inside the container, by default.
   * Its presence is what turns progress reporting on; the files themselves are found by the Hugging
   * Face cache layout wherever it sits (see modelDownload). Absent for an engine whose download the
   * node cannot observe — readiness still works, progress simply isn't reported.
   */
  modelCachePath?: string
  /**
   * Recovers the Hugging Face repo id from the container command, for the size lookup. Returns null
   * when the engine was pointed at anything else (a local path, an object-store URI, another hub) —
   * progress is then reported as bytes with no total.
   */
  modelIdFromCommand?: (cmd: string[] | undefined) => string | null
  /**
   * The specific file within the repo this engine downloads, when it names one (llama.cpp's
   * `-hf <repo>:<quant>`). Lets the size lookup ask for that file rather than the whole repo, which
   * for a GGUF repo carrying a dozen quantizations differs by an order of magnitude.
   */
  modelQuantFromCommand?: (cmd: string[] | undefined) => string | null
}

/**
 * The Hugging Face repo id llama.cpp is serving, or null.
 *
 * `-hf <org>/<repo>[:<quant>]` fetches a GGUF from the Hub; the `:quant` suffix selects a file
 * within the repo and is not part of the repo id. `-m <path>` (a local file) names no repo at all.
 */
function hfRepoIdFromLlamaCppCommand(cmd: string[] | undefined): string | null {
  if (!cmd) return null
  const index = cmd.indexOf('-hf')
  if (index === -1 || index === cmd.length - 1) return null
  const value = cmd[index + 1]
  if (!value || value.startsWith('-')) return null
  const repo = value.split(':')[0]
  return isHubRepoId(repo, { requireOrg: true }) ? repo : null
}

/**
 * Whether a string is shaped like a Hugging Face repo id: `org/name`, or bare `name` when an org is
 * not required. Checked segment by segment rather than with one pattern — a regex combining an
 * optional group with repeated character classes backtracks ambiguously on caller-supplied input.
 */
function isHubRepoId(value: string, opts: { requireOrg?: boolean } = {}): boolean {
  const segments = value.split('/')
  if (segments.length > 2) return false
  if (opts.requireOrg && segments.length !== 2) return false
  return segments.every((segment) => segment.length > 0 && /^[\w.-]+$/.test(segment))
}

/** The quant tag in `-hf <repo>:<quant>`, e.g. `Q4_K_M`. Null when the command names no quant. */
function quantFromLlamaCppCommand(cmd: string[] | undefined): string | null {
  if (!cmd) return null
  const index = cmd.indexOf('-hf')
  if (index === -1 || index === cmd.length - 1) return null
  const parts = String(cmd[index + 1] ?? '').split(':')
  return parts.length > 1 && parts[1] ? parts[1] : null
}

/**
 * The Hugging Face repo id vLLM is serving, or null when it is not serving one.
 *
 * `--model` accepts far more than a Hub repo: an absolute path to weights already on disk, an
 * object-store URI (`s3://`, `gs://`), or a ModelScope id when VLLM_USE_MODELSCOPE is set. Only a
 * plain `org/name` is a Hub repo whose size the Hub can be asked for — everything else returns null,
 * and the caller then reports bytes downloaded with no total (an indeterminate bar) rather than
 * measuring against a repo that has nothing to do with what is being fetched.
 */
function hfRepoIdFromVllmCommand(cmd: string[] | undefined): string | null {
  if (!cmd) return null
  const index = cmd.indexOf('--model')
  if (index === -1 || index === cmd.length - 1) return null
  const value = cmd[index + 1]
  if (!value || value.startsWith('-')) return null
  // A local path or a remote URI is not a Hub repo.
  if (value.startsWith('/') || value.startsWith('.') || value.includes('://')) return null
  // A Hub repo is exactly `org/name` (no further slashes, no whitespace). `name` alone is a
  // canonical-model shorthand the Hub also serves, so it is accepted too.
  if (!isHubRepoId(value)) return null
  // NOTE: a ModelScope id (VLLM_USE_MODELSCOPE=1) is shaped exactly like a Hub one and cannot be
  // told apart here, since the env that selects it rides in encrypted userData. The Hub lookup then
  // simply 404s and the caller falls back to bytes-with-no-total, which is the right outcome anyway.
  return value
}

export const SERVICE_ENGINE_PROFILES: ServiceEngineProfile[] = [
  {
    id: 'vllm',
    // The upstream image, and the common convention of mirroring it under another registry with the
    // same repository path. A privately renamed build matches nothing, which is the documented
    // "no readiness reported" case rather than a wrong answer.
    matchesImage: (image) =>
      /(^|\/)vllm\/vllm-openai$/.test(image) || image === 'vllm-openai',
    /**
     * `/v1/models`, NOT `/health`: across vLLM versions `/health` has answered 200 from the moment
     * the HTTP server binds, which on some builds is before the weights are loaded — it would
     * declare readiness at exactly the wrong moment. `/v1/models` is the model-aware one. vLLM also
     * often binds the port only after loading, so the probe simply gets a connection refusal until
     * then; both shapes mean "not ready".
     */
    probe: { path: '/v1/models', port: 8000, expectStatus: [200] },
    // huggingface_hub's cache, which vLLM inherits. HF_HOME defaults to ~/.cache/huggingface and the
    // official image runs as root.
    modelCachePath: '/root/.cache/huggingface/hub',
    modelIdFromCommand: hfRepoIdFromVllmCommand
  },
  {
    id: 'llamacpp',
    // Upstream publishes CPU (`:server`) and CUDA (`:server-cuda`) under the same repository, and
    // NEXT_PUBLIC_LLAMACPP_IMAGE lets an operator point at their own build of it — matched on the
    // repository path, whatever registry it is mirrored under.
    matchesImage: (image) => /(^|\/)ggml-org\/llama\.cpp$/.test(image),
    /**
     * llama.cpp's server binds its port only once the model is in memory, and its `/health` is
     * documented to answer 503 `{"status":"loading model"}` while loading and 200 `{"status":"ok"}`
     * after — verified against the arm64 image: connection refused, then 200, with the port opening
     * at "model loaded". Either shape reads as not-ready, so the check holds for both.
     */
    probe: { path: '/health', port: 8080, expectStatus: [200] },
    // `-hf` downloads through the Hugging Face cache, exactly like vLLM's — NOT the
    // `/root/.cache/llama.cpp` that older guides mention (confirmed absent on a live download).
    modelCachePath: '/root/.cache/huggingface/hub',
    modelIdFromCommand: hfRepoIdFromLlamaCppCommand,
    modelQuantFromCommand: quantFromLlamaCppCommand
  }
]

/**
 * The repository path of an image reference, with any `@digest` and `:tag` removed. `image` is
 * documented as the bare name (tag and digest ride in their own fields), but a caller that folds
 * them in should still match. Only the last path segment carries a tag, so a registry port
 * (`localhost:5000/...`) is left alone.
 */
function stripImageRef(image: string): string {
  const withoutDigest = image.split('@')[0]
  const lastSlash = withoutDigest.lastIndexOf('/')
  const colon = withoutDigest.indexOf(':', lastSlash + 1)
  return colon === -1 ? withoutDigest : withoutDigest.slice(0, colon)
}

/** The engine profile for a service, or null when the node does not recognize the image. */
export function resolveServiceEngine(job: ServiceJob): ServiceEngineProfile | null {
  const image = stripImageRef((job.image || job.containerImage || '').trim())
  if (!image) {
    return null
  }
  return SERVICE_ENGINE_PROFILES.find((profile) => profile.matchesImage(image)) ?? null
}
