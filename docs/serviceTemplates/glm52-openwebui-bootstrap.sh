#!/bin/bash
# GLM-5.2 (vLLM, 6 GPUs) + Open WebUI in one container, one escrow.
#
# Only 8080 is published. vLLM binds 127.0.0.1, so the raw OpenAI-compatible API — which
# answers anyone who reaches it — is not exposed at all, and Open WebUI's own login is the
# single front door.
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
OWUI_PORT=8080        # the published port

# The parallel layout. -tp 2 -pp 3 uses all six cards with nothing replicated: 753/6 ≈
# 125.5 GB of weights per GPU, leaving ~11 GB each for KV cache at the utilisation below.
# Do not "simplify" this to -tp 6: the model has 64 attention heads and tensor parallelism
# splits by whole heads, so 6 (and 3) are illegal and vLLM will refuse to start. Do not
# switch to data-parallel replication either — the non-expert weights (~19 GB) would be
# copied to every rank, needing ~140 GB of a 141 GB card before any cache exists.
TP_SIZE=2
PP_SIZE=3
GPUS_REQUIRED=$((TP_SIZE * PP_SIZE))

# Weights alone are ~89% of a 141 GB card, so the 0.90 the single-GPU siblings use would
# leave ~1.4 GB for activations AND cache, and vLLM would abort during startup profiling.
# 0.97 leaves ~11 GB of cache per card while still keeping ~4 GB outside vLLM's budget for
# each worker's CUDA context and NCCL buffers.
GPU_MEM_UTIL=0.97

BUCKET=/data/outputs
# Namespaced per template, not shared: a consumer may point this template and the smaller
# siblings at the same bucket, and two containers writing one Open WebUI sqlite file corrupts
# it, while two racing to create one venv leaves it half-built. The Hugging Face cache below
# IS shared — huggingface_hub locks correctly and the reuse is worth it.
VENV="$BUCKET/owui-venv-glm52"
OWUI_DATA="$BUCKET/openwebui-glm52"

echo "[ocean] $(id)"

# ---------------------------------------------------------------------------------------
# Gate 1: the bucket. It holds 753 GB of weights, the Open WebUI virtualenv and Open WebUI's
# database. restartService creates a NEW container rather than restarting the old one, so
# without a bind at /data/outputs every relaunch re-downloads everything inside the paid
# window AND loses every chat, prompt and account. Fail here, where the log says why.
# ---------------------------------------------------------------------------------------
if [ ! -d "$BUCKET" ]; then
  echo "[ocean] no persistent-storage bucket mounted at $BUCKET — refusing to start." \
    "753 GB of weights would download into the container, taking hours of your paid" \
    "window, and your chat history and admin account would be destroyed on stop." \
    "Select a bucket when launching and relaunch." >&2
  exit 1
fi

# ---------------------------------------------------------------------------------------
# Gate 2: the interpreter. open-webui declares requires_python >=3.11,<3.13. If the base
# image has moved outside that range the pip install fails halfway with a resolver error
# that reads like a network problem, so check up front and say so plainly.
# ---------------------------------------------------------------------------------------
PYV=$(python3 -c 'import sys; print("%d.%d" % sys.version_info[:2])')
case "$PYV" in
  3.11 | 3.12) echo "[ocean] python $PYV — within open-webui's supported range" ;;
  *)
    echo "[ocean] python $PYV is outside open-webui's supported range (>=3.11,<3.13)." \
      "The vLLM base image has moved; pin an older image tag on this template or wait for" \
      "open-webui to support $PYV." >&2
    exit 1
    ;;
esac

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
mkdir -p "$OWUI_DATA"

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
# Open WebUI, in its OWN virtualenv on the bucket. Not into the image's Python: open-webui
# pins fastapi, pydantic, starlette and uvicorn, all of which vLLM also depends on, and a
# shared install can silently downgrade one of them and break `vllm serve`. A separate venv
# makes that impossible. It lives on the bucket, so the ~145 MB wheel and its dependency
# tree are downloaded once and reused by every later launch.
# ---------------------------------------------------------------------------------------
if [ ! -x "$VENV/bin/open-webui" ]; then
  echo "[ocean] installing Open WebUI into $VENV (first launch only)"
  python3 -m venv "$VENV"
  "$VENV/bin/pip" install --no-cache-dir --upgrade pip
  "$VENV/bin/pip" install --no-cache-dir open-webui
else
  echo "[ocean] Open WebUI already installed on the bucket — reusing it"
fi
"$VENV/bin/pip" show open-webui 2>/dev/null | awk '/^Version:/{print "[ocean] open-webui " $2}'

# ---------------------------------------------------------------------------------------
# Session signing key. Generated once and kept on the bucket when the consumer did not
# supply one, so that logins survive a relaunch instead of every session being invalidated.
# ---------------------------------------------------------------------------------------
if [ -z "${WEBUI_SECRET_KEY:-}" ]; then
  KEYFILE="$OWUI_DATA/.ocean-secret-key"
  if [ ! -s "$KEYFILE" ]; then
    (umask 077; python3 -c 'import secrets; print(secrets.token_urlsafe(48))' > "$KEYFILE")
    echo "[ocean] generated a session signing key on the bucket"
  fi
  WEBUI_SECRET_KEY=$(cat "$KEYFILE")
  export WEBUI_SECRET_KEY
else
  echo "[ocean] using the supplied WEBUI_SECRET_KEY"
fi

# Open WebUI settings. Signup is left at its default (on) because nobody has an account yet:
# the consumer creates the first one in the browser and Open WebUI makes it the administrator,
# then disables signup itself. ENABLE_PERSISTENT_CONFIG is left at its default (on) so that
# self-disabling survives a relaunch, along with anything else changed in the admin panel.
export DATA_DIR="$OWUI_DATA"
export DEFAULT_USER_ROLE=pending        # so a second signup, if ever re-enabled, has no access
export ENABLE_OLLAMA_API=false          # no Ollama in this image; hides a dead connection
export OPENAI_API_BASE_URL="http://127.0.0.1:$VLLM_PORT/v1"
export OPENAI_API_KEY=local             # vLLM has no key set; it is not reachable off-host

# ---------------------------------------------------------------------------------------
# Multi-token prediction, off by default, opt in with ENABLE_MTP=true.
#
# Worth understanding before flipping it. Pipeline parallelism splits the 78 layers into 3
# sequential stages, so with a single user two of the three stages are idle at any instant —
# a real latency cost this model would not pay on 8 GPUs with pure tensor parallelism. MTP
# is the intended answer: the repo ships an extra prediction head that guesses the next few
# tokens cheaply, and the full model verifies them in one pass, accepting the correct ones.
# Wrong guesses are discarded, so output is identical either way; only speed changes.
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
# ordinary content with any tool call still buried inside it — which would break exactly the
# agentic tool use this model is strongest at.
#
# --kv-cache-dtype fp8 and --max-model-len 262144 follow the model's own vLLM recipe. The
# cache is unusually cheap here (compressed-latent attention stores ~44 KB per token across
# all 78 layers, and each pipeline stage holds only its own 26), so 262K context is nowhere
# near the constraint that it would be on a conventional model of this size.
# ---------------------------------------------------------------------------------------
vllm serve "$MODEL" \
  --host 127.0.0.1 --port "$VLLM_PORT" \
  --served-model-name "$SERVED_NAME" \
  --tensor-parallel-size "$TP_SIZE" \
  --pipeline-parallel-size "$PP_SIZE" \
  --gpu-memory-utilization "$GPU_MEM_UTIL" \
  --max-model-len 262144 \
  --max-num-seqs 16 \
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
# The published port. Accounts are Open WebUI's own and nothing is pre-created here, so
# open the service URL and register as soon as this reports ready. Open WebUI makes the
# FIRST account the administrator and then switches signup off by itself, so that first
# visit is what claims the instance — until it happens, anyone who reaches the port can
# claim it instead. Signups after that, if you turn them back on in the admin panel, land
# as `pending` and see nothing until you approve them.
#
# CUDA_VISIBLE_DEVICES is emptied for this process only: Open WebUI pulls in torch and a
# sentence-transformers retrieval model, and left to itself it would claim VRAM the model
# needs — and at 0.97 utilisation across six cards there is none to spare. It has no use for
# the GPU, so it does not get one.
# ---------------------------------------------------------------------------------------
CUDA_VISIBLE_DEVICES= "$VENV/bin/open-webui" serve \
  --host 0.0.0.0 --port "$OWUI_PORT" &
OWUI_PID=$!

until (exec 3<>/dev/tcp/127.0.0.1/"$OWUI_PORT") 2>/dev/null; do
  kill -0 $OWUI_PID 2>/dev/null || { echo "[ocean] Open WebUI exited during startup" >&2; exit 1; }
  sleep 3
done
echo "[ocean] ready — open the service URL and create your account now; the first account created becomes the administrator"

# If either process dies the container stops, rather than leaving something that still looks
# Running and still bills while being unusable.
wait -n $VLLM_PID $OWUI_PID