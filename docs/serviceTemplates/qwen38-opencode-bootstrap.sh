#!/bin/bash
# Qwen3.8-27B (vLLM) + OpenCode in one container, one escrow.
#
# Only 8080 is published, and it is OpenCode's own HTTP server. vLLM binds 127.0.0.1, so the
# raw OpenAI-compatible API — which answers anyone who reaches it — is not exposed at all.
# The model runs tensor-parallel size 1, so nothing here needs a large /dev/shm or ipc=host,
# neither of which the node passes through on the service path.
#
# SECURITY, and the reason for gate 2 below: OpenCode is a coding AGENT, not a chat UI. Its
# tools read and write files and run shell commands inside this container. An unauthenticated
# OpenCode on a public port is remote code execution by design, which is a strictly worse
# failure than an unclaimed chat account. OPENCODE_SERVER_PASSWORD is therefore mandatory and
# this script refuses to start without it.
set -euo pipefail

MODEL="Qwen/Qwen3.8-27B-FP8"
SERVED_NAME="qwen3.8-27b"
VLLM_PORT=8000        # loopback only
OC_PORT=8080          # the published port
OC_VERSION="${OPENCODE_VERSION:-1.18.19}"   # pinned; see the note above the installer

BUCKET=/data/outputs
# Namespaced per template, not shared: a consumer may point both this template and the
# Muse-Glimmer sibling at the same bucket, and two containers writing one OpenCode session
# store corrupts it. The Hugging Face cache below IS shared — huggingface_hub locks
# correctly and the reuse is worth it.
OC_HOME="$BUCKET/opencode-home-qwen38"      # becomes $HOME: binary, config, sessions, caches
WORKSPACE="$BUCKET/workspace-qwen38"        # the project directory OpenCode operates on

echo "[ocean] $(id)"

# ---------------------------------------------------------------------------------------
# Gate 1: the bucket. It holds 31 GB of weights, the OpenCode binary and every session,
# message and file OpenCode writes. restartService creates a NEW container rather than
# restarting the old one, so without a bind at /data/outputs every relaunch re-downloads
# everything inside the paid window AND loses your code and your chat history. Fail here,
# where the log says why.
# ---------------------------------------------------------------------------------------
if [ ! -d "$BUCKET" ]; then
  echo "[ocean] no persistent-storage bucket mounted at $BUCKET — refusing to start." \
    "31 GB of weights would download into the container, and the workspace OpenCode edits" \
    "would be destroyed on stop. Select a bucket when launching and relaunch." >&2
  exit 1
fi

# ---------------------------------------------------------------------------------------
# Gate 2: the password. See the security note at the top of this file. HTTP basic auth is
# the only access control OpenCode's server has, it is off unless OPENCODE_SERVER_PASSWORD
# is set, and everything behind it — the web UI, the REST API and the SSE event stream —
# can run shell commands in this container.
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
# One knob for all persistence: OpenCode follows $HOME and the XDG defaults under it, and
# its installer hardcodes $HOME/.opencode/bin. Pointing HOME at the bucket therefore keeps
# the binary, the global config, the npm packages it fetches for the provider, and every
# session and message on the bucket, with nothing else to wire up.
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
# generated by the GPU in this container.
#
# `options` on the model entry is forwarded to the request body only for parameters the
# OpenAI-compatible client knows. temperature and top_p arrive; anything else (top_k,
# reasoning_effort) is dropped, which is why sampling defaults that vLLM must enforce are
# passed to `vllm serve` instead.
# ---------------------------------------------------------------------------------------
mkdir -p "$HOME/.config/opencode"
SERVED_NAME="$SERVED_NAME" VLLM_PORT="$VLLM_PORT" python3 - "$HOME/.config/opencode/opencode.json" <<'PY'
import json, os, sys

served, port = os.environ['SERVED_NAME'], os.environ['VLLM_PORT']
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
            'name': 'Qwen3.8-27B on this GPU (vLLM)',
            'options': {
                'baseURL': f'http://127.0.0.1:{port}/v1',
                'apiKey': 'local'      # vLLM has no key set; it is not reachable off-host
            },
            'models': {
                served: {
                    'name': 'Qwen3.8-27B FP8 (262K context, vision)',
                    'attachment': True,
                    'reasoning': True,
                    'tool_call': True,
                    'temperature': True,
                    'interleaved': 'reasoning_content',  # the field vLLM's parser emits
                    'modalities': {'input': ['text', 'image'], 'output': ['text']},
                    'limit': {'context': 262144, 'output': 65536}
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
export HF_HOME="$BUCKET/hf"
mkdir -p "$HF_HOME"

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
# vLLM, on loopback. --reasoning-parser is mandatory, not cosmetic: the chat template opens
# every assistant turn with a thinking block, and without the parser that text is returned as
# ordinary content with any tool call still buried inside it — which would leave OpenCode
# unable to call a single tool. --kv-cache-dtype fp8 and --max-model-len 262144 are from the
# model's own vLLM recipe.
#
# Not enabled here, deliberately: the recipe also offers
#   --speculative-config '{"method":"mtp","num_speculative_tokens":3}'
# and the FP8 repo does ship mtp.safetensors. It would cut latency, but speculative decoding
# on top of this model's hybrid linear attention is an untested combination and a startup
# failure costs a paid window. Add it once you have watched this template start cleanly.
# ---------------------------------------------------------------------------------------
vllm serve "$MODEL" \
  --host 127.0.0.1 --port "$VLLM_PORT" \
  --served-model-name "$SERVED_NAME" \
  --gpu-memory-utilization 0.90 \
  --max-model-len 262144 \
  --max-num-seqs 16 \
  --kv-cache-dtype fp8 \
  --reasoning-parser qwen3 \
  --tool-call-parser qwen3_coder \
  --enable-auto-tool-choice &
VLLM_PID=$!

# The port opens when uvicorn binds, which is after the weights are loaded, so this is a real
# readiness signal. kill -0 turns a dead loader into an immediate exit, not an endless wait.
until (exec 3<>/dev/tcp/127.0.0.1/"$VLLM_PORT") 2>/dev/null; do
  kill -0 $VLLM_PID 2>/dev/null || { echo "[ocean] vLLM exited during startup" >&2; exit 1; }
  sleep 10
done
echo "[ocean] vLLM serving $SERVED_NAME on 127.0.0.1:$VLLM_PORT"

# ---------------------------------------------------------------------------------------
# The published port. `serve` rather than `web`: both host the same browser UI on the same
# port, but `web` also tries to open a local browser, which has nothing to open in a
# container. Basic auth covers every route on it — the UI, the REST API and the /event
# stream all answer 401 without credentials.
#
# It runs from $WORKSPACE, which is the project OpenCode reads and edits, and which lives on
# the bucket. CUDA_VISIBLE_DEVICES is emptied for this process only: OpenCode has no use for
# the GPU, and this guarantees it cannot take VRAM the model needs.
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
