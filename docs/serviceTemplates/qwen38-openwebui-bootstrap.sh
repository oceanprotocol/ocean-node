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
OWUI_BOOTSTRAP_PORT=8081  # loopback only, to verify the admin account before publishing

BUCKET=/data/outputs
# Namespaced per template, not shared: a consumer may point both this template and the
# Muse-Glimmer sibling at the same bucket, and two containers writing one Open WebUI sqlite
# file corrupts it, while two racing to create one venv leaves it half-built. The Hugging
# Face cache below IS shared — huggingface_hub locks correctly and the reuse is worth it.
VENV="$BUCKET/owui-venv-qwen38"
OWUI_DATA="$BUCKET/openwebui-qwen38"

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
# that is a race against port scanners. These two names are Open WebUI's own headless-admin
# variables: it creates the account itself at startup from them (see the admin section below),
# and without them there is nothing to create, so refuse here.
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

# Shared Open WebUI settings for both the verification pass and the public one.
export DATA_DIR="$OWUI_DATA"
export ENABLE_PERSISTENT_CONFIG=False   # else the DB copy of ENABLE_SIGNUP wins on relaunch
export ENABLE_SIGNUP=false              # the admin account is the only way in
export UVICORN_WORKERS=1                # >1 makes uvicorn bind the socket before startup runs
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
# The administrator account. Open WebUI creates it itself: WEBUI_ADMIN_EMAIL and
# WEBUI_ADMIN_PASSWORD are its own headless-deployment variables, and at application startup
# it inserts that account with role=admin and switches signup off (main.py -> create_admin_user).
# So there is nothing for this script to POST. An earlier version of it called
# /api/v1/auths/signup afterwards and got "403 You do not have permission to access this
# resource": by then a user existed and signup was already disabled, so the gate in
# routers/auths.py rejected it — while the account it was trying to create was in fact there.
#
# uvicorn awaits lifespan startup before it binds the listening socket, so the account exists
# before anything can connect, on the public port as much as here. What is NOT safe to assume
# is that creation succeeded: if it silently failed the database is empty, and Open WebUI
# deliberately lets the FIRST account be created regardless of ENABLE_SIGNUP, so the first
# visitor to 8080 would become administrator. Hence one loopback boot to sign in with the
# supplied credentials, and only a successful admin login publishes the port.
#
# No sentinel: create_admin_user is a no-op once any user exists, so this is also the relaunch
# path, and it re-checks rather than trusting a marker file. Credentials go to the child
# through the environment, never argv, so they stay out of ps.
# ---------------------------------------------------------------------------------------
echo "[ocean] verifying the admin account on loopback before publishing"
"$VENV/bin/open-webui" serve --host 127.0.0.1 --port "$OWUI_BOOTSTRAP_PORT" &
BOOT_PID=$!

until (exec 3<>/dev/tcp/127.0.0.1/"$OWUI_BOOTSTRAP_PORT") 2>/dev/null; do
  kill -0 $BOOT_PID 2>/dev/null || {
    echo "[ocean] Open WebUI exited during the admin verification pass" >&2; exit 1; }
  sleep 3
done

if ! OWUI_URL="http://127.0.0.1:$OWUI_BOOTSTRAP_PORT/api/v1/auths/signin" python3 - <<'PY'
import json, os, sys, time, urllib.error, urllib.request

url = os.environ['OWUI_URL']
body = json.dumps({
    'email': os.environ['WEBUI_ADMIN_EMAIL'],
    'password': os.environ['WEBUI_ADMIN_PASSWORD'],
}).encode()

# The port is open a moment before the routes are mounted, so retry briefly rather than
# treating the first connection failure as fatal.
for attempt in range(10):
    req = urllib.request.Request(url, data=body,
                                 headers={'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            payload = json.loads(r.read() or b'{}')
    except urllib.error.HTTPError as e:
        detail = e.read().decode(errors='replace')[:300]
        print('[ocean] signin HTTP %d: %s' % (e.code, detail), file=sys.stderr)
        # 4xx is a real answer — wrong credentials, no such account — and retrying cannot
        # change it. A 5xx can be a database still settling, so give that one more go.
        if e.code < 500:
            sys.exit(1)
        time.sleep(3)
        continue
    except urllib.error.URLError as e:
        print('[ocean] signin not reachable yet (%s), retrying' % e.reason, file=sys.stderr)
        time.sleep(3)
        continue
    role = payload.get('role')
    if role == 'admin':
        print('[ocean] admin account verified')
        sys.exit(0)
    print('[ocean] the account for this email has role=%r, not admin — an earlier, different'
          ' account on this bucket took the administrator slot' % role, file=sys.stderr)
    sys.exit(1)
sys.exit(1)
PY
then
  echo "[ocean] the administrator account is missing or the credentials do not match it —" \
    "refusing to publish an unclaimed Open WebUI on a public port, because Open WebUI lets" \
    "the first account be created even with signup disabled, so the first visitor would" \
    "become its administrator. If this bucket was used before, supply the credentials that" \
    "were used then, or select a fresh bucket. Then relaunch." >&2
  kill $BOOT_PID 2>/dev/null || true
  exit 1
fi

# Free the DATA_DIR sqlite file and the port before the public pass takes over.
kill $BOOT_PID 2>/dev/null || true
wait $BOOT_PID 2>/dev/null || true

# ---------------------------------------------------------------------------------------
# The published port. Signup off, so the admin account is the only way in.
#
# CUDA_VISIBLE_DEVICES is emptied for this process only: Open WebUI pulls in torch and a
# sentence-transformers retrieval model, and left to itself it would claim VRAM the model
# needs. It has no use for the GPU, so it does not get one.
# ---------------------------------------------------------------------------------------
CUDA_VISIBLE_DEVICES= "$VENV/bin/open-webui" serve \
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
