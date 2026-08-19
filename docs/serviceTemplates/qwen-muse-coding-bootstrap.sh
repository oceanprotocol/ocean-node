#!/bin/bash
# Two OpenAI-compatible coding endpoints on ONE GPU. Both run with tensor-parallel size 1,
# which is what keeps this template shippable today: service containers get Docker's default
# 64 MB /dev/shm and no ipc=host (the node applies ShmSize/IpcMode only on the compute-job
# path), and a single-GPU vLLM never needs either. Splitting one model across GPUs does.
set -euo pipefail

MODEL_A="Qwen/Qwen3.8-27B-FP8"
MODEL_B="RedHatAI/Muse-Glimmer-30B-FP8-block"

echo "[ocean] $(id)"

# ---------------------------------------------------------------------------------------
# Gate 1: the bucket. 65 GB of weights, and restartService creates a NEW container rather
# than restarting the old one, so without a bind at /data/outputs every relaunch re-downloads
# everything inside the already-paid window and discards it again on stop. Fail here, where
# the log says why, instead of an hour in.
# ---------------------------------------------------------------------------------------
if [ ! -d /data/outputs ]; then
  echo "[ocean] no persistent-storage bucket mounted at /data/outputs — refusing to start." \
    "65 GB of weights would download into the container and be thrown away on stop." \
    "Select a bucket when launching and relaunch. If you did select one, the node is not" \
    "applying outputBucketId: check that persistentStorage is configured on it." >&2
  exit 1
fi

# ---------------------------------------------------------------------------------------
# Gate 2: the API key. The node publishes container ports straight onto its host with no
# proxy and no auth of its own, and the resulting URL travels in the job record. A plain
# `vllm serve` answers anyone who reaches it, so an unset key means an open model on a public
# address for the whole escrow window. vLLM reads VLLM_API_KEY from the environment, so the
# key never appears in a command line, a template file or a process listing.
# ---------------------------------------------------------------------------------------
if [ -z "${VLLM_API_KEY:-}" ]; then
  echo "[ocean] VLLM_API_KEY is not set — refusing to expose unauthenticated inference on a" \
    "public port. Set VLLM_API_KEY on this service and relaunch, then send it to both" \
    "endpoints as 'Authorization: Bearer <key>'." >&2
  exit 1
fi
echo "[ocean] VLLM_API_KEY set — both endpoints require a bearer token"

export HF_HOME=/data/outputs/hf
mkdir -p "$HF_HOME"

# hf_transfer multiplies download throughput but is not in every vLLM image, and exporting the
# flag without the package makes huggingface_hub raise on first use. Probe, don't assume.
if python3 -c 'import hf_transfer' 2>/dev/null; then
  export HF_HUB_ENABLE_HF_TRANSFER=1
  echo "[ocean] hf_transfer available — using accelerated downloads"
else
  echo "[ocean] hf_transfer not installed — standard downloads"
fi

# ---------------------------------------------------------------------------------------
# Weights. snapshot_download rather than the `hf` CLI: huggingface_hub is a hard vLLM
# dependency so the Python API is always present, whereas the CLI entrypoint was renamed
# (huggingface-cli -> hf) and which name exists varies by image. It resumes, verifies against
# the remote ETag, and writes the blobs/snapshots/refs layout vLLM expects — none of which a
# hand-rolled curl loop would give us for free. It also picks up HF_TOKEN from the
# environment on its own; both repositories here are ungated, so the token is optional.
#
# The [models] lines are the markers nodes-dashboard parses for provisioning progress; the
# denominator matches includes[].length in the template.
# ---------------------------------------------------------------------------------------
fetch() {
  echo "[models] downloading $1"
  python3 - "$1" <<'PY'
import sys
from huggingface_hub import snapshot_download
snapshot_download(sys.argv[1], max_workers=8)
PY
}

fetch "$MODEL_A"
echo "[models] ready 1/2 $MODEL_A"
fetch "$MODEL_B"
echo "[models] ready 2/2 $MODEL_B"
echo "[models] bundle complete"

# ---------------------------------------------------------------------------------------
# Serve. Sequential, not parallel: each vLLM profiles free VRAM to size its KV cache, and two
# processes profiling simultaneously both see the whole card free and both over-commit. The
# second starts only once the first is listening, so it measures what is actually left.
#
# --gpu-memory-utilization is a fraction of TOTAL device memory, so the two must sum below 1.
# On a 141 GB H200: 0.55 = 77.6 GB for Qwen (27.8 GB weights, so ~48 GB of KV at 32 KB/token
# with fp8 cache — roughly 1.4M tokens) and 0.35 = 49.4 GB for Muse (29.8 GB weights, ~18 GB
# of KV at 13 KB/token — also ~1.4M tokens, since only 13 of its 52 layers are full attention
# and the other 39 are capped by a 2048-token sliding window). The remaining ~14 GB covers two
# CUDA contexts, both vision towers and fragmentation. Qwen additionally preallocates ~75 MB
# of Gated DeltaNet recurrent state per sequence across its 48 linear-attention layers, drawn
# from its own KV budget — which is why --max-num-seqs is bounded rather than left at default.
#
# --reasoning-parser is mandatory for both, not cosmetic: each chat template opens the
# assistant turn with a thinking block, and without the parser that text comes back as
# ordinary content with any tool call still buried inside it, which breaks agentic use.
#
# --kv-cache-dtype fp8 is set only for Qwen, where its own vLLM recipe specifies it. Muse has
# no published guidance for it and its KV is already cheap, so it stays at the model dtype.
#
# Not enabled here, deliberately: Qwen's recipe offers
#   --speculative-config '{"method":"mtp","num_speculative_tokens":3}'
# and the FP8 repo does ship mtp.safetensors. It would cut latency, but speculative decoding
# combined with hybrid linear attention is an untested three-way combination, and a startup
# failure costs a paid window. Add it once you have watched this template start cleanly.
# ---------------------------------------------------------------------------------------
vllm serve "$MODEL_A" \
  --host 0.0.0.0 --port 8000 \
  --served-model-name qwen3.8-27b \
  --gpu-memory-utilization 0.55 \
  --max-model-len 262144 \
  --max-num-seqs 16 \
  --kv-cache-dtype fp8 \
  --reasoning-parser qwen3 \
  --tool-call-parser qwen3_coder \
  --enable-auto-tool-choice &
P1=$!

# /dev/tcp probe rather than curl: the port opens when uvicorn binds, which is after weights
# are loaded, so this is a real readiness signal. kill -0 turns a dead loader into an
# immediate exit instead of an infinite wait.
until (exec 3<>/dev/tcp/127.0.0.1/8000) 2>/dev/null; do
  kill -0 $P1 2>/dev/null || { echo "[ocean] $MODEL_A exited during startup" >&2; exit 1; }
  sleep 10
done
echo "[ocean] $MODEL_A listening on 8000 as qwen3.8-27b"

vllm serve "$MODEL_B" \
  --host 0.0.0.0 --port 8001 \
  --served-model-name muse-glimmer-30b \
  --gpu-memory-utilization 0.35 \
  --max-model-len 131072 \
  --max-num-seqs 16 \
  --reasoning-parser muse_glimmer \
  --tool-call-parser muse_glimmer \
  --enable-auto-tool-choice &
P2=$!

until (exec 3<>/dev/tcp/127.0.0.1/8001) 2>/dev/null; do
  kill -0 $P2 2>/dev/null || { echo "[ocean] $MODEL_B exited during startup" >&2; exit 1; }
  sleep 10
done
echo "[ocean] $MODEL_B listening on 8001 as muse-glimmer-30b"
echo "[ocean] ready — POST /v1/chat/completions on 8000 (qwen3.8-27b) or 8001 (muse-glimmer-30b)"

# If either server dies the container stops, rather than leaving a half-working endpoint that
# still looks Running and still bills.
wait -n $P1 $P2
