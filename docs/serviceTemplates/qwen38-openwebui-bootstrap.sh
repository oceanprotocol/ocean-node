#!/bin/bash
# Qwen3.8-27B (vLLM) + Open WebUI in one container, one escrow.
#
# Only 8080 is published. vLLM binds 127.0.0.1, so the raw OpenAI-compatible API — which
# answers anyone who reaches it — is not exposed at all, and Open WebUI's own login is the
# single front door. The model runs tensor-parallel size 1, so nothing here needs a large
# /dev/shm or ipc=host, neither of which the node passes through on the service path.
set -euo pipefail

MODEL="Qwen/Qwen3.8-27B-FP8"
SERVED_NAME="qwen3.8-27b"
VLLM_PORT=8000        # loopback only
OWUI_PORT=8080        # the published port
OWUI_BOOTSTRAP_PORT=8081  # loopback only, first launch, to claim the admin account

BUCKET=/data/outputs
# Namespaced per template, not shared: a consumer may point both this template and the
# Muse-Glimmer sibling at the same bucket, and two containers writing one Open WebUI sqlite
# file corrupts it, while two racing to create one venv leaves it half-built. The Hugging
# Face cache below IS shared — huggingface_hub locks correctly and the reuse is worth it.
VENV="$BUCKET/owui-venv-qwen38"
OWUI_DATA="$BUCKET/openwebui-qwen38"
ADMIN_SENTINEL="$OWUI_DATA/.ocean-admin-created"

echo "[ocean] $(id)"

# ---------------------------------------------------------------------------------------
# Gate 1: the bucket. It holds 31 GB of weights, the Open WebUI virtualenv and Open WebUI's
# database. restartService creates a NEW container rather than restarting the old one, so
# without a bind at /data/outputs every relaunch re-downloads everything inside the paid
# window AND loses every chat, prompt and account. Fail here, where the log says why.
# ---------------------------------------------------------------------------------------
if [ ! -d "$BUCKET" ]; then
  echo "[ocean] no persistent-storage bucket mounted at $BUCKET — refusing to start." \
    "31 GB of weights would download into the container, and your chat history and admin" \
    "account would be destroyed on stop. Select a bucket when launching and relaunch." >&2
  exit 1
fi

# ---------------------------------------------------------------------------------------
# Gate 2: admin credentials. The node publishes 8080 straight onto its public host. A fresh
# Open WebUI hands administrator rights to whoever signs up first, so on a public address
# that is a race against port scanners. We claim the account on loopback before 8080 is ever
# served, then disable signup — but only if we were given credentials to claim it with.
# ---------------------------------------------------------------------------------------
if [ -z "${WEBUI_ADMIN_EMAIL:-}" ] || [ -z "${WEBUI_ADMIN_PASSWORD:-}" ]; then
  echo "[ocean] WEBUI_ADMIN_EMAIL and WEBUI_ADMIN_PASSWORD are required — refusing to start." \
    "Without them the first visitor to the public port would become the administrator." \
    "Set both on this service and relaunch." >&2
  exit 1
fi

# ---------------------------------------------------------------------------------------
# Gate 3: the interpreter. open-webui declares requires_python >=3.11,<3.13. If the base
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

mkdir -p "$OWUI_DATA"

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

# Shared Open WebUI settings for both the bootstrap pass and the public one.
export DATA_DIR="$OWUI_DATA"
export ENABLE_PERSISTENT_CONFIG=False   # else the DB copy of ENABLE_SIGNUP wins on relaunch
export DEFAULT_USER_ROLE=pending        # anyone who does get in later has no access
export ENABLE_OLLAMA_API=false          # no Ollama in this image; hides a dead connection
export OPENAI_API_BASE_URL="http://127.0.0.1:$VLLM_PORT/v1"
export OPENAI_API_KEY=local             # vLLM has no key set; it is not reachable off-host

# ---------------------------------------------------------------------------------------
# vLLM, on loopback. --reasoning-parser is mandatory, not cosmetic: the chat template opens
# every assistant turn with a thinking block, and without the parser that text is returned as
# ordinary content with any tool call still buried inside it. --kv-cache-dtype fp8 and
# --max-model-len 262144 are from the model's own vLLM recipe.
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
# First launch only: claim the administrator account on loopback, before anything is served
# on the published port. The first account created in a fresh Open WebUI is the admin, so
# doing this on 127.0.0.1 removes the race entirely rather than narrowing it.
#
# The sentinel, not the presence of webui.db, is the marker — the database exists as soon as
# Open WebUI boots, whether or not the signup succeeded.
#
# Credentials go to the child through the environment, never argv, so they stay out of ps.
# ---------------------------------------------------------------------------------------
if [ ! -f "$ADMIN_SENTINEL" ]; then
  echo "[ocean] first launch — claiming the admin account on loopback"
  ENABLE_SIGNUP=true "$VENV/bin/open-webui" serve \
    --host 127.0.0.1 --port "$OWUI_BOOTSTRAP_PORT" &
  BOOT_PID=$!

  until (exec 3<>/dev/tcp/127.0.0.1/"$OWUI_BOOTSTRAP_PORT") 2>/dev/null; do
    kill -0 $BOOT_PID 2>/dev/null || {
      echo "[ocean] Open WebUI exited during the admin bootstrap pass" >&2; exit 1; }
    sleep 3
  done

  if OWUI_URL="http://127.0.0.1:$OWUI_BOOTSTRAP_PORT/api/v1/auths/signup" python3 - <<'PY'
import json, os, sys, time, urllib.error, urllib.request

url = os.environ['OWUI_URL']
body = json.dumps({
    'name': os.environ['WEBUI_ADMIN_EMAIL'].split('@')[0] or 'admin',
    'email': os.environ['WEBUI_ADMIN_EMAIL'],
    'password': os.environ['WEBUI_ADMIN_PASSWORD'],
}).encode()

# The port is open a moment before the routes are mounted, so retry briefly rather than
# treating the first 404/503 as fatal.
for attempt in range(10):
    req = urllib.request.Request(url, data=body,
                                 headers={'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            payload = json.loads(r.read() or b'{}')
        if payload.get('role') == 'admin':
            print('[ocean] admin account created')
            sys.exit(0)
        print('[ocean] signup returned role=%r, expected admin' % payload.get('role'),
              file=sys.stderr)
        sys.exit(1)
    except urllib.error.HTTPError as e:
        detail = e.read().decode(errors='replace')[:300]
        # An existing account means a previous launch created it but never wrote the
        # sentinel. That is the desired end state, so accept it.
        if e.code == 400 and 'taken' in detail.lower():
            print('[ocean] admin account already exists')
            sys.exit(0)
        print('[ocean] signup HTTP %d: %s' % (e.code, detail), file=sys.stderr)
        sys.exit(1)
    except urllib.error.URLError as e:
        print('[ocean] signup not reachable yet (%s), retrying' % e.reason, file=sys.stderr)
        time.sleep(3)
sys.exit(1)
PY
  then
    touch "$ADMIN_SENTINEL"
  else
    echo "[ocean] could not create the admin account — refusing to publish an unclaimed" \
      "Open WebUI on a public port, because the first visitor would become its" \
      "administrator. Check the password length and the log above, then relaunch." >&2
    kill $BOOT_PID 2>/dev/null || true
    exit 1
  fi

  # Free the DATA_DIR sqlite file and the port before the public pass takes over.
  kill $BOOT_PID 2>/dev/null || true
  wait $BOOT_PID 2>/dev/null || true
  echo "[ocean] admin claimed; signup will be disabled on the public port"
else
  echo "[ocean] admin account already on the bucket from an earlier launch"
fi

# ---------------------------------------------------------------------------------------
# The published port. Signup off, so the admin account is the only way in.
#
# CUDA_VISIBLE_DEVICES is emptied for this process only: Open WebUI pulls in torch and a
# sentence-transformers retrieval model, and left to itself it would claim VRAM the model
# needs. It has no use for the GPU, so it does not get one.
# ---------------------------------------------------------------------------------------
CUDA_VISIBLE_DEVICES= ENABLE_SIGNUP=false "$VENV/bin/open-webui" serve \
  --host 0.0.0.0 --port "$OWUI_PORT" &
OWUI_PID=$!

until (exec 3<>/dev/tcp/127.0.0.1/"$OWUI_PORT") 2>/dev/null; do
  kill -0 $OWUI_PID 2>/dev/null || { echo "[ocean] Open WebUI exited during startup" >&2; exit 1; }
  sleep 3
done
echo "[ocean] ready — open the service URL and sign in as $WEBUI_ADMIN_EMAIL"

# If either process dies the container stops, rather than leaving something that still looks
# Running and still bills while being unusable.
wait -n $VLLM_PID $OWUI_PID
