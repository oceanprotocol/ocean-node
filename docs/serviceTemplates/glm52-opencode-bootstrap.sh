#!/bin/bash
# GLM-5.2 (vLLM, 6 GPUs) + OpenCode in one container, one escrow.
#
# Only 8080 is published, and it is OpenCode's own HTTP server. vLLM binds 127.0.0.1, so the
# raw OpenAI-compatible API — which answers anyone who reaches it — is not exposed at all.
#
# SECURITY, and the reason for gate 2 below: OpenCode is a coding AGENT, not a chat UI. Its
# tools read and write files and run shell commands inside this container. An unauthenticated
# OpenCode on a public port is remote code execution by design. OPENCODE_SERVER_PASSWORD is
# therefore mandatory and this script refuses to start without it.
#
# Unlike the Qwen3.8 and Muse-Glimmer siblings, this model spans SIX GPUs, which changes two
# things. First, vLLM runs one worker process per card and those processes exchange tensors
# and NCCL collectives through POSIX shared memory, so the container needs a /dev/shm far
# larger than Docker's 64 MB default — the node operator supplies it via init.advanced on the
# GPU resources. Second, everything is bigger: 753 GB of weights, a download measured in
# hours, and a paid window that is being consumed the whole time. Every precondition is
# therefore checked BEFORE the download starts, so a misconfiguration costs seconds.
#
# The template pins the image to vllm/vllm-openai:glm52, NOT :latest. GLM-5.2 needs vLLM
# >= 0.23.0 for GlmMoeDsaForCausalLM (the sparse-attention MoE architecture, which runs on
# vLLM's DeepSeek-V3.2 implementation) plus the glm47 tool parser and glm45 reasoning parser.
# An image without them refuses the flags and dies before loading a single weight. Move back
# to :latest only once a release you have actually tested carries all three; do not use
# :nightly, which changes under you inside a paid window.
set -euo pipefail

MODEL="zai-org/GLM-5.2-FP8"
SERVED_NAME="glm-5.2"
VLLM_PORT=8000        # loopback only
OC_PORT=8080          # the published port
OC_VERSION="${OPENCODE_VERSION:-1.18.19}"   # pinned; see the note above the installer

# The parallel layout. -tp 2 -pp 3 uses all six cards with nothing replicated: 753/6 ≈
# 125.5 GB of weights per GPU, leaving ~11 GB each for KV cache at the utilisation below.
# Do not "simplify" this to -tp 6: the model has 64 attention heads and tensor parallelism
# splits by whole heads, so 6 (and 3) are illegal and vLLM will refuse to start. Do not
# switch to data-parallel replication either — the non-expert weights (~19 GB) would be
# copied to every rank, needing ~140 GB of a 141 GB card before any cache exists.
TP_SIZE=2
PP_SIZE=3
GPUS_REQUIRED=$((TP_SIZE * PP_SIZE))

# Memory budget. These numbers are measured from real startup logs on 6x141 GB H200, not
# estimated, because both obvious values fail and they fail in opposite directions.
#
# 0.97 dies on the FIRST REQUEST, not at startup. Torch creates a pipeline-parallel P2P
# communicator lazily, the first time a stage sends a hidden state -- "An unbatched P2P op
# (send/recv) ... will result in a new 2-rank NCCL communicator to be created" -- and those
# buffers come from memory vLLM never reserved and does not profile, at roughly 100 MB per
# communicator. So does the sparse-prefill workspace flashmla allocates on the first long
# prompt. At 0.97 only ~4.2 GB per card is left outside vLLM's budget, and the server binds,
# reports healthy, then dies the moment someone types anything:
#   ncclUnhandledCudaError ... Cuda failure 2 'out of memory'   (from irecv_tensor_dict)
#
# 0.93 refuses to start, for a completely different reason -- and this is the important part:
#
#   Worker_PP0 : Available KV cache memory: 16.81 GiB
#   worst stage: Available KV cache memory:  1.87 GiB
#   ValueError: To serve at least one request with the model's max seq len (262144),
#               4.36 GiB KV cache is needed, which is larger than the available KV cache
#               memory (1.87 GiB) ... estimated maximum model length is 112512
#
# THE PIPELINE STAGES ARE NOT BALANCED. Stage 0 has 16.81 GiB spare while the worst stage has
# 1.87 GiB, and because pipeline parallelism needs a uniform page count across stages, the
# minimum sets the pool and ~14.9 GiB of stage 0 is simply wasted. The split is even in LAYERS
# (26/26/26) and badly uneven in BYTES: this is a mixture-of-experts model whose early layers
# are dense, the last stage also carries the LM head, and CUDA graphs cost 2.38 GiB on the
# last stage against 0.67 GiB in the middle (graph memory is inside the util budget since
# vLLM 0.21.0). Per card each layer is ~4.8 GiB, so one layer moved between stages moves more
# memory than the entire margin being fought over.
#
# Measured KV on the worst stage, and what fits (~17.4 KB per token per card):
#
#   util  worst-stage KV  outside vLLM   262144 ctx   131072 ctx
#   0.93        1.87 GiB       9.9 GiB       ABORT        ABORT
#   0.94        3.28 GiB       8.5 GiB       ABORT           ok
#   0.95        4.69 GiB       7.1 GiB    ok, +7.5%     ok, +115%   <-- here
#   0.96        6.10 GiB       5.6 GiB          ok           ok
#   0.97        7.51 GiB       4.2 GiB          ok           ok  <- first-request OOM
#
# So 0.95 with a 131072 context is the only setting with real margin at BOTH ends: twice the
# KV cache it needs, and 68% more headroom outside vLLM than the value that OOMed. 262144 does
# technically fit at 0.95, by 7.5% -- one different graph capture set or vLLM build away from
# aborting again, which is why it is not the default. See VLLM_PP_LAYER_PARTITION below for
# the way to actually earn it back.
GPU_MEM_UTIL="${VLLM_GPU_MEM_UTIL:-0.95}"

# 131072 rather than the model's full 262144. This is a real reduction and it is deliberate:
# see the table above -- 262144 needs 4.36 GiB of KV on the tightest stage and there is no
# utilisation value that supplies that with margin while also leaving the lazily created NCCL
# communicators room to exist. 131072 tokens is still a very large session for a coding agent.
#
# To get 262144 back, balance the stages rather than raising the utilisation. Launch once,
# read the per-stage "Available KV cache memory" lines out of the log, and move layers off the
# tight stages onto stage 0 with VLLM_PP_LAYER_PARTITION (comma-separated per-stage layer
# counts summing to 78, e.g. 28,25,25). Balanced perfectly, the ~14.9 GiB currently stranded
# on stage 0 is more than the whole 262144 context needs. That takes one measurement run on
# the specific node, which is why it is documented rather than guessed at here.
MAX_MODEL_LEN="${VLLM_MAX_MODEL_LEN:-131072}"

BUCKET=/data/outputs
# Namespaced per template, not shared: a consumer may point this template and the smaller
# siblings at the same bucket, and two containers writing one OpenCode session store corrupts
# it. The Hugging Face cache below IS shared — huggingface_hub locks correctly and the reuse
# is worth it.
OC_HOME="$BUCKET/opencode-home-glm52"       # becomes $HOME: binary, config, sessions, caches
WORKSPACE="$BUCKET/workspace-glm52"         # the project directory OpenCode operates on

echo "[ocean] $(id)"

# ---------------------------------------------------------------------------------------
# Gate 1: the bucket. It holds 753 GB of weights, the OpenCode binary and every session,
# message and file OpenCode writes. restartService creates a NEW container rather than
# restarting the old one, so without a bind at /data/outputs every relaunch re-downloads
# everything inside the paid window AND loses your code and your session history. Fail here,
# where the log says why.
# ---------------------------------------------------------------------------------------
if [ ! -d "$BUCKET" ]; then
  echo "[ocean] no persistent-storage bucket mounted at $BUCKET — refusing to start." \
    "753 GB of weights would download into the container, taking hours of your paid" \
    "window, and the workspace OpenCode edits would be destroyed on stop." \
    "Select a bucket when launching and relaunch." >&2
  exit 1
fi

# ---------------------------------------------------------------------------------------
# Gate 2: the password. See the security note at the top of this file. HTTP basic auth is
# the only access control OpenCode's server has, it is off unless OPENCODE_SERVER_PASSWORD
# is set, and everything behind it — the web UI, the REST API and the SSE event stream —
# can run shell commands in this container. Checked before the download, like everything
# else here: a missing password should cost seconds, not two hours of a paid window.
# ---------------------------------------------------------------------------------------
if [ -z "${OPENCODE_SERVER_PASSWORD:-}" ]; then
  echo "[ocean] OPENCODE_SERVER_PASSWORD is not set — refusing to start. OpenCode's tools" \
    "run shell commands and edit files in this container, and its server has no other" \
    "access control, so publishing it without a password would hand anyone who finds the" \
    "URL a root shell. Set OPENCODE_SERVER_PASSWORD when launching and relaunch." >&2
  exit 1
fi
export OPENCODE_SERVER_PASSWORD
export OPENCODE_SERVER_USERNAME="${OPENCODE_SERVER_USERNAME:-opencode}"
echo "[ocean] basic auth enabled for user '$OPENCODE_SERVER_USERNAME'"

# ---------------------------------------------------------------------------------------
# Gate 3: the cards. torch rather than nvidia-smi — it reports what vLLM will actually see
# (it honours CUDA_VISIBLE_DEVICES and a missing driver shows up as 0, not as a missing
# binary). Fewer than six and the -tp 2 -pp 3 layout cannot be built; more than six is fine,
# vLLM takes the first six. Checked before the download because a wrong resource selection
# would otherwise surface hours later.
# ---------------------------------------------------------------------------------------
GPU_COUNT=$(python3 -c 'import torch; print(torch.cuda.device_count())' 2>/dev/null || echo 0)
if [ "$GPU_COUNT" -lt "$GPUS_REQUIRED" ]; then
  echo "[ocean] this bundle needs $GPUS_REQUIRED GPUs and the container can see $GPU_COUNT." \
    "The model is 753 GB and is split tensor-parallel $TP_SIZE by pipeline-parallel $PP_SIZE;" \
    "it cannot run on fewer cards, and no smaller layout exists for it. Relaunch asking for" \
    "$GPUS_REQUIRED GPUs, on a node that has $GPUS_REQUIRED free." >&2
  exit 1
fi
echo "[ocean] $GPU_COUNT GPU(s) visible — using $GPUS_REQUIRED as -tp $TP_SIZE -pp $PP_SIZE"
if [ -n "${VLLM_PP_LAYER_PARTITION:-}" ]; then
  echo "[ocean] custom pipeline layer partition: $VLLM_PP_LAYER_PARTITION (must sum to 78)"
fi

# ---------------------------------------------------------------------------------------
# Gate 4: shared memory. THE multi-GPU prerequisite, and the one thing this bundle cannot
# work around from inside the container. vLLM starts one worker process per GPU and those
# workers pass tensors and NCCL bootstrap traffic through /dev/shm. Docker's default is a
# private 64 MB, in which startup hangs or dies with a bus error — a failure that looks like
# a model problem and is not. The node operator fixes it once, on the GPU resources in the
# node config:
#
#   "init": { "advanced": { "ShmSize": 17179869184, "PidsLimit": 4096 } }
#
# (see ocean-node docs/compute.md, "Multi-GPU workloads"). 8 GiB is the floor checked here;
# 16 GiB is the recommended setting.
# ---------------------------------------------------------------------------------------
SHM_MIN_KB=$((8 * 1024 * 1024))
SHM_KB=$(df -Pk /dev/shm 2>/dev/null | awk 'NR==2 {print $2}')
if [ -z "${SHM_KB:-}" ]; then
  echo "[ocean] cannot determine the size of /dev/shm — refusing to start rather than" \
    "failing deep inside model loading." >&2
  exit 1
fi
if [ "$SHM_KB" -lt "$SHM_MIN_KB" ]; then
  echo "[ocean] /dev/shm is only $((SHM_KB / 1024)) MB; this bundle needs at least" \
    "$((SHM_MIN_KB / 1024 / 1024)) GB. vLLM runs one worker process per GPU and they" \
    "communicate through shared memory, so startup would hang or abort with a bus error." \
    "This is a NODE configuration item, not something you can set at launch: the operator" \
    "must add ShmSize (16 GiB = 17179869184) under init.advanced on the GPU resources in" \
    "the node config — see ocean-node docs/compute.md, 'Multi-GPU workloads'. Ask the" \
    "operator of this node to enable it, or launch on a node that already has." >&2
  exit 1
fi
echo "[ocean] /dev/shm is $((SHM_KB / 1024 / 1024)) GB — enough for $GPUS_REQUIRED workers"

export HF_HOME="$BUCKET/hf"
mkdir -p "$HF_HOME"

# ---------------------------------------------------------------------------------------
# Gate 5: room for the weights. The node prices `disk` but does not enforce it on services,
# and buckets have no quota, so nothing except this check stands between a too-small bucket
# and a download that dies at 95% having spent an hour of a paid window. Only enforced when
# the weights are not already cached — on a relaunch the bucket is legitimately near-full.
# ---------------------------------------------------------------------------------------
CACHE_DIR="$HF_HOME/hub/models--${MODEL//\//--}"
if [ ! -d "$CACHE_DIR" ]; then
  DISK_MIN_KB=$((800 * 1024 * 1024))
  DISK_FREE_KB=$(df -Pk "$BUCKET" 2>/dev/null | awk 'NR==2 {print $4}')
  if [ -n "${DISK_FREE_KB:-}" ] && [ "$DISK_FREE_KB" -lt "$DISK_MIN_KB" ]; then
    echo "[ocean] the bucket has $((DISK_FREE_KB / 1024 / 1024)) GB free and the weights" \
      "need about $((DISK_MIN_KB / 1024 / 1024)) GB. Refusing to start a download that" \
      "cannot finish. Free space on this bucket, or launch with a larger disk allocation." >&2
    exit 1
  fi
  echo "[ocean] weights not cached yet — first launch will download ~753 GB, which takes" \
    "roughly 1.5-2 hours on a gigabit link and is billed. Later launches reuse the bucket."
else
  echo "[ocean] weights already on the bucket — skipping the long download"
fi

# ---------------------------------------------------------------------------------------
# One knob for all persistence: OpenCode follows $HOME and the XDG defaults under it, and
# its installer hardcodes $HOME/.opencode/bin. Pointing HOME at the bucket therefore keeps
# the binary, the global config, the npm packages it fetches for the provider, and every
# session and message on the bucket, with nothing else to wire up.
#
# All of the OpenCode setup below runs BEFORE the weights download on purpose: it is the
# cheap half of startup and the half most likely to fail (a release tarball that has moved,
# an architecture with no build), so it fails in seconds instead of after two paid hours.
# ---------------------------------------------------------------------------------------
export HOME="$OC_HOME"
mkdir -p "$HOME" "$WORKSPACE"
OC_BIN="$HOME/.opencode/bin/opencode"

# ---------------------------------------------------------------------------------------
# Install OpenCode. Not via `curl -fsSL https://opencode.ai/install | bash`: that script
# needs curl and tar in the image and, with no --version, resolves "latest" at launch, so
# the version would change under you inside a paid window. This downloads the pinned release
# tarball with python3 (a hard vLLM dependency, always present) and unpacks it with tarfile,
# so the image needs neither curl nor tar. Bump OC_VERSION deliberately, or override it per
# launch with OPENCODE_VERSION.
# ---------------------------------------------------------------------------------------
if [ -x "$OC_BIN" ] && [ "$("$OC_BIN" --version 2>/dev/null || true)" = "$OC_VERSION" ]; then
  echo "[ocean] OpenCode $OC_VERSION already on the bucket — reusing it"
else
  echo "[ocean] installing OpenCode $OC_VERSION into $HOME/.opencode/bin"
  python3 - "$OC_VERSION" "$HOME/.opencode/bin" <<'PY'
import os, platform, sys, tarfile, tempfile, urllib.request

version, dest = sys.argv[1], sys.argv[2]

machine = platform.machine()
arch = {'x86_64': 'x64', 'amd64': 'x64', 'aarch64': 'arm64', 'arm64': 'arm64'}.get(machine)
if arch is None:
    sys.exit(f'[ocean] unsupported architecture {machine!r} — no OpenCode build for it')

# The x64 build assumes AVX2; the -baseline build is the one for CPUs without it. Getting
# this wrong is an illegal-instruction crash at first run, not a clear error.
target = f'linux-{arch}'
if arch == 'x64':
    try:
        with open('/proc/cpuinfo') as fh:
            if 'avx2' not in fh.read():
                target += '-baseline'
    except OSError:
        pass

url = (f'https://github.com/anomalyco/opencode/releases/download/'
       f'v{version}/opencode-{target}.tar.gz')
print(f'[ocean] fetching {url}', flush=True)
os.makedirs(dest, exist_ok=True)
with tempfile.NamedTemporaryFile(suffix='.tar.gz') as tmp:
    with urllib.request.urlopen(url, timeout=180) as resp:
        while True:
            chunk = resp.read(1 << 20)
            if not chunk:
                break
            tmp.write(chunk)
    tmp.flush()
    with tarfile.open(tmp.name) as tf:
        try:
            tf.extractall(dest, filter='data')   # 3.12+/3.11.4+: refuses paths outside dest
        except TypeError:
            tf.extractall(dest)
os.chmod(os.path.join(dest, 'opencode'), 0o755)
PY
  echo "[ocean] OpenCode $("$OC_BIN" --version) installed"
fi

# git is optional but worth having: OpenCode's undo/revert and its diff view read the
# repository, and the workspace is a real directory the consumer will want history in. Never
# fatal — the agent works without it, and apt may be unavailable or the user non-root.
if ! command -v git >/dev/null 2>&1; then
  echo "[ocean] git not in the image — trying to install it (optional)"
  (apt-get update -qq && apt-get install -y -qq --no-install-recommends git) >/dev/null 2>&1 \
    || echo "[ocean] could not install git — OpenCode's revert/diff features will be limited"
fi
if command -v git >/dev/null 2>&1 && [ ! -d "$WORKSPACE/.git" ]; then
  git init -q "$WORKSPACE" 2>/dev/null || true
  git -C "$WORKSPACE" config user.email opencode@ocean.local 2>/dev/null || true
  git -C "$WORKSPACE" config user.name "OpenCode" 2>/dev/null || true
fi

# ---------------------------------------------------------------------------------------
# OpenCode's global config, rewritten on every launch because it is node-managed: it points
# at the loopback vLLM and pins which providers exist. Project config wins over the global
# one in OpenCode's precedence order, so put your own overrides in
# $WORKSPACE/opencode.json — those survive, this file does not.
#
# enabled_providers is the privacy control that matters: without it OpenCode also offers its
# own hosted models, and a consumer could send this conversation off-box by picking one from
# the model list. With it, "vllm" is the only provider that exists, so every token is
# generated by the GPUs in this container.
#
# `options` on the model entry is forwarded to the request body only for parameters the
# OpenAI-compatible client knows. temperature and top_p arrive; anything else (top_k,
# reasoning_effort) is dropped, which is why sampling defaults that vLLM must enforce are
# passed to `vllm serve` instead.
#
# small_model is the same model, because it is the only one here: titles and summaries are
# short prompts and there is no cheaper local model to hand them to. Point it at a sibling
# template's endpoint only if you run one alongside this on the same bucket.
# ---------------------------------------------------------------------------------------
mkdir -p "$HOME/.config/opencode"
SERVED_NAME="$SERVED_NAME" VLLM_PORT="$VLLM_PORT" MAX_MODEL_LEN="$MAX_MODEL_LEN" python3 - "$HOME/.config/opencode/opencode.json" <<'PY'
import json, os, sys

served, port = os.environ['SERVED_NAME'], os.environ['VLLM_PORT']
# Must match what vLLM was actually started with: OpenCode compacts a session against this
# number, so overstating it means requests rejected mid-task instead of a timely compaction.
ctx = int(os.environ['MAX_MODEL_LEN'])
config = {
    '$schema': 'https://opencode.ai/config.json',
    'model': f'vllm/{served}',
    'small_model': f'vllm/{served}',   # titles/summaries stay local too
    'share': 'disabled',               # never upload a session to opencode.ai
    'autoupdate': False,               # no version change inside a paid window
    'enabled_providers': ['vllm'],
    # The agent edits inside its own workspace freely; shell commands ask first, because
    # they are the ones that reach the network, the bucket and the rest of the container.
    'permission': {'edit': 'allow', 'bash': 'ask', 'webfetch': 'allow'},
    'provider': {
        'vllm': {
            'npm': '@ai-sdk/openai-compatible',
            'name': 'GLM-5.2 on these GPUs (vLLM)',
            'options': {
                'baseURL': f'http://127.0.0.1:{port}/v1',
                'apiKey': 'local'      # vLLM has no key set; it is not reachable off-host
            },
            'models': {
                served: {
                    'name': f'GLM-5.2 FP8 (744B MoE, {ctx // 1024}K context, thinking)',
                    'attachment': False,   # text-only model; no image input
                    'reasoning': True,
                    'tool_call': True,
                    'temperature': True,
                    'interleaved': 'reasoning_content',  # the field vLLM's parser emits
                    'modalities': {'input': ['text'], 'output': ['text']},
                    'limit': {'context': ctx, 'output': 65536}
                }
            }
        }
    }
}
with open(sys.argv[1], 'w') as fh:
    json.dump(config, fh, indent=2)
print('[ocean] wrote OpenCode config for vllm/' + served)
PY

# ---------------------------------------------------------------------------------------
# Weights. snapshot_download rather than the `hf` CLI: huggingface_hub is a hard vLLM
# dependency so the Python API is always present, whereas the CLI entrypoint was renamed
# (huggingface-cli -> hf) and which name exists varies by image. It resumes, verifies against
# the remote ETag, and writes the cache layout vLLM expects. It reads HF_TOKEN from the
# environment by itself; this repository is ungated, so the token is optional.
#
# The [models] lines are the markers nodes-dashboard parses for provisioning progress; the
# denominator matches the model entries in includes[].
# ---------------------------------------------------------------------------------------
if python3 -c 'import hf_transfer' 2>/dev/null; then
  export HF_HUB_ENABLE_HF_TRANSFER=1
  echo "[ocean] hf_transfer available — using accelerated downloads"
else
  echo "[ocean] hf_transfer not installed — standard downloads"
fi

echo "[models] downloading $MODEL"
python3 - "$MODEL" <<'PY'
import sys
from huggingface_hub import snapshot_download
snapshot_download(sys.argv[1], max_workers=8)
PY
echo "[models] ready 1/1 $MODEL"
echo "[models] bundle complete"

# ---------------------------------------------------------------------------------------
# NCCL communicator size. Every communicator carries per-channel buffers, so the pipeline P2P
# communicators created on the first request cost about 100 MB each at NCCL's default 16
# channels and roughly half that at 8. Eight is plenty for this layout: the P2P traffic is one
# hidden-state tensor per stage boundary, which is latency-bound rather than bandwidth-bound,
# and the tensor-parallel all-reduces stay on NVLink inside a pair. Left alone if the node
# operator already set it. (NCCL_CUMEM_ENABLE is deliberately untouched -- vLLM sets it to 0
# itself to work around an NCCL bug.)
export NCCL_MAX_NCHANNELS="${NCCL_MAX_NCHANNELS:-8}"

# ---------------------------------------------------------------------------------------
# Multi-token prediction, off by default, opt in with ENABLE_MTP=true.
#
# Worth understanding before flipping it. Pipeline parallelism splits the 78 layers into 3
# sequential stages, so with a single user two of the three stages are idle at any instant —
# a real latency cost this model would not pay on 8 GPUs with pure tensor parallelism. MTP
# is the intended answer: the repo ships an extra prediction head that guesses the next few
# tokens cheaply, and the full model verifies them in one pass, accepting the correct ones.
# Wrong guesses are discarded, so output is identical either way; only speed changes. An
# agent feels this more than a chat user does, because it spends most of its tokens on tool
# calls and edits it is not waiting to read.
#
# It is off by default for the same reason the siblings leave it off: --speculative-config
# is the flag most likely to be rejected outright by a given vLLM build (its accepted
# spelling has changed between versions), and a rejected flag means the server never starts,
# which costs a paid window. Turn it on once you have watched this template start cleanly,
# and if startup then fails the log will name the flag.
# ---------------------------------------------------------------------------------------
# Expanded below as ${VLLM_EXTRA_ARGS[@]+"..."} rather than plain "${VLLM_EXTRA_ARGS[@]}":
# under `set -u`, expanding an EMPTY array is an unbound-variable error on bash before 4.4,
# and the shell in a given base image is not something this script should have to assume.
VLLM_EXTRA_ARGS=()
if [ "${ENABLE_MTP:-false}" = "true" ]; then
  VLLM_EXTRA_ARGS+=(--speculative-config '{"method":"mtp","num_speculative_tokens":3}')
  echo "[ocean] MTP speculative decoding enabled"
fi

# ---------------------------------------------------------------------------------------
# vLLM, on loopback. --reasoning-parser is mandatory, not cosmetic: the chat template opens
# every assistant turn with a thinking block, and without the parser that text is returned as
# ordinary content with any tool call still buried inside it — which would leave OpenCode
# unable to call a single tool.
#
# --kv-cache-dtype fp8 follows the model's own vLLM recipe. --max-model-len does NOT: the
# recipe's 262144 does not fit here with any margin, for the stage-imbalance reason set out at
# the top of this file, so it is $MAX_MODEL_LEN and overridable.
#
# --max-num-seqs is 8, down from 16. Concurrency costs memory twice on the tightest stage --
# activation peak and the CUDA graph capture set, and graph memory sits inside the utilisation
# budget on vLLM >= 0.21.0, where the last stage was already spending 2.38 GiB on it. Eight
# concurrent sequences is ample for an agent workload, which runs one session at a time and
# spends its tokens on depth rather than breadth.
# ---------------------------------------------------------------------------------------
vllm serve "$MODEL" \
  --host 127.0.0.1 --port "$VLLM_PORT" \
  --served-model-name "$SERVED_NAME" \
  --tensor-parallel-size "$TP_SIZE" \
  --pipeline-parallel-size "$PP_SIZE" \
  --gpu-memory-utilization "$GPU_MEM_UTIL" \
  --max-model-len "$MAX_MODEL_LEN" \
  --max-num-seqs 8 \
  --kv-cache-dtype fp8 \
  --reasoning-parser glm45 \
  --tool-call-parser glm47 \
  --enable-auto-tool-choice \
  ${VLLM_EXTRA_ARGS[@]+"${VLLM_EXTRA_ARGS[@]}"} &
VLLM_PID=$!

# The port opens when uvicorn binds, which is after every worker has loaded its shard, so
# this is a real readiness signal. kill -0 turns a dead loader into an immediate exit rather
# than an endless wait. The timeout is the other half of that: with six workers reading
# 753 GB off disk, a wedged NCCL rendezvous does not exit and does not bind — it just sits
# there billing. 90 minutes is far beyond a healthy load (minutes, from a local bucket) and
# short of an escrow window worth losing in silence.
LOAD_TIMEOUT=5400
WAITED=0
until (exec 3<>/dev/tcp/127.0.0.1/"$VLLM_PORT") 2>/dev/null; do
  kill -0 $VLLM_PID 2>/dev/null || { echo "[ocean] vLLM exited during startup" >&2; exit 1; }
  if [ "$WAITED" -ge "$LOAD_TIMEOUT" ]; then
    echo "[ocean] vLLM did not begin serving within $((LOAD_TIMEOUT / 60)) minutes and is" \
      "still running — most likely a stalled multi-GPU rendezvous. Check /dev/shm size and" \
      "GPU visibility on this node. Exiting rather than billing an unusable service." >&2
    kill $VLLM_PID 2>/dev/null || true
    exit 1
  fi
  sleep 10
  WAITED=$((WAITED + 10))
done
echo "[ocean] vLLM serving $SERVED_NAME on 127.0.0.1:$VLLM_PORT across $GPUS_REQUIRED GPUs"

# ---------------------------------------------------------------------------------------
# Warm-up, and the reason it is not optional. Three things in this stack allocate memory or
# compile code on the FIRST real request rather than at startup: the lazily created pipeline
# P2P communicators, the flashmla sparse-prefill workspace, and a Triton kernel that JITs
# mid-inference. A bound port therefore proves the weights loaded and proves nothing about
# whether this service can answer. Without this block the consumer establishes that by typing
# a prompt and watching the engine die, hours in, with the download already paid for.
#
# So the script asks the question itself, with a prompt long enough to take the sparse-prefill
# path rather than the short-sequence one, and refuses to publish a service that cannot answer
# it. When it succeeds it has also paid the JIT and allocation costs, so the consumer's first
# prompt is merely fast rather than spiky.
#
# Note for anyone debugging a node that OOMed once: NCCL and CUDA state can be left wedged
# below the process boundary, so a relaunch on the same host can keep failing here even with
# correct settings. That is a host-level reset, not a template setting.
# ---------------------------------------------------------------------------------------
echo "[ocean] warming up: one request to allocate the P2P communicators and compile the prefill kernels"
if ! SERVED_NAME="$SERVED_NAME" VLLM_PORT="$VLLM_PORT" python3 <<'PY'
import json, os, sys, urllib.error, urllib.request

served, port = os.environ['SERVED_NAME'], os.environ['VLLM_PORT']
# ~6K tokens of filler: enough to cross the length threshold where the sparse-attention
# prefill kernel is chosen over the dense one, since that is the path allocating a workspace
# outside vLLM's profiled budget. max_tokens=16 also exercises the decode P2P path, which is
# where the OOM this guards against actually surfaced.
filler = 'The quick brown fox jumps over the lazy dog. ' * 700   # ~6K tokens, safe at any supported context
body = json.dumps({
    'model': served,
    'messages': [{'role': 'user', 'content': filler + '\nReply with the single word: ready'}],
    'max_tokens': 16,
    'temperature': 0
}).encode()
req = urllib.request.Request(
    f'http://127.0.0.1:{port}/v1/chat/completions',
    data=body,
    headers={'Content-Type': 'application/json'}
)
try:
    with urllib.request.urlopen(req, timeout=900) as resp:
        json.load(resp)['choices'][0]['message']
except urllib.error.HTTPError as e:
    sys.exit(f'[ocean] warm-up request returned HTTP {e.code}: {e.read()[:400]!r}')
except Exception as e:
    sys.exit(f'[ocean] warm-up request failed: {e}')
print('[ocean] warm-up completed — prefill and decode both work')
PY
then
  echo "[ocean] the model server loaded its weights but cannot serve a request, so this" \
    "service is not being published. If the vLLM log above ends in NCCL's" \
    "\"Cuda failure 2 'out of memory'\" from irecv_tensor_dict, the cards are too full for" \
    "the pipeline communicators that get created on the first request. Lower" \
    "VLLM_GPU_MEM_UTIL (currently $GPU_MEM_UTIL) by 0.01 at a time — but not below the point" \
    "where the KV cache still holds one full VLLM_MAX_MODEL_LEN ($MAX_MODEL_LEN) context, or" \
    "the next launch fails at startup instead, with a ValueError naming the shortfall. If both" \
    "ends are squeezed, the fix is to balance the pipeline stages with VLLM_PP_LAYER_PARTITION" \
    "rather than to keep trading one failure for the other; see the notes at the top of this" \
    "script. Exiting rather than billing a service that dies on the first prompt." >&2
  kill $VLLM_PID 2>/dev/null || true
  exit 1
fi

# ---------------------------------------------------------------------------------------
# The published port. `serve` rather than `web`: both host the same browser UI on the same
# port, but `web` also tries to open a local browser, which has nothing to open in a
# container. Basic auth covers every route on it — the UI, the REST API and the /event
# stream all answer 401 without credentials.
#
# It runs from $WORKSPACE, which is the project OpenCode reads and edits, and which lives on
# the bucket. CUDA_VISIBLE_DEVICES is emptied for this process only: OpenCode has no use for
# the GPU, and this guarantees it cannot take VRAM the model needs — and at 0.97 utilisation
# across six cards there is none to spare.
# ---------------------------------------------------------------------------------------
cd "$WORKSPACE"
CUDA_VISIBLE_DEVICES= "$OC_BIN" serve --hostname 0.0.0.0 --port "$OC_PORT" &
OC_PID=$!

until (exec 3<>/dev/tcp/127.0.0.1/"$OC_PORT") 2>/dev/null; do
  kill -0 $OC_PID 2>/dev/null || { echo "[ocean] OpenCode exited during startup" >&2; exit 1; }
  sleep 3
done
echo "[ocean] ready — open the service URL and sign in as '$OPENCODE_SERVER_USERNAME' with the password you set"

# If either process dies the container stops, rather than leaving something that still looks
# Running and still bills while being unusable.
wait -n $VLLM_PID $OC_PID
