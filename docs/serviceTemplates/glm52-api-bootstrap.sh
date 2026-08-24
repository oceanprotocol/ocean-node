#!/bin/bash
# GLM-5.2 (vLLM, 6 GPUs) as a published OpenAI-compatible API. One container, one escrow.
#
# This is the sibling of glm52-opencode.json with the agent removed and the endpoint moved
# outward. There is no UI and no workspace in this container: the consumer runs their own
# agent — opencode, Cline, Roo, aider, Continue — on their own machine, against their own
# files, and only prompts and diffs cross the wire. Nothing here ever sees the repository.
#
# SECURITY, and the reason for gate 2 below. The whole point of this template is that the
# raw /v1 endpoint IS published, which is exactly what glm52-opencode refuses to do. The node
# binds container ports straight to the host with no auth layer and no TLS in front of them,
# so the ONLY access control this service has is vLLM's own --api-key. VLLM_API_KEY is
# therefore mandatory and this script refuses to start without it.
#
# Two things follow from that, and neither is theoretical:
#   * The endpoint is plain http://. The key and every prompt travel in cleartext. Terminate
#     TLS at a reverse proxy in front of the node, or keep the port reachable only over a
#     VPN, before this carries anything that matters.
#   * --max-num-seqs 8 is the entire concurrency budget of a 753 GB model on six cards. A
#     leaked key does not merely steal tokens: it starves the paying consumer off their own
#     box for the remainder of the window.
#
# Everything else is inherited from the OpenCode sibling and the reasoning is not repeated
# here in full: -tp 2 -pp 3 is the only layout that fits, 0.95 utilisation is the only value
# with margin at both ends, the context is 131072 rather than 262144 because the pipeline
# stages are unbalanced in bytes, and the warm-up request is mandatory because three separate
# things in this stack allocate or compile on the FIRST request rather than at startup. See
# glm52-opencode-bootstrap.sh for the measured numbers behind each of those.
#
# The image is pinned to vllm/vllm-openai:glm52, NOT :latest. GLM-5.2 needs vLLM >= 0.23.0
# for GlmMoeDsaForCausalLM plus the glm47 tool parser and the glm45 reasoning parser.
set -euo pipefail

MODEL="zai-org/GLM-5.2-FP8"
SERVED_NAME="glm-5.2"
VLLM_PORT=8000        # THE PUBLISHED PORT — see the security note above

TP_SIZE=2
PP_SIZE=3
GPUS_REQUIRED=$((TP_SIZE * PP_SIZE))

GPU_MEM_UTIL="${VLLM_GPU_MEM_UTIL:-0.95}"
MAX_MODEL_LEN="${VLLM_MAX_MODEL_LEN:-131072}"
MAX_NUM_SEQS="${VLLM_MAX_NUM_SEQS:-8}"

BUCKET=/data/outputs

echo "[ocean] $(id)"

# ---------------------------------------------------------------------------------------
# Gate 1: the bucket. 753 GB of weights, plus the compile caches below. restartService builds
# a NEW container rather than restarting the old one, so without a bind at /data/outputs every
# relaunch re-downloads the whole model inside the paid window and recompiles every kernel.
# ---------------------------------------------------------------------------------------
if [ ! -d "$BUCKET" ]; then
  echo "[ocean] no persistent-storage bucket mounted at $BUCKET — refusing to start." \
    "753 GB of weights would download into the container layer, taking hours of your paid" \
    "window, and would be thrown away again on stop. Select a bucket when launching and" \
    "relaunch." >&2
  exit 1
fi

# ---------------------------------------------------------------------------------------
# Gate 2: the API key. See the security note at the top of this file. Unlike the OpenCode
# sibling, which keeps vLLM on loopback and publishes an authenticated UI instead, this
# template publishes the inference API itself. vLLM checks --api-key on every /v1 route and
# nothing else in the path checks anything, so an unset key is an open frontier model on a
# public IP for the whole escrow window.
# ---------------------------------------------------------------------------------------
if [ -z "${VLLM_API_KEY:-}" ]; then
  echo "[ocean] VLLM_API_KEY is not set — refusing to start. This template publishes the" \
    "raw OpenAI-compatible endpoint, and vLLM's --api-key is its only access control:" \
    "without it, anyone who finds the host and port gets a 744B model on six H200s at your" \
    "expense, and at --max-num-seqs $MAX_NUM_SEQS they take the box with you still on it." \
    "Set VLLM_API_KEY (24+ characters, generated not chosen) and relaunch." >&2
  exit 1
fi
export VLLM_API_KEY
echo "[ocean] API key set (${#VLLM_API_KEY} chars) — every /v1 route requires it"

# ---------------------------------------------------------------------------------------
# Gate 3: the cards. torch rather than nvidia-smi — it reports what vLLM will actually see
# (it honours CUDA_VISIBLE_DEVICES, and a missing driver reads as 0 rather than as a missing
# binary). Checked before the download, because a wrong resource selection would otherwise
# surface hours later.
# ---------------------------------------------------------------------------------------
GPU_COUNT=$(python3 -c 'import torch; print(torch.cuda.device_count())' 2>/dev/null || echo 0)
if [ "$GPU_COUNT" -lt "$GPUS_REQUIRED" ]; then
  echo "[ocean] this bundle needs $GPUS_REQUIRED GPUs and the container can see $GPU_COUNT." \
    "The model is 753 GB in FP8 and is split tensor-parallel $TP_SIZE by pipeline-parallel" \
    "$PP_SIZE; it cannot run on fewer cards, and no smaller layout exists for it. Relaunch" \
    "asking for $GPUS_REQUIRED GPUs, on a node that has $GPUS_REQUIRED free." >&2
  exit 1
fi
echo "[ocean] $GPU_COUNT GPU(s) visible — using $GPUS_REQUIRED as -tp $TP_SIZE -pp $PP_SIZE"
if [ -n "${VLLM_PP_LAYER_PARTITION:-}" ]; then
  echo "[ocean] custom pipeline layer partition: $VLLM_PP_LAYER_PARTITION (must sum to 78)"
fi

# ---------------------------------------------------------------------------------------
# Gate 4: shared memory. THE multi-GPU prerequisite and the one thing this bundle cannot work
# around from inside the container. One worker process per GPU, all passing tensors and NCCL
# bootstrap traffic through /dev/shm; Docker's default private 64 MB hangs or dies with a bus
# error that looks like a model problem and is not. The node operator fixes it once, on the
# GPU resources in the node config:
#
#   "init": { "advanced": { "ShmSize": 17179869184, "PidsLimit": 4096 } }
#
# (see ocean-node docs/compute.md, "Multi-GPU workloads"). 8 GiB is the floor checked here.
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

# ---------------------------------------------------------------------------------------
# Caches, all on the bucket. HF_HOME is shared with the sibling templates on purpose —
# huggingface_hub locks correctly and 753 GB is worth not duplicating.
#
# VLLM_CACHE_ROOT and TRITON_CACHE_DIR are the reason a second launch is fast rather than
# merely download-free: torch.compile artifacts and Triton's JIT output otherwise live under
# $HOME in the container layer and are destroyed with it, so every relaunch pays the full
# compile-and-warm-up cost again on six workers.
# ---------------------------------------------------------------------------------------
export HF_HOME="$BUCKET/hf"
export VLLM_CACHE_ROOT="$BUCKET/vllm-cache"
export TRITON_CACHE_DIR="$BUCKET/triton-cache"
mkdir -p "$HF_HOME" "$VLLM_CACHE_ROOT" "$TRITON_CACHE_DIR"

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
# environment by itself; this repository is ungated, so the token only buys rate limit and
# download speed — worth setting for 141 shards.
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

# See the sibling for the full note: the pipeline P2P communicators created on the first
# request cost ~100 MB each at NCCL's default 16 channels and roughly half that at 8, and
# this layout is latency-bound rather than bandwidth-bound. (NCCL_CUMEM_ENABLE is deliberately
# untouched — vLLM sets it to 0 itself to work around an NCCL bug.)
export NCCL_MAX_NCHANNELS="${NCCL_MAX_NCHANNELS:-8}"

# Multi-token prediction, off by default, opt in with ENABLE_MTP=true. With pipeline
# parallelism and a single caller, two of three stages are idle at any instant, and MTP is the
# intended answer — the repo ships a prediction head the full model verifies in one pass, so
# output is identical and only speed changes. It is off by default because --speculative-config
# is the flag most likely to be rejected outright by a given vLLM build, and a rejected flag
# means the server never starts, which costs a paid window.
#
# Expanded below as ${VLLM_EXTRA_ARGS[@]+"..."} rather than plain "${VLLM_EXTRA_ARGS[@]}":
# under `set -u`, expanding an EMPTY array is an unbound-variable error on bash before 4.4.
VLLM_EXTRA_ARGS=()
if [ "${ENABLE_MTP:-false}" = "true" ]; then
  VLLM_EXTRA_ARGS+=(--speculative-config '{"method":"mtp","num_speculative_tokens":3}')
  echo "[ocean] MTP speculative decoding enabled"
fi

# ---------------------------------------------------------------------------------------
# vLLM, published on 0.0.0.0 behind --api-key.
#
# --reasoning-parser and --tool-call-parser are what make this endpoint usable by an agent
# rather than just a chat client, and they are the two flags a hand-rolled launch forgets.
# GLM's chat template opens every assistant turn with a thinking block: without
# --reasoning-parser that text is returned as ordinary content with any tool call still buried
# inside it, and without --tool-call-parser plus --enable-auto-tool-choice the server rejects
# tool_choice:"auto" outright with a 400 — which is every request opencode, Cline and Continue
# send. A client that cannot call a tool cannot read a file.
#
# --max-model-len is $MAX_MODEL_LEN, not the recipe's 262144, for the stage-imbalance reason
# documented in the sibling. --max-num-seqs is 8: concurrency costs memory twice on the
# tightest stage (activation peak and the CUDA graph capture set, and graph memory sits inside
# the utilisation budget since vLLM 0.21.0). Raise it with VLLM_MAX_NUM_SEQS only after
# reading the per-stage KV lines in the log.
# ---------------------------------------------------------------------------------------
vllm serve "$MODEL" \
  --host 0.0.0.0 --port "$VLLM_PORT" \
  --api-key "$VLLM_API_KEY" \
  --served-model-name "$SERVED_NAME" \
  --tensor-parallel-size "$TP_SIZE" \
  --pipeline-parallel-size "$PP_SIZE" \
  --gpu-memory-utilization "$GPU_MEM_UTIL" \
  --max-model-len "$MAX_MODEL_LEN" \
  --max-num-seqs "$MAX_NUM_SEQS" \
  --kv-cache-dtype fp8 \
  --reasoning-parser glm45 \
  --tool-call-parser glm47 \
  --enable-auto-tool-choice \
  ${VLLM_EXTRA_ARGS[@]+"${VLLM_EXTRA_ARGS[@]}"} &
VLLM_PID=$!

# The port opens when uvicorn binds, which is after every worker has loaded its shard, so this
# is a real readiness signal. kill -0 turns a dead loader into an immediate exit rather than an
# endless wait. The timeout is the other half: with six workers reading 753 GB off disk, a
# wedged NCCL rendezvous neither exits nor binds — it just sits there billing.
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
echo "[ocean] vLLM serving $SERVED_NAME on 0.0.0.0:$VLLM_PORT across $GPUS_REQUIRED GPUs"

# ---------------------------------------------------------------------------------------
# Warm-up, and the reason it is not optional. Three things in this stack allocate memory or
# compile code on the FIRST real request rather than at startup: the lazily created pipeline
# P2P communicators, the flashmla sparse-prefill workspace, and a Triton kernel that JITs
# mid-inference. A bound port therefore proves the weights loaded and proves nothing about
# whether this service can answer.
#
# This variant asks one extra question the OpenCode sibling does not need to: it sends a TOOL
# DEFINITION with tool_choice:"auto", because a wrong or missing parser flag fails exactly
# there — HTTP 400, on the consumer's first agent request, hours after the download was paid
# for. Proving it here costs one request.
#
# It authenticates like any other client would, which also proves the key is actually enforced.
# ---------------------------------------------------------------------------------------
echo "[ocean] warming up: prefill, decode, and one tool call to prove the parsers are wired"
if ! SERVED_NAME="$SERVED_NAME" VLLM_PORT="$VLLM_PORT" python3 <<'PY'
import json, os, sys, urllib.error, urllib.request

served, port = os.environ['SERVED_NAME'], os.environ['VLLM_PORT']
key = os.environ['VLLM_API_KEY']

# ~6K tokens of filler: enough to cross the length threshold where the sparse-attention
# prefill kernel is chosen over the dense one, since that is the path allocating a workspace
# outside vLLM's profiled budget. max_tokens=16 also exercises the decode P2P path, which is
# where the first-request OOM actually surfaces.
filler = 'The quick brown fox jumps over the lazy dog. ' * 700


def post(body, what):
    req = urllib.request.Request(
        f'http://127.0.0.1:{port}/v1/chat/completions',
        data=json.dumps(body).encode(),
        headers={'Content-Type': 'application/json', 'Authorization': f'Bearer {key}'}
    )
    try:
        with urllib.request.urlopen(req, timeout=900) as resp:
            return json.load(resp)
    except urllib.error.HTTPError as e:
        sys.exit(f'[ocean] {what} returned HTTP {e.code}: {e.read()[:400]!r}')
    except Exception as e:
        sys.exit(f'[ocean] {what} failed: {e}')


post({
    'model': served,
    'messages': [{'role': 'user', 'content': filler + '\nReply with the single word: ready'}],
    'max_tokens': 16,
    'temperature': 0,
}, 'warm-up request')
print('[ocean] prefill and decode both work', flush=True)

# The agent-shaped request. A missing --tool-call-parser / --enable-auto-tool-choice pair is a
# 400 here and nowhere else; whether the model chooses to call the tool is not asserted, only
# that the server accepts and parses the shape.
post({
    'model': served,
    'messages': [{'role': 'user', 'content': 'List the files in /tmp using the tool.'}],
    'tools': [{
        'type': 'function',
        'function': {
            'name': 'list_dir',
            'description': 'List a directory',
            'parameters': {
                'type': 'object',
                'properties': {'path': {'type': 'string'}},
                'required': ['path'],
            },
        },
    }],
    'tool_choice': 'auto',
    'max_tokens': 128,
    'temperature': 0,
}, 'tool-calling check')
print('[ocean] tool calling accepted — the parsers are wired correctly')
PY
then
  echo "[ocean] the model server loaded its weights but failed the self-test, so this service" \
    "is not being published. If the failure was HTTP 400 naming tool choice, this image does" \
    "not know the glm47 tool parser — the tag is wrong, or the flag spelling changed. If the" \
    "vLLM log above ends in NCCL's \"Cuda failure 2 'out of memory'\" from irecv_tensor_dict," \
    "the cards are too full for the pipeline communicators created on the first request:" \
    "lower VLLM_GPU_MEM_UTIL (currently $GPU_MEM_UTIL) by 0.01 at a time, but not below the" \
    "point where the KV cache still holds one full VLLM_MAX_MODEL_LEN ($MAX_MODEL_LEN)" \
    "context, or the next launch fails at startup instead with a ValueError naming the" \
    "shortfall. If both ends are squeezed, balance the pipeline stages with" \
    "VLLM_PP_LAYER_PARTITION rather than trading one failure for the other. Exiting rather" \
    "than billing a service that dies on the first prompt." >&2
  kill $VLLM_PID 2>/dev/null || true
  exit 1
fi

echo "[ocean] ready — point your local agent at http://<host>:<port>/v1 with the API key you set"
echo "[ocean] model id for client config: $SERVED_NAME (context $MAX_MODEL_LEN)"

# If vLLM dies the container stops, rather than leaving something that still looks Running and
# still bills while being unusable.
wait $VLLM_PID
