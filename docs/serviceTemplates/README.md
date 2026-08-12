# Service templates

Example service templates for the ocean-node _services on demand_ feature. A template
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

| Field                                                      | Meaning                                                                                                          |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `id`                                                       | Unique id, `[a-z0-9][a-z0-9_-]{0,63}`                                                                            |
| `image` + exactly one of `tag` / `checksum` / `dockerfile` | Image spec (`dockerfile` triggers a build and is gated per daemon by `allowImageBuild`)                          |
| `exposedPorts`                                             | Container ports forwarded to host ports and returned as service endpoints                                        |
| `command` / `entrypoint`                                   | Docker CMD / ENTRYPOINT overrides                                                                                |
| `commandFile`                                               | Path to a script, resolved relative to this directory and inlined as `command[0]` at load time (mutually exclusive with `command`) |
| `envVars`                                                  | Fixed operator-set env vars (values never returned to callers)                                                   |
| `userConfigurableEnvVars`                                  | Env vars the consumer supplies via ECIES-encrypted `userData` (optional regex `validation`, `sensitive` UI hint, `required` hint — advisory, never enforced node-side) |
| `requiredResources` / `recommendedResources`               | Gate/score environment selection (`min` is enforced at `SERVICE_START`)                                          |
| `workflows`                                                 | Selectable graphs for UI-driven templates; each entry is `id` / `name` / `file` (a path to the graph JSON, resolved relative to this directory and inlined into `graph` at load time) |

### Catalogue metadata (services vs bundles)

Optional, purely descriptive fields. They change nothing about how the container runs —
they travel to clients through the `getServiceTemplates` sanitizer and only affect how the
entry is presented in a catalogue. A template that omits all of them is a plain **service**.

| Field      | Meaning                                                                                                          |
| ---------- | ---------------------------------------------------------------------------------------------------------------- |
| `kind`     | `service` (bare app, the default when absent) or `bundle` (the same app whose command pre-downloads a curated model set) |
| `service`  | Bundles only, **required on them**: `id` of the service template this is a variant of (may not exist on this node) |
| `outcome`  | Bundles only: the one concrete thing this gets done, one sentence                                                 |
| `category` | One of `image` / `video` / `llm` / `serving` / `notebook` / `embeddings` / `app`                                  |
| `includes` | Bundles only: manifest of what the command downloads — `name`, `kind` (`model` / `workflow` / `customnode` / `other`), optional `sizeGb`, `repoId`, `url`. Display metadata; nothing here is fetched or verified by the node |

Keep `includes` in step with what the script actually downloads: clients use its length as
the denominator for a "preparing models — N of M" progress line, driven by `[models]`
markers on the container's stdout (`downloading <name>` / `ready: <name>` /
`already present: <name>` / `WARNING: could not download <name>` / `bundle complete`). The
markers are a convention, not a protocol — a script that prints none simply shows no
progress.

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

### `ltx-video-ugc-product.json` — ComfyUI, LTX-2.3 product video (GPU)

A product photo becomes a 9:16 vertical clip (720×1280, 5 s) with camera motion and ambient
audio, using the fixed workflow `workflows/ocean_ugc_product.json`. Needs a CUDA GPU with
48 GB+ VRAM.

Pick a persistent-storage bucket: it holds ComfyUI's whole base directory, so the ~38 GiB
weight set downloads only on the first launch, and clips are written to the bucket root where
the storage API's `listFiles` (top-level files only) can see them. Without a bucket everything
goes to `/tmp` and is lost on stop.

### `ltx-video-ugc-multishot.json` — ComfyUI, LTX-2.3 multishot UGC reel (GPU)

Same image, bucket behavior and **the same generator** as the product template — both
workflows embed the identical `Image to Video (LTX-2.3)` subgraph (22B dev fp8 + distilled
LoRA, base pass at 360×640, `LTXVLatentUpsampler`, then a refine pass at 720×1280), so shot
quality matches. It builds a vertical reel one 720×1280 / 5 s shot at a time. Ships two
workflows:

- `workflows/ocean_ugc_multishot.json` — renders one shot per Run.
- `workflows/ocean_ugc_assemble.json` — concatenates rendered shots into one reel.

Three inputs, following what the reference-image tools converged on: a **first frame**
(optional — a character photo; with none, flip *No character image* and the style prompt
builds the character instead), a **style box** holding everything that must not change
between shots (who the character is, wardrobe, room, lighting, palette, camera look), and a
**scene box** holding only what does (action, camera move, dialogue, ambient sound). Keeping
the style box byte-identical across runs is what holds the reel together — so it is a
separate box from the scene text rather than something you retype and drift.

Click **Run** for a clip, edit the scene box, Run again. Clips save to the bucket root with
ComfyUI's own save counter — `shot_00001…`, `shot_00002…` — so re-takes never overwrite and
you pick the good ones at assembly time.

**Frame chaining.** Every run also drops that clip's last frame beside it as
`lastframe_…png`. Refresh, pick it in the image slot, and the next shot starts exactly where
the last one ended — identity carried in pixels rather than in prose, which is what the
reference-image tools rely on and what text-only character descriptions cannot do.

**Hard cuts.** The *Shot start* dial controls how literally that image is taken. It drives
the `strength` of both `LTXVImgToVideoInplace` passes, promoted out of the subgraph: the
refine pass directly, the base pass through `a * 0.7` so the dial at **1.0** reproduces the
strengths the graph shipped with (1.0 refine / 0.7 base) exactly. At **1.0** frame 0 *is* the
image and the take continues seamlessly. Around **0.35** the image only guides look and
character while the model composes a new frame — a hard cut to a new scene with the same
face and wardrobe. The separate *No character image* toggle still bypasses the image
entirely (`Switch to Text to Video?` inside the subgraph) for a shot built from the prompt
alone.

Three ways to start a shot, then: continue it, cut to it, or generate it fresh.

Mechanically: the generator subgraph exposes its decoded frames as a second `IMAGE` output
alongside `VIDEO`; `GetImageSize` → `a - 1` → `ImageFromBatch` takes the final frame and
`SaveImage` writes it. It costs one PNG per run and needs no interaction — and because the
bootstrap points ComfyUI's `--input-directory` and `--output-directory` at the same bucket
root, the PNG shows up in `LoadImage`'s dropdown with no copying.

Once every shot looks good, switch to the **Assemble reel** workflow, pick the clips in its
`LoadVideo` slots, bypass the slots you don't need, and Run — it concatenates them into one
clip inside ComfyUI, no external editor needed.

**Voice.** LTX builds each clip's audio from a fresh `LTXVEmptyLatentAudio` conditioned only
on the text — there is no speaker embedding, so a spoken line is a different person on every
cut and no amount of prompting locks it. Frame chaining carries the face; nothing carries the
voice.

Assemble concatenates the clips' own audio, which keeps ambience and picture in sync, then
runs the stitched track through **voice conversion** — the same thing dubbing pipelines do.
`UnifiedVoiceChangerNode` remaps every line to one reference speaker while leaving the words,
their timing and the room tone alone. That is why conversion beats dubbing a voiceover over
the footage: the phonemes never move, so ambience survives and the lips still match. Upload a
few seconds of clean speech as the reference voice; `refinement_passes` 1 is usually right
(above ~5 it distorts) and `max_chunk_duration` bounds VRAM, rejoining chunks with
timing-preserving concatenation.

Scripting still helps and costs nothing: dialogue in one or two shots, action and ambience in
the rest, means fewer conversions to get right.

If the voice nodes load red, the pack failed to install — delete both and wire the last
`AudioConcat` straight into `CreateVideo`, which is the plain stitched audio the workflow
used before. The node's own how-to says so too.

### `minimax-h3-video-ugc-multishot.json` — ComfyUI, MiniMax H3 UGC reel (GPU)

Same image and bucket behavior as the LTX templates, but a different generator — MiniMax H3
(open-weights, int8) — and a different unit of work: one Run here is a ~12 s **beat** that can
itself contain several internal cuts (the shipped example prompt holds two shots in one beat),
rather than LTX's one continuous take per Run. A 30 s reel is 2–3 Runs of this template versus
the 6–8 Runs LTX multishot needs for the same length. Needs a CUDA GPU, 24 GB+ VRAM recommended
(12 GB works with offloading). Ships two workflows:

- `workflows/ocean_h3_ugc_multishot.json` — renders one beat per Run.
- `workflows/ocean_h3_ugc_assemble.json` — concatenates up to 8 rendered beats into one reel.

**Native audio, no voice-conversion pass.** H3 generates voice, room tone and music in the
same forward pass as the video, so there is no separate TTS step and nothing analogous to the
LTX templates' `UnifiedVoiceChangerNode` pass. The bootstrap's TTS-Audio-Suite install is gated
on the installed graph containing `UnifiedVoiceChangerNode`; this workflow never does, so the
install never runs for this template — no custom node pack rides along.

**Three prompt boxes, and why not two.** H3 mandates this section order:

    subject_definitions → summary → retention_analysis →
    detailed_description → overall_soundscape → non_diegetic_music

The set-once sections are the 1st, 3rd and 6th and the per-beat ones the 2nd, 4th and 5th, so
they interleave: a two-box `{casting}\n\n{beat}` join would emit 1,3,6,2,4,5 and break the
order. Splitting at the order-preserving boundaries gives three boxes — **Casting**
(`subject_definitions`), **This beat** (`summary`, `retention_analysis`,
`detailed_description`, `overall_soundscape`) and **Music bed** (`non_diegetic_music`) — joined
top to bottom by two `StringFormat` nodes. `retention_analysis` is the section actually holding
the character's face across a beat's internal cuts (a `fully_preserved` / `attribute_transfer`
line per subject), and it sits in **This beat** rather than with the casting text because it
names which shots each subject appears in, so it changes with the beat.

**One subgraph, 17 canvas nodes.** Like the LTX generator, everything that is plumbing rather
than a decision — both checkpoints, the mode switch, the CLIP and VAE loaders, the two H3
conditioning nodes, resolution/duration/frame-grid, the sampler chain, decode, `CreateVideo`
and the last-frame picker — lives inside one collapsed subgraph, `Generate audio + video
(MiniMax H3)`. Six widgets are promoted onto its face: mode, megapixels, duration, steps, seed,
`ref_image_size`. The canvas itself is the three prompt boxes, the image/video/audio inputs, the
subgraph instance and the two save nodes.

**Hero-beat referencing.** The Continuity group (`LoadVideo` + `GetVideoComponents`, pointed at
a rendered beat) ships bypassed. From beat 2 on, un-bypass it and point `LoadVideo` at
**beat 1**, never at the newest beat: chaining beat N off beat N−1 compounds artifacts on every
generation, while every beat referencing the same hero beat does not.

**Ref2VA / FL2VA toggle.** A single switch picks the checkpoint: off (default) is Ref2VA —
reference images, and optionally a reference video and voice clip, feed the model — for
anything with dialogue; on is FL2VA — first-frame/last-frame interpolation for action and
B-roll only. The switch is lazy, so only the selected 19.5 GB checkpoint is ever loaded, which
is how both fit in one graph. FL2VA has no reference-audio path, so it re-rolls the speaker on
every beat — never use it for a beat with dialogue.

**No turbo LoRA.** The 4-step turbo LoRA is about 2.5x faster but clips and noises the audio
path, which is this template's headline feature, so it is not installed and full-step (20-step)
sampling is the only shipped path — H3's built-in 12-video / 3-audio sigma-shift defaults, which
the official templates rely on, apply. The how-to note says how to add the LoRA by hand
(download into `models/loras/`, add a `LoraLoaderModelOnly` after the model switch inside the
subgraph, `steps` 8) for roughly 2.5x speed at a real cost in audio quality.

**Size.** Default is **672×1184 at 0.8 MP / 9:16, 24 fps**, 12 s beats (5–15 s range). A 1.0 MP
setting is available, capping at H3's native 768×1344 — the model's 768 px short edge is the
ceiling at 1.0 MP, not at the 0.8 MP default. MiniMax's 2K mode (hosted `H3-Regenerate-2K`) is
absent from the open-weights release, so there is no 2K path here.

Pick a persistent-storage bucket on launch: it holds ComfyUI's whole base directory, and
without one the roughly 59 GB of weights (two 19.5 GB checkpoints, a 14.6 GB text encoder,
video and audio VAEs) re-downloads every launch and is discarded on stop; with
a bucket selected, beat and reel clips land in the bucket root where the storage API's
`listFiles` can see them.

## The shared bootstrap (`comfyui-ugc-bootstrap.sh`)

All three templates inline this script via `commandFile`. It runs ComfyUI from the image's
read-only bundle with `--base-directory` pointed at the bucket, bypassing the image entrypoint,
which writes to `/root/ComfyUI` and fails wherever the container is not uid 0.

The workflow arrives as userData (`COMFY_WORKFLOW_ID` + gzipped `COMFY_WORKFLOW`) and is
installed at `custom_nodes/<id>/example_workflows/<id>.json`, which ComfyUI serves at
`/api/workflow_templates/<id>/<id>.json` — so `?template=<id>&source=<id>` deep-links it.
`source` must name the module; `source=all` only searches ComfyUI's own templates. It is also
copied into `user/default/workflows/` so it appears in the Workflows sidebar. For a template
with more than one `workflows[]` entry, `COMFY_WORKFLOW_ID` — and so the weight download and
the deep link — always comes from the first entry that carries a `graph`, so that entry must
stay first.

Weights are not listed here: the script downloads the HuggingFace URLs carried by the installed
graph itself, so each template fetches only what it loads and a new workflow needs no change
here. Each URL is routed into the matching `models/` subdirectory by pattern-matching its path —
`checkpoints`, `text_encoders`, `loras`, `latent_upscale_models`, plus `diffusion_models` and
`vae` for the MiniMax H3 template's weights. A bare `*[Ll]ora*` arm sits just before the
catch-all default of `checkpoints`, because a LoRA is not always published under a `/loras/`
path — the MiniMax H3 turbo LoRA, for instance, sits at its repo root, and without that arm it
would land in `checkpoints` and its loader node would show red. No template ships that LoRA
today; the arm is what lets you add one to a graph without touching this script. A template's
`envVars` cannot drive this —
nothing merges them into a service container (`SERVICE_START` has no template id; the container
env comes only from `userData`).

Custom nodes follow the same graph-driven rule. The script installs
[TTS-Audio-Suite](https://github.com/diodiogod/TTS-Audio-Suite) — for the assemble workflow's
voice conversion — only when an installed graph mentions `UnifiedVoiceChangerNode`. The grep
covers *every* workflow the template installs, not just the deep-linked one, so
`ltx-video-ugc-multishot` pays for the install on account of its assemble workflow even though
its generator never mentions the node. `ltx-video-ugc-product` skips it because it ships one
workflow that has no voice conversion, and `minimax-h3-video-ugc-multishot` skips it because
H3 generates the voice natively and its assemble workflow is a plain stitcher. The clone lands
in the bucket's `custom_nodes`, but pip
installs into the container and is lost on stop, hence the unconditional reinstall on every
launch; it is cheap because `XDG_CACHE_HOME` puts pip's wheel cache in the bucket too. It
installs into the container's own site-packages rather than `--target` + `PYTHONPATH`: a
second `numpy`/`torch` ahead of the container's would break ComfyUI itself. Every step is
non-fatal — escrow is already claimed by then, and the video workflows need none of it.

### `automatic1111.json` — Stable Diffusion WebUI (A1111) (GPU)

The classic AUTOMATIC1111 UI (`universonic/stable-diffusion-webui`). The image entrypoint
forwards `command` args to `webui.sh`, so the template sets `command` to
`["--listen","--port","7860","--data-dir","/app/data"]` (last `--port` wins over the
image's baked-in default), binding `0.0.0.0:7860`. Optional `HF_TOKEN` / `CIVITAI_TOKEN`.
~8 GB VRAM for SDXL.

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
_per-process_ fraction of the GPU (default **0.9**). Each instance assumes it owns that
slice and knows nothing about other processes. Two instances with defaults means
0.9 + 0.9 of the same GPU → the second one OOMs during KV-cache allocation. There is no
cross-instance coordination, negotiation, or dynamic rebalancing — the split is static
for the life of the process.

When running multiple models on one GPU, the template (or operator) is responsible for
three things:

1. **Fractions that sum below 1.0** — and not just barely: the CUDA context
   (~250–500 MB per process) and allocator fragmentation live _outside_ vLLM's
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
