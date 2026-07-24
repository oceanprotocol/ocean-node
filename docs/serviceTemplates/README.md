# Service templates

Example service templates for the ocean-node *services on demand* feature. A template
describes a long-running containerized service (image, ports, launch command, resource
requirements) that consumers can start on a node via `SERVICE_START`.

## How templates are loaded

- The node reads templates from the directory set by `serviceTemplatesPath` in the node
  config (default: `databases/serviceTemplates/`). This folder (`docs/serviceTemplates/`)
  is a set of examples — copy the ones you want to offer into your configured path.
- Only `*.json` files are read; anything else (including this `README.md`) is ignored.
- A file may contain a single template object or an array of templates.
- Files are re-read on every request, so you can add/edit/remove templates without
  restarting the node.
- Invalid JSON or schema-invalid templates are skipped with a warning; on duplicate
  `id`s the first occurrence (filename-sorted) wins.

## Template format

Templates are validated against `ServiceTemplateSchema`
(`src/utils/config/schemas.ts`); the TypeScript shape is `ServiceTemplate`
(`src/@types/C2D/ServiceOnDemand.ts`). Key fields:

| Field | Meaning |
| --- | --- |
| `id` | Unique id, `[a-z0-9][a-z0-9_-]{0,63}` |
| `image` + exactly one of `tag` / `checksum` / `dockerfile` | Image spec (`dockerfile` triggers a build and is gated per daemon by `allowImageBuild`) |
| `exposedPorts` | Container ports forwarded to host ports and returned as service endpoints |
| `command` / `entrypoint` | Docker CMD / ENTRYPOINT overrides |
| `envVars` | Fixed operator-set env vars (values never returned to callers) |
| `userConfigurableEnvVars` | Env vars the consumer supplies via ECIES-encrypted `userData` (optional regex `validation`, `sensitive` UI hint) |
| `requiredResources` / `recommendedResources` | Gate/score environment selection (`min` is enforced at `SERVICE_START`) |

## Templates in this folder

### `vllm-hf-model.json` — vLLM, any Hugging Face model (GPU)

OpenAI-compatible inference server (`vllm/vllm-openai`) where the consumer picks the
model: the `MODEL_ID` user env var is substituted into the launch command (`${MODEL_ID}`)
and downloaded from the Hugging Face Hub at startup. Serves port 8000. Provide `HF_TOKEN`
for gated/private models. Requires a CUDA GPU sized to the chosen model.

### `vllm-qwen-0_5b.json` — vLLM, Qwen2.5 0.5B Instruct (GPU)

Same server, but the model is fixed by the operator to the small
`Qwen/Qwen2.5-0.5B-Instruct` (≥ 6 GB VRAM is plenty). Serves port 8000. `HF_TOKEN` is
only needed if you later switch to a gated model.

### `vllm-nomic-embed.json` — vLLM, embeddings API (GPU)

Runs vLLM in embedding/pooling mode (`--task embed`) serving
`nomic-ai/nomic-embed-text-v1.5` on port 8000 (`POST /v1/embeddings`). Needs
`--trust-remote-code` because the model ships custom modeling code executed in the
container. A few GB of VRAM is enough for this 137M model.

### `llamacpp-phi4-cpu.json` — llama.cpp, Phi-4 (CPU)

CPU-only OpenAI-compatible chat server. The `vllm/vllm-openai` image is CUDA-only, so
this template uses llama.cpp (`ghcr.io/ggml-org/llama.cpp:server`) instead, downloading
the full Phi-4 (14B) as a Q4_K_M GGUF quantization — quantization is what makes 14B
feasible on CPU. Serves port 8080. For CPU inference with vLLM proper, see
`vllm-dual-lite-cpu.json` below.

### `vllm-dual-lite-gpu.json` — vLLM, two lite models on one 3 GB GPU

Two OpenAI-compatible vLLM servers in a single container, sized to fit **together** on a
3 GB VRAM GPU:

- `Qwen/Qwen2.5-0.5B-Instruct` (~1.0 GB fp16) on port 8000, `--gpu-memory-utilization 0.42`
- `HuggingFaceTB/SmolLM2-360M-Instruct` (~0.7 GB fp16) on port 8001, `--gpu-memory-utilization 0.30`

Budget math for 3 GB: the utilization split caps vLLM at ~2.2 GB combined, leaving
~0.8 GB for the two CUDA contexts. `--enforce-eager` (no CUDA-graph memory),
`--max-model-len 2048`, `--max-num-seqs 4`, `--dtype half` (works on GPUs without bf16,
e.g. the T4) and `--swap-space 1` keep everything inside the envelope.

Tuning caveat: 3 GB for two vLLM instances is inherently tight — if a particular GPU's
driver/context overhead runs high, loosen `--max-model-len` first or drop SmolLM2's
utilization to 0.25.

### `vllm-dual-lite-cpu.json` — vLLM, two lite models on CPU only

Two OpenAI-compatible vLLM servers, CPU backend, no GPU resource required. Uses the
**official vLLM CPU image** (`public.ecr.aws/q9t5s3a7/vllm-cpu-release-repo`, x86-64,
AVX-512 recommended) — genuinely vLLM on CPU, unlike the llama.cpp workaround above.

- `Qwen/Qwen2.5-0.5B-Instruct` on port 8000
- `microsoft/Phi-4-mini-instruct` (3.8B) on port 8001 — the lite Phi-4 variant; full 14B
  Phi-4 needs ~28 GB unquantized and is impractical on CPU

Each process gets a 2 GiB CPU KV cache (`VLLM_CPU_KVCACHE_SPACE=2`, exported in the
launch script) and `--max-model-len 4096`; both share the CPU cores, so expect modest
throughput.

### `comfyui.json` — ComfyUI, image & video generation (GPU)

Node-graph web UI for diffusion models (SD/SDXL/Flux, video via AnimateDiff/SVD),
`yanwk/comfyui-boot:cu126-megapak`. The image already launches bound to `0.0.0.0:8188`,
so no `command` override is needed. Bundles ComfyUI-Manager for installing checkpoints /
custom nodes from the UI; `HF_TOKEN` / `CIVITAI_TOKEN` are optional user env vars for gated
downloads. ~10 GB VRAM for SDXL.

### `automatic1111.json` — Stable Diffusion WebUI (A1111) (GPU)

The classic AUTOMATIC1111 UI (`universonic/stable-diffusion-webui`). The image entrypoint
forwards `command` args to `webui.sh`, so the template sets `command` to
`["--listen","--port","7860"]` (last `--port` wins over the image's baked-in default),
binding `0.0.0.0:7860`. Optional `HF_TOKEN` / `CIVITAI_TOKEN`. ~8 GB VRAM for SDXL.

### `fooocus.json` — Fooocus, simplified SDXL (GPU)

Streamlined SDXL generator (`ghcr.io/lllyasviel/fooocus`). No ENTRYPOINT, so the template's
`command` runs the image's own setup script directly:
`["/content/entrypoint.sh","--listen","--port","7865"]` → `0.0.0.0:7865`. Downloads its base
SDXL checkpoint on first run (slow first launch). ~8 GB VRAM.

### `jupyterlab.json` — JupyterLab notebooks (CPU)

JupyterLab on the scipy stack (`quay.io/jupyter/scipy-notebook`). `command` runs
`start-notebook.sh` with token/password auth disabled and `--NotebookApp.ip=0.0.0.0`,
serving port 8888. NOTE: the endpoint is an unauthenticated port-forward — anyone with the
URL gets full notebook (code-exec) access. CPU-only.

### `open-webui.json` — Open WebUI + Ollama (GPU)

ChatGPT-style UI wired to a bundled Ollama runtime (`ghcr.io/open-webui/open-webui:ollama`),
so it runs local LLMs out of the box. Binds `0.0.0.0:8080` by default (no `command`). First
visit creates an admin account. Needs a CUDA GPU for usable token speed.

## The dual-model pattern

One vLLM process serves exactly one model, so the two dual templates override
`entrypoint` to `["/bin/bash", "-c"]` and run two `vllm serve` processes from a single
`command` script:

1. Start model A in the background and remember its PID.
2. Poll until port 8000 accepts connections (bash `/dev/tcp` probe — no curl needed),
   bailing out if the process died. On GPU this also guarantees the two instances never
   profile GPU memory at the same time.
3. Start model B on port 8001.
4. `wait -n` — the script (container PID 1) exits as soon as either server exits, so a
   crashed model stops the whole service instead of leaving it half-alive.

Both dual templates expose an optional `HF_TOKEN` user env var; all models referenced
here are ungated, so it is only needed if an operator swaps in a gated model.

## GPU memory with multiple vLLM instances: who manages what

Within one instance vLLM manages memory for you; across instances it does nothing —
the GPU must be partitioned manually. That is why the dual GPU template hard-codes the
split.

**What vLLM manages** — inside a single `vllm serve` process, memory management is
excellent: it loads the weights, profiles peak activation usage, then pre-allocates
everything left in its budget as paged KV cache (PagedAttention), and handles
scheduling/preemption within that. Per-request memory is never the operator's problem.

**What it doesn't** — that budget comes from `--gpu-memory-utilization`, which is a
*per-process* fraction of the GPU (default **0.9**). Each instance assumes it owns that
slice and knows nothing about other processes. Two instances with defaults means
0.9 + 0.9 of the same GPU → the second one OOMs during KV-cache allocation. There is no
cross-instance coordination, negotiation, or dynamic rebalancing — the split is static
for the life of the process.

When running multiple models on one GPU, the template (or operator) is responsible for
three things:

1. **Fractions that sum below 1.0** — and not just barely: the CUDA context
   (~250–500 MB per process) and allocator fragmentation live *outside* vLLM's
   accounting. The dual GPU template uses 0.42 + 0.30 (~2.2 GB of 3 GB), leaving
   ~0.8 GB for the two contexts.
2. **Startup sequencing** — during startup each instance profiles memory and has a
   usage peak; overlapping profiling on a tight GPU can OOM even if steady-state fits.
   The template's `/dev/tcp` readiness gate serializes this.
3. **Caps that shrink the budget it will try to claim** — `--max-model-len`,
   `--max-num-seqs`, and `--enforce-eager` (CUDA graphs cost extra memory outside the
   KV budget on some versions) keep both the profiling peak and steady state
   predictable.

Two caveats worth knowing:

- **One vLLM server = one model.** vLLM's OpenAI server cannot serve two different base
  models from a single process, which is why the dual templates run two processes. The
  exception is **LoRA adapters**: if the "multiple models" are fine-tunes of the same
  base, one instance with `--enable-lora` serves them all under one memory budget with
  shared base weights — vLLM manages everything, and it is far more memory-efficient.
- For harder isolation than "fractions that behave", the GPU-side options are MIG
  partitions (A100/H100 class) or CUDA MPS — but for the 3 GB template scenario, the
  static fraction split is the right tool.
