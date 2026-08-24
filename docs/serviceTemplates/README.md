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
(open-weights, int8) — and a different unit of work: **one Run produces ~30 s with six shots and
one consistent character**, versus LTX's one continuous take per Run. Needs a CUDA GPU; see
**Hardware** below — it is built for one 80 GB+ card (H200/H100 class), which holds the whole
chain resident, and 24 GB still runs it at a lower resolution. Ships three workflows:

- `workflows/ocean_h3_ugc_multishot.json` — one Run, two chained beats, ~30 s out.
- `workflows/ocean_h3_ugc_assemble.json` — concatenates up to 8 rendered clips into one reel.
- `workflows/ocean_h3_ugc_prompts.json` — writes the four prompt boxes from your photos and a brief.

**Native audio, no voice-conversion pass.** H3 generates voice, room tone and music in the
same forward pass as the video, so there is no separate TTS step and nothing analogous to the
LTX templates' `UnifiedVoiceChangerNode` pass. The bootstrap's TTS-Audio-Suite install is gated
on the installed graph containing `UnifiedVoiceChangerNode`; this workflow never does, so the
install never runs for this template — no custom node pack rides along.

**Two chained stages, not two Runs.** H3 caps at 15 s per generation, so 30 s needs two passes.
The graph chains them. Beat 1 is **FL2VA**, the only mode whose `first_frame` literally becomes
frame 0, so the user's photo opens the video. Beat 2 is **Ref2VA**, the only mode that takes a
reference *video* — which is what carries face, wardrobe, room, camera style and voice into the
second half. Chaining beats two manual Runs because `ref_video_0` is typed `IMAGE` and
`ref_video_audio_0` is `AUDIO`: beat 1's `VAEDecode` / `VAEDecodeAudio` feed beat 2 **directly**,
with no file, no re-encode and strictly higher fidelity than referencing a saved MP4. ComfyUI
caches by input hash, so once beat 1 is good, editing only beat 2's text leaves beat 1's subtree
untouched and it is not recomputed.

H3 truncates an over-long reference batch **from the start** (`frames[:frame_count]`), so a raw
pass-through would reference beat 1's opening rather than its end. Beat 2 slices the tail
explicitly: `GetImageSize` → `ComfyMathExpression("a - 72")` → `ImageFromBatch(length 72)` for
the frames, and `TrimAudioDuration(start_index -3, duration 3)` for the audio. 72 frames is 3 s
at 24 fps, inside H3's documented 2–15 s reference window and far cheaper than referencing all
362 — reference tokens ride every sampling step. Both values are derived rather than pinned
(the frame index from the actual batch size, the audio offset from the end of the clip), so
changing the duration widget cannot break the slice.

**The seam is a hard cut.** 15 s is the model's ceiling per pass and no wiring changes that.
Beat 2 is a new generation that *references* beat 1, not a continuation of the same take, so the
join at 00:15 is a hard cut — same person, same room, same voice, new camera setup. The how-to
note says to write beat 2 as a deliberate cut, which reads as editing rather than as a glitch.

**One boolean, and it really does skip beat 2.** `Second beat — 30 s total` drives two
`ComfySwitchNode`s (video and audio) plus the last-frame picker. `ComfySwitchNode` is **lazy**,
so `false` means the `ImageBatch` / `AudioConcat` branch never evaluates and **beat 2 never runs
at all** — no ref2va checkpoint loaded, no second sampling pass. That is the fast-iteration
path: a 15 s beat in about half the time. The `SaveImage` last-frame output hangs off the
*switched* stream for the same reason; wiring it straight to beat 2 would make it an output
dependency and force the second pass even with the boolean off.

**Four prompt boxes, one per contract.** H3 mandates this section order:

    subject_definitions → summary → retention_analysis →
    detailed_description → overall_soundscape → non_diegetic_music

but the two modes do not take the same sections, so the boxes split by *stage* as well as by
set-once/per-beat:

| Box | When | Sections | Used by |
|---|---|---|---|
| **A · Cast & references** | set once | `subject_definitions` | beat 2 |
| **B · Beat 1** | per beat | `integrated_multimodal_description` | beat 1 |
| **C · Beat 2** | per beat | `summary`, `retention_analysis`, `detailed_description` | beat 2 |
| **D · Audio & music** | set once | `overall_soundscape`, `non_diegetic_music` | both |

Two `StringFormat` nodes join them, one per stage, each a pure join because every section label
is already written literally in its box. Beat 1's `f_string` bakes in the base guide's fixed
I2VA instruction line (`For the target video, at 0.00 seconds …`), which is constant and so gets
no box, then `{a}` = B and `{b}` = D. Beat 2's is `{a}\n\n{b}\n\n{c}` = A, C, D, which lands all
six sections in the mandated order. `retention_analysis` is the section actually holding the
character's face steady; it names the chained tail as `<Video 1>` and never uses `(Sx)`, which
the guide forbids in that section.

The shipped seed is a worked skincare-UGC example. Box B's and box C's **bodies are 350–500
words each** — that range is the guide's figure for the body field
(`integrated_multimodal_description` / `detailed_description`), not for the whole prompt, and an
under-written body is the main cause of identity drift. Each body opens `Live-action, cinematic`
and carries three timecoded shots: `[Shot 1]` with no timestamp, then `[Shot 2] At 00:05.000,`
and `[Shot 3] At 00:10.000,`. Camera moves use the closed vocabulary — motion type + amplitude +
speed, with medium amplitude and normal speed left unstated.

**The prompt writer is a second model, and it has to be.** The obvious move — reuse the
14.6 GB Qwen3-VL-32B already on disk as H3's text encoder — does not work.
`comfy/text_encoders/llama.py`'s `Qwen3VL_32BConfig` is explicit: the H3 conditioning
checkpoint is *"truncated to the first 50 of 64 layers, consumed as the unnormalized hidden
state after layer 50 (no final norm, no lm_head)"*. `BaseGenerate.logits` would fall back to
`embed_tokens` and emit noise rather than raise, and `minimax.py` further documents that the
H3 presentation is not chat-templated at all. Nor is a full-size 32B an option:
`detect_te_model` routes every 32B state dict to that same truncated path.

So the generator loads its own encoder — `qwen3vl_8b_bf16.safetensors` (17.5 GB,
Comfy-Org/Qwen3-VL), a full Qwen3-VL-8B — through a plain `CLIPLoader` typed
`stable_diffusion`. The type matters: `ideogram4`, `boogu`, `krea2`, `mage`, `joyimage`,
`flux` and `flux2` each hijack a Qwen3-VL-8B file into an image-model conditioning path.
Core's generic `TextGenerate` node drives it; `Qwen3VLClipModel.generate` is overridden to
carry vision positions and deepstack features, so the photos genuinely ground the writing.

**One vision pass per photo.** `TextGenerate` takes a single `image`, so two photos would
have to go through core `ImageBatch` — which rescales image 2 to image 1's dimensions and
would squash a wide product shot into the subject portrait's aspect. Each photo gets its own
pass instead, and a `StringFormat` joins the two paragraphs into `subject_definitions`. The
product pass sits behind a `ComfySwitchNode` against an empty string primitive, driven by a
`Product photo` boolean; the switch is lazy, so off means that pass never runs. The README
notes elsewhere that this trick is not buildable for IMAGE/AUDIO because core cannot
synthesize an empty one — for STRING it is a one-node primitive.

Both `LoadImage` nodes reuse the filenames the multishot workflow already causes the
bootstrap to seed, so the generator Runs out of the box with nothing uploaded.

**Two subgraphs, 31 canvas nodes.** Everything that is plumbing rather than a decision lives in
`Beat 1 · FL2VA (starts from your photo)` and `Beat 2 · Ref2VA (carries the character forward)`.
Each holds its own `UNETLoader`, `CLIPLoader`, both `VAELoader`s, three bypassed device-placement
nodes on those loaders (see **Hardware**), its H3 conditioning node, the sampler chain and the
decoders; beat 2 adds the tail slicer and the final-frame extractor. The
loaders are duplicated on purpose — ComfyUI caches loaded models by filename, so the duplicates
cost no VRAM and each stage stays self-contained. The canvas itself is the four prompt boxes,
the reference loaders, the shared `Controls` panel, the two instances, the boolean and its
switches, `CreateVideo` / `SaveVideo` / `SaveImage`.

**One control panel, both beats.** Resolution, beat length, steps and seed are single canvas
nodes wired into `width` / `height` / `length` boundary inputs on both subgraph instances, into
both `BasicScheduler.steps` and into both `RandomNoise.noise_seed`. They used to be duplicated
inside each subgraph and promoted twice, which was a real bug rather than clutter: nothing kept
the two `ResolutionSelector`s in step, and if they disagreed the joining `ImageBatch` (core,
`image1` + `image2`) rescaled beat 2 to beat 1's dimensions — silent quality loss, no error.
Duration had the same shape of problem, two `PrimitiveFloat`s feeding two frame-grid
expressions. One seed for both stages is correct, not a collision: the stages take different
prompts and different conditioning, so they never render the same clip, and a single seed makes
a whole Run reproducible while you iterate. `ref_image_size` is the only widget still promoted
onto an instance (beat 2's), because it is genuinely stage-2-specific — beat 1's `proxyWidgets`
is now `[]`.

**References ship bypassed, and that is safe.** Only `<Picture 1>` (the subject) is active — it
is frame 0 of beat 1 *and* reference image 0 of beat 2, so one photo decides the face.
`<Picture 2>` (product), `<Picture 3>` (location), `<Video 2>` (style/motion) and `<Audio 1>`
(voice lock) are `mode: 4`. All four reference autogrows are `min: 0`, so an unwired socket is
natively valid and needs no guard. They are stacked in one column under the group
`Optional references — select a node and press Ctrl+B to toggle`, with `<Picture 1>` in its own
`Subject — required` group above them so it never reads as optional. Real on/off switches are
not buildable here with core nodes: `ComfySwitchNode` requires **both** `on_false` and `on_true`
(both `required` `COMFY_MATCHTYPE_V3`) and there is no core way to synthesize an empty
IMAGE/AUDIO for the off branch, while `ComfySoftSwitchNode`, which does take optional branches,
is absent from ComfyUI 0.32.0. Feeding a blank or 1×1 image would be worse than bypass — the
model would take it as a real reference. So bypass stays the mechanism and the group title says
so. The external video is `<Video 2>`, not `<Video 1>`, because
`ref_video_0` is reserved for the automatic chain — tags follow connection order and the node
titles match what the user types in the prompt. H3's limits across all of them: **≤9 images ·
≤3 videos (2–15 s each, ≤15 s total) · ≤3 audio · ≤12 files total.**

**No turbo LoRA.** The 4-step turbo LoRA is about 2.5x faster but clips and noises the audio
path, which is this template's headline feature, so it is not installed and full-step (20-step)
sampling is the only shipped path — H3's built-in 12-video / 3-audio sigma-shift defaults, which
the official templates rely on, apply.

**Sampling and size.** `res_multistep` at 20 steps with the **`beta`** scheduler — Comfy's own
R2V note is that beta and normal outperform simple on reference-heavy prompts, which both beats
are by design. `ref_image_size` is `max`, because UGC lives on face and product-label fidelity.
Default size is **608x1056 at 0.6 MP / 9:16, 24 fps** — chosen so the first Run finishes
quickly; 0.97 MP gives 768x1344, 15 s per beat, which the frame-grid
expression lands on length 362 — the top of H3's trained 124–362 range. 0.97 rather than 1.0
because the node's formula (`round(ratio * sqrt(mp*1024*1024/(w*h)) / 32) * 32`) turns 1.0 MP
into 768x1376, one 32 px step past H3's documented 768x1344 cap; 0.97 lands on the cap exactly.
Steps ship at 15, the practical floor below which quality drops noticeably, with 20 for a final
render. Sampling cost is dominated by latent tokens — `(w/16) * (h/16) * video_latent_t`, 431,424
at this size — and attention is quadratic in them, so shorter beats and lower megapixels are the
two levers that actually move the clock.

**fps is a model constant, not a setting.** `CreateVideo.fps` is a required FLOAT whose ComfyUI
default is 30.0, but H3 generates at exactly 24 and the frame-grid expression already hard-codes
`a * 24`, so a wrong value desyncs audio from picture. The node ships at 24 and is titled
`Join beats — 24 fps (H3 is fixed at 24, do not change)` rather than promoted into the control
panel, and the how-to note repeats the sentence.

**Hardware.** Weights total 76.6 GB — 59.1 GB of H3 (19.5 + 19.5 + 14.6 + 4.9 + 0.6) plus the
17.5 GB prompt-writer encoder — and the chained design loads both checkpoints per Run, so one
80 GB+ card — an H200 at 141 GB, or an H100 — holds the whole chain resident and offloads
nothing, which is what the native-canvas default assumes. `--highvram` still engages at this
total: 76.6 × 3/2 = 114.9 GB against an H200's 141 GB. 24 GB still works at 0.4 MP but
offloads heavily and swaps checkpoints mid-Run. GPU class matters directly
here and CPU cores do not — sampling is GPU-bound — which is why the `gpu` resource carries the
guidance in its `description` (`gpu` is a discrete count, not a size, and `ServiceTemplateSchema`
is `.strict()`, so there is no VRAM field to invent). `ram` is `min` 128 / `recommended` 256 GB:
weights stream through host memory on every load, and `--highvram` trades host RAM for keeping
them on the card.

**`CLI_ARGS`.** The bootstrap's last line already ends `… --port 8188 ${CLI_ARGS:-}`, but
template `envVars` never reach a service container — only `userConfigurableEnvVars` do, through
`userData` — `--highvram` is applied automatically: before `exec`, the script reads the card's total VRAM from
`nvidia-smi` and `du -sm` of the models directory, and adds the flag when VRAM covers the weights
with 3/2 headroom (an H200 with the template's 76.6 GB weight set qualifies; a 48 GB card
does not). It logs the decision. The template deliberately exposes no flag input: that decision needs the card and the weight set,
both of which the script can see and the launching user cannot. The shared `${CLI_ARGS:-...}` hook
stays in the script for operators who copy it, but no template declares the variable.

**One GPU is booked on purpose.** `gpu` is `min` 1 / `recommended` 1, and the dashboard books
`recommended` floored at `min`, so a launch takes exactly one card. Asking for two would bill a
second device that this workflow leaves idle. Core
ComfyUI has no tensor parallelism: one sampling pass runs on one device. Its CFG-split node
(`MultiGPU_WorkUnits`) distributes *conditionings*, and H3 is CFG-distilled, so `BasicGuider`
hands it a single conditioning and the second device gets nothing. Beats cannot be split either,
since beat 2 consumes beat 1's frames. What multi-GPU core ComfyUI does have is *placement*, so
each subgraph carries a `SelectCLIPDevice` and two `SelectVAEDevice` nodes (core,
`comfy_extras.nodes_multigpu`) wired as passthroughs on the text-encoder and VAE loaders. They
ship `mode: 4` on `default`, which is a plain passthrough, so today the graph behaves exactly as
it did without them. They earn their place on something like 2×24 GB: un-bypass the text-encoder
one and set it to `gpu:1` and the 14.6 GB encoder stops evicting the diffusion model. `default`
is hard-coded rather than `gpu:1` because `gpu:1` only appears in the combo options on a machine
that actually has two cards, and a value absent from the options makes the graph invalid. Using
them means raising `recommended` on the `gpu` resource to 2 in your copy of the manifest — the
booked count is pinned by the template, not chosen at launch.

**A third or fourth beat needs no new wiring.** With the memory ceiling gone, run the multishot
workflow again with the emitted `lastframe_….png` loaded into `<Picture 1>`, then concatenate the
beats in the `Assemble reel` workflow. Building a third stage into the graph would triple the
prompt boxes for something the two-beat chain plus a re-run already does.

Pick a persistent-storage bucket on launch: it holds ComfyUI's whole base directory, and
without one the roughly 77 GB of weights (two 19.5 GB checkpoints, a 14.6 GB text encoder,
video and audio VAEs, plus the 17.5 GB prompt-writer encoder) re-downloads every launch and is
discarded on stop; with a bucket selected, beat and reel clips land in the bucket root where
the storage API's `listFiles` can see them.

### `ltx-2.5-video-ugc-multishot.json` — ComfyUI, LTX-2.5 multishot UGC reel (GPU)

One Run renders the whole reel. LTX-2.5 cuts between shots inside a single generation and
holds character, wardrobe, room, lighting and voice across those cuts, which retires the
shot-at-a-time chaining the 2.3 template needs and the voice-conversion pass that fixed its
drifting speaker.

**Multishot is a prompt format, not a node.** There is no multishot node and no multishot
example workflow upstream. You write the reel as one chronological prose paragraph and mark
each cut in words — "A hard cut transitions to a medium close-up of her face" — restating the
character's look and the audio's continuity at every cut. LTX's guidance is 2-4 shots per
generation. One prompt box holds the whole paragraph: open with the cast and the look, then
the shots.

**Requires `HF_TOKEN`.** Every LTX-2.5 weight is gated. Open each model page once, click
"Agree and Access" with the account owning the token, then set `HF_TOKEN` on the service.
Without it nothing downloads and ComfyUI starts empty.

**Settings track Lightricks' own operating point**, which is what quality depends on here.
`ltx-pipelines`' `DistilledPipeline` defaults to 121 frames (5 s at 24 fps) at stage-1
768x512, with sigma schedules of 8 steps then 3; their ComfyUI API template ships 8 s. This
template ships **8 s / 193 frames**, stage 1 at 576x1024 upscaled to 1152x2048, which is
2.3x the official token count — enough headroom for a 9:16 frame, and 1152x2048 still clears
1080x1920 delivery.

It did not always. Until this was corrected it ran 481 frames (20 s) at stage-1 768x1344 into
1536x2688 — 10x the official token count on the *same* 8-plus-3 steps, because raising
duration and resolution spreads a fixed step budget thinner rather than adding steps. That is
why it looked worse than `ltx-video-ugc-multishot.json`: the 2.3 template renders 97-frame
clips and chains them, landing almost exactly on the official default. The stage-2 schedule
had also drifted to `0.85, 0.7250, 0.4219, 0.0`; the published values are
`0.909375, 0.725, 0.421875, 0.0`. For a longer reel, render two Runs and join them rather
than stretching one.

**Five weight files, ~71 GB, bf16 throughout**: 42.02 GB transformer + 26.26 GB text encoder
+ 1.47 GB video VAE + 0.36 GB audio VAE + 1.00 GB spatial upscaler. Deliberately absent: the
prompt enhancer (it flattens the cuts that make a paragraph multishot, and its encoder is
another 10.28 GB), the duration head (no ComfyUI node exists — it is a `ltx-pipelines` CLI
flag), and the temporal upscaler (unused by the graph). The enhancer is *deleted* rather than
bypassed because ComfyUI validates combo widgets across the whole reachable graph, so a
bypassed branch would still force its weights to download.

Wants an H200-class card: the weights alone are ~71 GB, and the launch script adds
`--highvram` only when VRAM covers them with 3/2 headroom (~107 GB), which an H200 clears and
an 80 GB H100 does not. On the H100 ComfyUI offloads between stages instead of failing —
slower, not broken. Ask for one GPU and not two: the two stages run sequentially and the
distilled model is CFG=1, so the CFG-split node has a single conditioning and nothing to hand
a second device, and core ComfyUI has no tensor parallelism.

Pick a persistent-storage bucket on launch: it holds ComfyUI's whole base directory, so the
~71 GB of weights downloads once instead of on every launch, and finished reels land in the
bucket root where the storage API's `listFiles` can see them.

### `minimax-music3.json` — ComfyUI, MiniMax Music 3 text-to-music (GPU)

Same image, bucket behavior and bootstrap as the video templates, but audio out: a caption plus
lyrics become a complete 32 kHz stereo song — vocals and arrangement generated together in one
pass — up to about 5 minutes. One workflow, `workflows/ocean_music3_song.json`, adapted from
Comfy-Org's own `audio_minimax_music_3` template. Needs a CUDA GPU with 24 GB+ VRAM.

**Two boxes, two different jobs.** The **caption** is the entire sound and takes three sections
in a fixed order — `Global Metadata:` (genre, BPM, key, mood, use case, production texture),
`Vocal Details:` (voice type, delivery, harmonies), `Arrangement:` (instruments, and what happens
across intro / verses / instrumentals / bridge / outro). Specific beats poetic: "78 BPM, D flat
major, jazzy extensions" lands where "dreamy" alone does not, which is why the shipped lo-fi
hip-hop caption is a worked example meant to be edited rather than an empty box. The **lyrics**
box carries the words plus `[Intro]` `[Verse]` `[Chorus]` `[Bridge]` `[Instrumental]` `[Outro]`
tags, and **those tags are the only structural instruction the model executes** — the lyric text
itself only conveys mood. An `[Instrumental]` tag with nothing under it is how you get a stretch
with no singing.

**Dials.** `max_duration` ships at 60 s so the first Run finishes quickly; the model supports up
to ~300 s and may end a song early on its own, and longer costs both time and VRAM. Tiled audio
VAE decode ships **on** — it decodes in overlapping tiles and is what keeps a long song's decode
inside a 24 GB card, at a small risk of a seam at a tile boundary; turn it off on a big card for
the last of the quality. The seed is fixed per take, so the same caption and lyrics with a new
seed is a new performance rather than a variation on the old one. `cfg_scale` / `top_k` sit
inside the subgraph as advanced inputs.

**Weights are 14.3 GB** — `minimax_music3_dit_fp16` (4.9 GB), the pruned int8 text encoder
(9.2 GB) and the DAV audio VAE (0.2 GB) — small enough that the bootstrap's 3/2 rule adds
`--highvram` on anything from 24 GB up. The three loader nodes carry their own HuggingFace URLs,
so the script fetches exactly what the graph loads. Comfy-Org also publishes
`minimax_music3_dit_int8_convrot.safetensors` (2.5 GB) for lower-VRAM cards; the workflow's model
note names it but deliberately does **not** link it, because the URL scan would then download
2.5 GB this graph never loads.

Songs save to the bucket root as `song_00001_.mp3`, `song_00002_.mp3` — the prefix is `song`
rather than Comfy's default `audio/audio_minimax_music3` precisely because that default writes
into a subfolder, where the storage API's `listFiles` (top-level files only) would not see them.
The save counter never overwrites, so every take is kept.

Not to be confused with running the upstream checkpoint directly: `MiniMaxAI/MiniMax-Music3` is a
modular diffusion pipeline whose `model_type` (`minimax_music3`, library `sglang-omni`)
Transformers does not recognise, so vLLM exits at config parse and `vllm-hf-model.json` cannot
serve it. Comfy-Org's repackaging of the same weights is what runs here.

### `minimax-h3-allinone.json` — ComfyUI, ALL in ONE MiniMax H3 (GPU)

The same H3 weights as `minimax-h3-video-ugc-multishot.json`, but no graph: the canvas holds a
single node — [ALL in ONE MiniMaxH3](https://github.com/LeonQ8/ComfyUI-ALLinONE-MinimaxH3) — whose
own UI assembles the real H3 workflow and queues it. Pick a mode in the tab bar, fill the boxes,
press **Generate**. One workflow, `workflows/ocean_h3_allinone.json`, carrying that node and two
notes. Needs a CUDA GPU; 48 GB+ is comfortable, 24 GB runs the lower resolution presets.

**Five modes run here.** T2V (text to video with native voice, room tone and music in one forward
pass), I2V (animate a start frame, optionally morphing to an end frame), R2V (reference images,
video or audio drive the clip), Extend (continue an existing clip) and Chain (multi-clip
continuation through H3 Motion Context, which hands the latent path forward rather than re-encoding
a file).

**What the node cannot run is taken out of its interface, not left greyed out.** The bootstrap
edits the pack's own `web/one_node_minimax_h3.js` on every launch and removes the **Image**,
**Audio Drive** and **Keyframes** tabs, the **Upscale** button and its factor / method pickers, the
**Live Preview** toggle, the **Sampler** and **Scheduler** dropdowns and their recipe chips, the
accelerator chips, and the Turbo / Speed / High Quality presets — plus the Settings rows that only
fed them (TAE decoder, the two upscale models, the upscale method, the Speed LoRA). Image mode
makes stills, not video — I2V is the image-to-video one — and its two Qwen3.5 prompt models are
12.9 GB a video bundle has no other use for. Audio Drive needs `comfyui-vrgamedevgirl`, which pulls
demucs, voxcpm and a llama-cpp-python that compiles on every launch. Keyframes is dropped to keep
the tab bar to the modes this template is for; the Motion Context fork stays, because Extend and
Chain still use it. SeedVR2 downloads its own weights mid-run and RTX Video Super Resolution wants
a consumer RTX card that a data-centre GPU is not. H3 has one native sampler pair (`res_multistep`
/ `simple`), so the pickers only offered ways to make output worse.

**Why the JS and not the config.** `config.json` carries a `quality_presets` key, and it is read by
nothing: the presets, the mode tabs, the sampler lists and every button above are hardcoded in the
node's JavaScript. An earlier version of this bootstrap deleted `speed` and `high` from that config
key and both presets stayed in the dropdown regardless. The edit list is a table of exact
(old, new) string pairs applied once each, so a pack release that moves any of them fails the match
and prints an `[ocean]` line naming what is back on screen instead of writing a half-patched file.
The clone is `reset --hard` on each launch, so the edits re-apply from clean every time, and they
are idempotent within a launch. Saved state is repaired in the same pass: a bucket whose last
session ended in Image mode, or on the Turbo preset, opens on T2V and Balanced rather than on a tab
that no longer exists.

**Three packs.** The bootstrap clones the ALL-in-ONE node itself,
[H3-Motion-Context-MultiRef](https://github.com/seitanism/ComfyUI-H3-Motion-Context-MultiRef) for
extend / chain, and [SolAttn_triton](https://github.com/kijai/ComfyUI-SolAttn_triton) for the
Balanced preset. All three are pure Python, so the clone is the whole install and this template has
no pip step at all — KJNodes went out with the Live Preview toggle and the Turbo pack with the
Turbo preset. Neither remaining extra is optional polish: Quality defaults to Balanced, which *is*
SolAttn, and Chain and Extend are Motion Context. Without them the first Generate reports a missing
node on a card the consumer is already paying for.

**One pack is deliberately absent, and actively removed.** The pack's own `COMPATIBILITY.md` — read
it before adding any of these, it is the file that documents exactly this class of breakage —
records that ComfyUI core dropped `time_shift_slope` on 2026-08-06 (PR #15243) while
`ComfyUI-MiniMaxH3-Cache` still calls it. Its HEAD is `8a45e09`, unchanged since 2026-08-03, and its
fix (PR #6) is still open. Because it patches the diffusion model at import, having it installed
fails **every** generation with
`module 'comfy.ldm.minimax.model' has no attribute 'time_shift_slope'` — not only the Speed preset
that wants it. So it is not cloned, and the bootstrap deletes it from the bucket if an earlier
launch left it there, guarded on the broken call so a fixed copy survives.

**Presets that lost their accelerator are removed, not degraded.** Speed (H3 Cache) and High Quality
(SageAttention, whose kernels are absent from this image and surface as a NoneType with a
`qk_int8_sv_f8_...` attribute) are cut from the preset table and the dropdown, along with Turbo,
whose distillation LoRA this template no longer downloads. Left in place they would be a slower
Balanced and a slower Native under names promising the opposite, and one wrong click costs a paid
Run. Nothing is lost on output: SolAttn and Sage are quantized-attention throughput trades, not
quality knobs. What ships is Balanced and Native, and the accelerator chips go with the presets —
two of the three switched on packs that are not installed, so the dropdown is now the whole
control.

**Both config layers are repaired, not just the pack's.** Two config keys *are* read at runtime —
`prompt_templates` (the Discover tab) and `resolution_presets` — and `_load_config()` does
`merged.update(user)`, a top-level replace, so a consumer who has touched either setting has a saved
`user/default/one-node-minimax-h3/config.json` that shadows the pack's entirely. The script walks
both layers, using `.get()` and never `setdefault`: creating a key in the user layer would make that
partial dict replace the built-in one wholesale and take the unet/vae filenames or the landscape
resolutions with it. It drops the Discover templates for the three removed modes and appends five
vertical resolution presets (352x608, 480x864, 544x960, 576x1024 exact 9:16, 768x1344 — all axes on
a multiple of 32, flipped from the pack's own validated shapes). Idempotent: a second launch prints
nothing.

**R2V is unverified, not known-broken.** `COMPATIBILITY.md` reports a core shape-mismatch on H3
reference video (`all_video_rows[~img_update] = cond_video_rows`) fixed by commit `e01fb4c` on
2026-08-13. Whether the `v0.33.1` tag this image ships contains it could not be established: the
commit lands two hours *before* the release, yet the tag's `comfy/ldm/minimax/model.py` is not that
commit's file — GitHub reports the two refs as diverged, and the tag carries a `frame_count`
parameter `e01fb4c` lacks while missing a helper `e01fb4c` adds. So treat R2V as untested here;
T2V and I2V are unaffected either way. The probe below will not catch this one — it is a tensor
shape, not a missing name. Re-check that section of `COMPATIBILITY.md` whenever `tag` moves.

**A launch-time probe guards the rest of this class.** All of these packs work by monkey-patching
`comfy.ldm.minimax.model`, so any core release that renames or drops a name breaks them at sampling
time — after the consumer paid for the GPU and sat through a 59 GB launch. After the clones, the
bootstrap parses that core module with `ast`, collects every top-level name it defines (imports
included, since packs reach through `minimax_model.comfy`), and greps the installed packs for names
they access on it. Anything missing is named on stdout as an `[ocean]` line before ComfyUI starts.
Run against ComfyUI 0.33.1 it flags exactly one thing — `MiniMaxH3-Cache` calling `time_shift_slope`
— and clears MultiRef and SolAttn, which reference only `time_shift_sigma`, `VISUAL_COND_TIMESTEP`
and `AUDIO_COND_TIMESTEP`. It checks names only: a changed signature or a changed tensor shape (the
R2V case above) passes it silently.

**Weights are 59.1 GB** — both diffusion models (FL2VA and Ref2VA, 19.5 GB each, because the mode
tabs switch between them freely and only one is resident per generation), the 14.6 GB Qwen3-VL-32B
text encoder and 5.5 GB of video and audio VAEs. Five URLs, and this is the one template whose URLs
are **not** carried by loader nodes, because the graph has none — they sit in the workflow's model
note instead, which the bootstrap's scan reads exactly the same way, and the filenames match the
pack's `model_defaults` so the node finds them with no configuration. The 9.3 MB TAE live-preview
decoder and the 0.73 GB Turbo LoRA were the sixth and seventh; both left with the controls that
used them, which is 0.74 GB and the download loop's only use so far of its bare `*[Ll]ora*` and
`*/vae_approx/*` arms. Those arms stay in the shared loop for the next template that needs them.

**Output prefixes are flattened at install time.** Every graph template in the pack saves under
`one-node-minimax-h3/`, a subfolder the storage API's `listFiles` (top-level files only) would not
see — the same problem `minimax-music3` solves by saving as `song`. Here the bootstrap `sed`s the
prefix out of the pack's `workflows/*.json` after cloning, so clips land in the bucket root as
`h3_00001_.mp4`. It is idempotent, and Chain is the exception: its prefix is built in the pack's
JavaScript at queue time, so chained clips stay under `chain/<session>/` and have to be pulled from
the node's Library tab before the service stops.

**Prompts** take three labelled sections in order — `integrated_multimodal_description`,
`overall_soundscape`, `non_diegetic_music` — with dialogue inline as
`(S1) <character> speaks: <d>[English] line</d>`. The node's Discover tab ships fill-in templates
per mode, so none of that has to be memorised. History, favourites and settings are written to
`user/default/` inside the bucket and come back on the next launch with the same bucket.

### `ecommerce-studio.json` — ComfyUI, e-commerce studio (GPU)

Five workflows that turn one product photo into the asset set a listing needs. Pick one in the
tab bar, upload a photo, press Queue.

| Workflow | Upload | Get back |
| --- | --- | --- |
| `ocean_ecom_background` | packshot on a plain background | the product in a generated scene, `ecom_background_00001_.png` |
| `ocean_ecom_relight` | product + a photo whose lighting you want | the product re-lit to match, `ecom_relight_00001_.png` |
| `ocean_ecom_multiview` | one photo | a full 360: 7 steps at 45 degrees, a close-up, and a loop `ecom_turntable_00001_.webp` |
| `ocean_ecom_creative` | product photo + a headline in the prompt | an ad poster with your headline written around the product, `ecom_creative_00001_.png` |
| `ocean_ecom_motion` | one photo + a description of the motion | `ecom_motion_00001_.mp4`, 9:16, up to 5 seconds |

**Why 2509 and not 2511.** The edit backbone is Qwen-Image-Edit **2509**, not the newer 2511,
because the four LoRAs this template uses — `White_to_Scene`, `Relight`, `Light-Migration`
and `Multiple-angles` — exist only for 2509. 2511 scores better on generic edit benchmarks
and has no product LoRAs.

**Why LTX-2.3 for Motion.** It is a 22B model, so it holds product detail and label text.
Small video models do not. It is also the same 43 GB weight set as `ltx-video-ugc-product`.
Launch with the bucket you already used for that template and the files are on disk. LTX-2.3
is not gated; LTX-2.5 is, which is why this uses 2.3.

**Weights — 74.9 GB.**

| | GB | used by |
| --- | ---: | --- |
| Qwen2.5-VL 7B text encoder (fp8) | 9.38 | the 4 image workflows |
| Qwen-Image VAE | 0.25 | 4 |
| Qwen-Image-Edit 2509 (fp8) | 20.43 | 4 |
| four product LoRAs + Lightning (bf16) | 1.81 | 4 |
| LTX-2.3 set (model, Gemma encoder, 2 LoRAs, upscaler) | 43.0 | motion |

**VRAM is not the disk number.** The image workflows hold one 20.4 GB backbone plus the
encoder — about 30 GB. Motion holds LTX-2.3 plus the Gemma encoder — about 40 GB. A 48 GB
card runs everything. A 24 GB card runs the image workflows only.

**Quality toggles.** Each edit workflow ships at 20 steps and cfg 4 with its Lightning LoRA
switched off. Turning the toggle on switches the model, the steps and the cfg together, to
4 steps at cfg 1.

**Every workflow here is a single-image edit, on purpose.** `White_to_Scene` puts one
packshot into a scene. `Light-Migration` and `Relight` re-light one image. `Multiple-angles`
turns the camera around one image. Creative writes a background and a headline around one
image. Qwen-Image-Edit 2509 was tested on a two-image composite — a generated poster in
`image1` and the product in `image2` — and it ignored the poster and returned the product.
Do not design a workflow here that needs two images composited.

**Relight has two modes, and the reference image can bleed.** It ships wired for
reference-image relighting via the Light-Migration LoRA. That LoRA's upstream template is
*Light Migration for Character Portrait*, and with a person in the reference it copied the
person into the output, not only the light. The fix is in the prompt, which now forbids
importing any person, object, background or shape from image 2. The seeded reference stays a
strongly lit photo, because that is what makes a reference useful: flat, even light migrates
almost nothing. Choose your reference for its light, not its subject.

The second mode has no reference image at all, so it cannot bleed: change the `lora_name`
widget to `Qwen-Image-Edit-2509-Relight.safetensors` and describe the light in words. That
LoRA is downloaded already — its URL travels in the workflow's note, which the bootstrap's
scanner picks up like any other — so the swap needs no new file.

Select a persistent-storage bucket on launch or the 74.9 GB downloads every time and the renders
are discarded on stop.

## The shared bootstrap (`comfyui-ugc-bootstrap.sh`)

Every ComfyUI bundle in this folder inlines this script via `commandFile`. It runs ComfyUI from the image's
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

Example inputs follow the same graph-driven idea as the weights. The seeder walks the installed
graph for `LoadImage` / `LoadAudio` / `LoadVideo` nodes and fills the input directory so the first
Queue works with no upload. It resolves each filename against, in order, a per-node
`properties.inputUrl` the graph carries itself, the installed `comfyui_workflow_templates` package,
and finally Comfy-Org's `input/` directory. `inputUrl` is https-only and the write path still comes
from the widget's basename, so a template can ship an asset from anywhere without widening where
bytes land; a failed fetch is non-fatal. Note some image CDNs reject a bare urllib request, so the
fetch identifies itself with a User-Agent.

Weights are not listed here: the script downloads the HuggingFace URLs carried by the installed
graph itself, so each template fetches only what it loads and a new workflow needs no change
here. Each URL is routed by the `directory` field that ComfyUI already writes into the graph's
`properties.models[]` entries — `checkpoints`, `text_encoders`, `loras`,
`latent_upscale_models`, `diffusion_models`, `vae`, `vae_approx`. The graph states where each
file belongs, so nothing has to be inferred from the URL.

Two things guard that. The value is a path segment under `$MODELS` and arrives from a
client-supplied graph, so it must match `[a-z0-9_]{1,32}` (with `fullmatch`, not an anchored
`match` — Python's `$` matches before a trailing newline, so `"loras\n"` would slip through);
a value that fails is refused with a warning to stderr and the URL falls back to the shape
guess. And the lookup key is normalised by stripping from the first `?` or `#`, because the
URL scanner's regex stops at `.safetensors` while `properties.models[].url` may carry a query
string — an unnormalised key missed `clip_l.safetensors?download=true` and routed it to
`checkpoints`, which is exactly the class of bug the `directory` field exists to eliminate.

The older path-pattern derivation survives only as the fallback for a URL with no
`properties.models[]` entry — a MarkdownNote documenting an optional LoRA, for instance, which
is how `ecommerce-studio` ships its Relight LoRA. Its bare `*[Ll]ora*` arm before the
`checkpoints` default is what routes such a URL correctly when a LoRA is not published under a
`/loras/` path. Because the fallback is now only ever reached without a declared directory,
`scripts/test-model-routing.sh` covers both paths, and `scripts/check-ecom-model-routing.py`
runs the real scanner over the real shipped graphs — a synthetic fixture that drifts from shipped data is
what let the `clip_l` misroute through in the first place. A template's `envVars` cannot drive
this —
nothing merges them into a service container (`SERVICE_START` has no template id; the container
env comes only from `userData`).

**Gated repositories.** `get()` and `remote_size()` both send
`Authorization: Bearer $HF_TOKEN` when `HF_TOKEN` is set. Both matter: without the header on
`remote_size()` a gated file reports no content-length, which silently downgrades the
integrity check from an exact byte-count match to the 10 MB floor, so a truncated download
would be cached and trusted. A 401 or 403 is reported with a message naming the "Agree and
Access" button rather than as a generic HTTP failure. Templates whose weights are ungated
(everything on LTX-2.3 and earlier) are unaffected and need no token.

**Model URLs come from every installed workflow, not just the deep-linked one.** The scan
walks all of `$PACK/example_workflows/*.json` and deduplicates, because a template can ship a
second workflow with weights of its own — the H3 prompt generator's text encoder is the first
case. Scanning only the deep link would leave it without them. This costs the LTX templates
nothing: neither assemble workflow references a `.safetensors` URL, and
`src/test/unit/service/serviceTemplateWorkflows.test.ts` asserts that it stays that way.

The example-input seeding block below it deliberately still reads only the deep-link
workflow. Any new workflow should reuse `LoadImage` filenames the deep-linked one already
names — the H3 prompt generator does, and the same test file enforces it.

Custom nodes follow the same graph-driven rule. The script installs
[TTS-Audio-Suite](https://github.com/diodiogod/TTS-Audio-Suite) — for the assemble workflow's
voice conversion — only when an installed graph mentions `UnifiedVoiceChangerNode`. The grep
covers *every* workflow the template installs, not just the deep-linked one, so
`ltx-video-ugc-multishot` pays for the install on account of its assemble workflow even though
its generator never mentions the node. `ltx-video-ugc-product` skips it because it ships one
workflow that has no voice conversion, `minimax-h3-video-ugc-multishot` skips it because
H3 generates the voice natively and its assemble workflow is a plain stitcher, and
`minimax-music3` skips it because its one workflow sings from the caption and has nothing to
convert. The clone lands
in the bucket's `custom_nodes`, but pip
installs into the container and is lost on stop, hence the unconditional reinstall on every
launch; it is cheap because `XDG_CACHE_HOME` puts pip's wheel cache in the bucket too. It
installs into the container's own site-packages rather than `--target` + `PYTHONPATH`: a
second `numpy`/`torch` ahead of the container's would break ComfyUI itself. Every step is
non-fatal — escrow is already claimed by then, and the video workflows need none of it.

A second gate follows the same shape for `minimax-h3-allinone`: a graph mentioning `H3OneNode`
gets three pack clones — the ALL-in-ONE node, the Motion Context fork, and SolAttn for the Balanced
preset. All three are pure Python, so the clone is the whole install and this gate has no pip step.
Immediately after, a stale `ComfyUI-MiniMaxH3-Cache` left in the bucket by an earlier launch is
deleted — see that template's section for why. A clone that fails is cleaned up and costs that mode
or preset, not the session. Then four fixups run: a static probe reports any name the packs reach
for on `comfy.ldm.minimax.model` that this core no longer defines; both config layers are reconciled
with what is actually installed; the node's own JS is trimmed to the modes and presets this image
can run; and a `sed` strips the `one-node-minimax-h3/` prefix out of the cloned pack's own graph
templates so saved clips land in the bucket root where `listFiles` can see them.

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

### `deepseek-harness-v4-flash.json` — DeepSeek Harness + DeepSeek-V4-Flash (GPU, bundle)

DeepSeek's own agent runtime driven by DeepSeek's own open-weight model, both inside one
container: `dsh` ([deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness),
MIT) serves its browser agent UI on loopback, and vLLM serves
`deepseek-ai/DeepSeek-V4-Flash-0731` (284B total / ~13B active MoE, FP8 weights with fp4
experts, 166.9 GB on disk) on loopback next to it. `kind: "bundle"` over the `vllm-hf-model`
service. Launch script: `deepseek-harness-v4-flash-bootstrap.sh`.

The three flags that make this an agent runtime rather than a chat window are
`--tokenizer-mode deepseek_v4` (the checkpoint ships encoding scripts under `encoding/` instead
of a Jinja chat template, so without this the OpenAI-compatible chat endpoint has nothing to
render with), `--tool-call-parser deepseek_v4` with `--enable-auto-tool-choice`, and
`--reasoning-parser deepseek_v4`. Missing either parser and the model's tool calls arrive as
prose inside the message body, which leaves the harness unable to act on one of them — so the
script's warm-up sends a real request **containing a tool call** and refuses to publish a
service that cannot answer it.

Context defaults to 393216 rather than the model's full 1048576 because that is the smallest
window in which the model's Think Max reasoning effort does not truncate; `VLLM_MAX_MODEL_LEN`
raises it. Tensor parallelism is mandatory (166.9 GB does not fit a 141 GB card), so
`VLLM_TP_SIZE` accepts only 2, 4 or 8 — the model has 64 attention heads and 6 is arithmetically
illegal, which also means this template needs the operator's larger `/dev/shm` the same way the
GLM-5.2 bundle does.

**Authentication is this template's own addition, not upstream's.** DeepSeek Harness documents
its web server as having no TLS, no auth and no origin policy, and its agent runs shell commands
in the container — so unlike OpenCode there is no password flag to switch on. dsh therefore
stays on `127.0.0.1:3080` and the single published port is a pinned Caddy reverse proxy
enforcing HTTP basic auth, with `header_up Host {upstream_hostport}` so dsh only ever sees the
loopback authority it already trusts (the container cannot know the public host:port the node
will assign, so `trustedHosts` cannot be configured against it). The hop is plain HTTP because
the node publishes a plain TCP port: the password travels in cleartext, and the container
boundary rather than the password is the real isolation. `DSH_WEB_PASSWORD` (12+ chars) is
mandatory and gated before anything downloads.

**It ships a skills library.** dsh reads the same `SKILL.md` format and discovery roots as other
skills-aware agents, at these tiers (lower number wins):

| Tier | Root |
| --- | --- |
| 100 | `<workspace>/.dsh/skills` |
| 200 | `<workspace>/.agents/skills` |
| 300 | `customSkillDirs` |
| 400 | `$DSH_HOME/skills` — **this bundle's library** |
| 500 | `$DSH_AGENTS_HOME/skills` |
| 600 | bundled |

The bootstrap writes six skills at tier 400 and **rewrites them on every launch**, so they are
node-managed rather than yours: `this-service` (what survives a stop, which port is published,
how files move through the bucket), `local-model` (interrogating the loopback endpoint, the
three reasoning efforts, calling it directly), `gpu-budget` (the VRAM is already spent — start
no second CUDA process), `workspace-discipline` (git-first in a bucket-backed workspace, what to
ask permission for, seeding `AGENTS.md`), `ocean-service-templates` (authoring templates and
bundles against `ServiceTemplateSchema`, including the gate/prove/pin conventions this folder
converged on), and `dsh-extension-pointers` (pointers into the official docs tree only — the
harness is a preview whose plugin API moves, so no API surface is restated). A consumer's own
skills belong in `$WORKSPACE/.agents/skills`, which outranks the library and survives relaunch.

Everything is pinned and per-launch overridable — image `vllm/vllm-openai:v0.27.1`, dsh
`0.1.1-rc.2`, Caddy `2.11.4`, Node `24.19.0` — because dsh is a developer preview whose README
promises compatibility-breaking changes and whose every published version is a release
candidate. A bucket is mandatory: it holds the weights, the Node/dsh runtime, dsh's sessions and
settings, and `/data/outputs/workspace-dsv4`, the git-initialised project directory the agent
edits.

**One documented caveat.** vLLM's published recipe for this checkpoint lists H200-class Hopper
only under a prefill/decode-disaggregated deployment, and the expert weights use an fp4 format
native to Blackwell. Plain tensor parallelism on Hopper is expected to work but is not an
upstream-documented layout for this model — that is the template's single unverified assumption,
and the tool-calling warm-up is what turns it into a log line in seconds rather than a wasted
paid window.

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
