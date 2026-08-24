#!/bin/bash
# DeepSeek Harness (dsh) + DeepSeek-V4-Flash on this node's GPUs, one container, one escrow.
#
# Only 8080 is published, and it is a Caddy reverse proxy that demands HTTP basic auth before
# anything reaches dsh. vLLM binds 127.0.0.1, so the raw OpenAI-compatible API — which answers
# anyone who reaches it — is not exposed at all. dsh also binds 127.0.0.1.
#
# SECURITY, and the reason for gate 2 below. DeepSeek Harness's web server has, in its own
# documentation (docs/subsystems/web-server.md): no TLS, no authentication, and no origin
# policy. Its agent reads and writes files and runs shell commands in this container. A
# non-loopback bind is therefore remote code execution by design, and unlike OpenCode there
# is no password flag to turn on — the harness ships no access control of any kind. So this
# template never lets dsh bind a public interface: it stays on 127.0.0.1:3080 (its own
# default) and the only thing on the published port is the auth proxy. That proxy is THIS
# TEMPLATE'S addition, not an official DeepSeek deployment pattern; upstream documents no
# supported way to expose dsh to a network.
#
# The proxy speaks HTTPS with a self-signed certificate, so basic auth and everything the agent
# shows you are encrypted. TLS is here for a second, non-negotiable reason: dsh's UI calls
# crypto.randomUUID() to open a workspace and browsers only expose that in a secure context, so
# an http:// deployment fails at the first required click for anyone not on localhost. Expect a
# one-time certificate interstitial — the container never learns the public hostname it is
# reached by, so no certificate it can obtain will be trusted, and accepting it is what creates
# the secure context. Identity is unproven; the encryption is real. The container boundary, not
# the password, is still the real isolation here.
#
# The other structural point: this model is 166.9 GB, which does not fit on one 141 GB card, so
# tensor parallelism is mandatory and there is no single-GPU configuration to fall back to.
# vLLM runs one worker process per card and those workers exchange tensors through POSIX shared
# memory, so the container needs a /dev/shm far larger than Docker's 64 MB default. The node
# operator supplies it per GPU resource via init.advanced (ShmSize, optionally IpcMode) — see
# docs/compute.md, "Multi-GPU workloads". Gate 4 checks it before the download starts, because
# discovering it afterwards costs the download instead of a second.
#
# The image is pinned to vllm/vllm-openai:v0.27.1, NOT :latest and NOT :nightly. V4-Flash needs
# a build carrying the deepseek_v4 tokenizer mode, tool-call parser and reasoning parser plus
# the fused-checkpoint support that landed in 0.25.0; an image without them refuses the flags
# and dies before loading a weight, and :nightly changes under you inside a paid window.
#
# WHAT IS VERIFIED AND WHAT IS NOT — read this before trusting a number below.
#   Verified from official sources: the checkpoint's 166.9 GB (its own index.json), its FP8/
#   fp4-expert quantisation, 43 layers / 64 heads / 256 experts / 1 048 576 max positions
#   (config.json), the deepseek_v4 vLLM flags (vLLM docs + vllm-project/recipes), dsh's npm
#   name/version and MIT licence, dsh's default 127.0.0.1:3080 bind and --no-open flag, the
#   settings.yaml provider block shape, and the skill discovery roots and their tiers.
#   Measured on 2x141 GB H200 rather than assumed: the weights load in their published
#   fp4-expert form at 74.37 GiB per card at tp=2, with the fp4 indexer cache disabled as
#   expected off Blackwell, and DSpark's draft module (~3.3 GiB per card) skipped while
#   ENABLE_DSPARK is false. It also SERVES: that launch passed the tool-calling warm-up and
#   answered on /v1/chat/completions, with 47.73 GiB of KV cache per card at utilisation 0.90
#   (2,446,666 tokens; 6.22x concurrency at a full 393216-token request) and engine init taking
#   456 s, most of it DeepGEMM warmup and the TileLang JIT.
#   STILL A DOCUMENTATION GAP rather than a verified layout: vLLM's recipe lists H200 only
#   under a prefill/decode-disaggregated deployment, so nothing upstream promises that plain
#   tensor parallelism keeps working here across versions. Loading is proven; the warm-up gate
#   below is what proves serving, in seconds, before a consumer is told the service is ready.
set -euo pipefail

MODEL="deepseek-ai/DeepSeek-V4-Flash-0731"
SERVED_NAME="deepseek-v4-flash"
VLLM_PORT=8000        # loopback only
DSH_PORT=3080         # loopback only — dsh's own default
TLS_PORT=8443         # the published port carrying the UI (Caddy: TLS + basic auth)
PROXY_PORT=8080       # published too, but only serves a "use the HTTPS port" page (see below)

DSH_VERSION="${DSH_VERSION:-0.1.1-rc.2}"      # pinned; dsh is a dev preview, see note below
NODE_VERSION="${NODE_VERSION:-24.19.0}"       # Node 24 LTS "Krypton"
CADDY_VERSION="${CADDY_VERSION:-2.11.4}"

# The parallel layout. 166.9 GB (155.4 GiB) of weights does not fit on one 141 GB card, so TP 2
# is the floor: measured at 74.37 GiB of weights per card, which leaves 47.73 GiB each for KV
# cache at the utilisation below. (74.37 x 2 is under 155.4 because DSpark's draft module is not
# loaded while ENABLE_DSPARK is false — turning it on costs about 3.3 GiB per card.) Tensor
# parallelism splits by whole attention heads and the model has 64, so 2/4/8 are legal and 6 is
# not — do not "use all six cards" by setting 6, vLLM will refuse to start. Raise to 4 for more
# KV cache (a 1M-token context) at the cost of two more cards.
TP_SIZE="${VLLM_TP_SIZE:-2}"
case "$TP_SIZE" in
  1) echo "[ocean] VLLM_TP_SIZE=1 cannot work: the checkpoint is 166.9 GB and the largest" \
       "card here is 141 GB. Use 2, 4 or 8." >&2; exit 1 ;;
  2|4|8) ;;
  *) echo "[ocean] VLLM_TP_SIZE=$TP_SIZE is not a divisor of the model's 64 attention heads" \
       "that vLLM accepts here. Use 2, 4 or 8." >&2; exit 1 ;;
esac
GPUS_REQUIRED="$TP_SIZE"

# 0.90, vLLM's default, kept deliberately after a measured launch on 2x141 GB H200 rather than
# left at the default by omission. The full accounting from that launch, per card:
#
#   weights + non-torch      75.31 GiB      peak activation      2.79 GiB
#   CUDA graph pool           0.13 GiB      KV cache            47.73 GiB
#   -> 2,446,666 tokens of KV, 6.22x concurrency at a 393216-token request
#
# and vLLM's own closing advice was that 59.26 GiB of KV would fit if the budget were raised.
# Nothing here is tight, which is worth writing down because STARTUP LOOKS LIKE IT IS. During
# the TileLang JIT phase the caching allocator emits a storm of
#   "memory allocation failed with OOM ... free: 9502720"
# warnings, because those kernels compile before the KV pool is carved out and the allocator is
# shedding cached blocks to make room. They are noise, not oversubscription: the same run went
# on to report 137.63 GiB free of 139.8 on startup and a graph pool that used 0.13 GiB against
# the 0.79 GiB it estimated. Do not "fix" them by lowering this number — that trades ~7 GiB of
# KV cache per card for nothing. If a future build genuinely runs out during capture, the log
# says so at capture time, and vLLM's suggested --kv-cache-memory is the precise instrument.
GPU_MEM_UTIL="${VLLM_GPU_MEM_UTIL:-0.90}"
# 393216 rather than the model's full 1 048 576, and not by accident: the model card's "Think
# Max" reasoning effort truncates unless the context is at least 393216, so this is the
# smallest window in which every reasoning mode actually works. At an estimated ~44 KB/token
# of FP8 KV cache (43 layers x 1 KV head x 512 head_dim x 2, from config.json — an ESTIMATE,
# the sparse-attention indexer cache is extra) that is roughly 17 GB, which TP 2 has room for
# several times over. Raise it toward 1048576 if you have the cards; the launch either serves
# or fails in the warm-up below, not hours later.
MAX_MODEL_LEN="${VLLM_MAX_MODEL_LEN:-393216}"

BUCKET=/data/outputs
# Namespaced per template rather than shared: a consumer may point this and a sibling template
# at the same bucket, and two containers writing one dsh session store corrupts it. The Hugging
# Face cache under $DSH_STATE is the one thing worth sharing, but huggingface_hub's locking is
# what makes that safe, so it stays inside this namespace too.
DSH_STATE="$BUCKET/dsh-v4flash"          # becomes $HOME: node, dsh, DSH_HOME, HF cache
WORKSPACE="$BUCKET/workspace-dsv4"       # the project directory the agent operates on

echo "[ocean] $(id)"

# ---------------------------------------------------------------------------------------
# Gate 1: the bucket. It holds 166.9 GB of weights, the Node runtime, dsh itself, dsh's
# sessions and settings, and the workspace the agent edits. restartService creates a NEW
# container rather than restarting the old one, so without a bind at /data/outputs every
# relaunch re-downloads everything inside the paid window AND destroys the code the agent
# wrote. Fail here, where the log says why.
# ---------------------------------------------------------------------------------------
if [ ! -d "$BUCKET" ]; then
  echo "[ocean] no persistent-storage bucket mounted at $BUCKET — refusing to start." \
    "166.9 GB of weights would download into the container, and the workspace dsh edits" \
    "would be destroyed on stop. Select a bucket when launching and relaunch." >&2
  exit 1
fi

# ---------------------------------------------------------------------------------------
# Gate 2: the password. See the security note at the top of this file. dsh has NO
# authentication of its own, so the proxy's basic auth is the only thing between the public
# port and an agent that runs shell commands in this container.
# ---------------------------------------------------------------------------------------
if [ -z "${DSH_WEB_PASSWORD:-}" ]; then
  echo "[ocean] DSH_WEB_PASSWORD is not set — refusing to start. DeepSeek Harness ships no" \
    "authentication at all, its agent runs shell commands and edits files in this container," \
    "and this password is the only access control on the published port. Without it, anyone" \
    "who finds the URL gets a shell for the rest of the paid window. Set DSH_WEB_PASSWORD" \
    "(12+ characters) when launching and relaunch." >&2
  exit 1
fi
if [ "${#DSH_WEB_PASSWORD}" -lt 12 ]; then
  echo "[ocean] DSH_WEB_PASSWORD is shorter than 12 characters — refusing to start. This" \
    "port is reachable by anyone who scans it and the credential crosses the network in" \
    "cleartext, so a guessable password is the same as no password." >&2
  exit 1
fi
DSH_WEB_USERNAME="${DSH_WEB_USERNAME:-dsh}"
echo "[ocean] basic auth will be required for user '$DSH_WEB_USERNAME'"

# ---------------------------------------------------------------------------------------
# Gate 3: the GPUs. Checked before the download because the alternative is discovering it
# after 166.9 GB has been paid for.
# ---------------------------------------------------------------------------------------
if ! command -v nvidia-smi >/dev/null 2>&1; then
  echo "[ocean] nvidia-smi is not present — this container has no GPU access. This model" \
    "needs $GPUS_REQUIRED CUDA GPUs of the 141 GB H200 class." >&2
  exit 1
fi
GPU_COUNT="$(nvidia-smi --query-gpu=count --format=csv,noheader | head -1 | tr -d ' ')"
if [ "${GPU_COUNT:-0}" -lt "$GPUS_REQUIRED" ]; then
  echo "[ocean] this container sees ${GPU_COUNT:-0} GPU(s) but the layout needs" \
    "$GPUS_REQUIRED (tensor-parallel size $TP_SIZE). The checkpoint is 166.9 GB, so no" \
    "single card holds it." >&2
  exit 1
fi
SMALLEST_VRAM="$(nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits \
  | sort -n | head -1)"
# Weights per card plus a floor for KV cache and activations: 166.9 GB / TP, in MiB, x 1.25.
NEED_MIB=$(( (166900 / TP_SIZE) * 5 / 4 ))
if [ "${SMALLEST_VRAM:-0}" -lt "$NEED_MIB" ]; then
  echo "[ocean] the smallest visible GPU has ${SMALLEST_VRAM} MiB, below the ${NEED_MIB} MiB" \
    "this layout needs per card (166.9 GB of weights across $TP_SIZE cards, plus room for KV" \
    "cache). Use larger cards or raise VLLM_TP_SIZE to spread the weights further." >&2
  exit 1
fi
echo "[ocean] $GPU_COUNT GPU(s) visible, smallest ${SMALLEST_VRAM} MiB — layout tp=$TP_SIZE"

# ---------------------------------------------------------------------------------------
# Gate 4: /dev/shm. Tensor parallelism is mandatory here (see the header), one worker process
# per card, and those workers talk through POSIX shared memory. Docker's default 64 MB wedges
# the rendezvous — the server never binds, never exits, and bills the whole time.
# ---------------------------------------------------------------------------------------
SHM_MB="$(df -m /dev/shm 2>/dev/null | awk 'NR==2 {print $2}')"
if [ "${SHM_MB:-0}" -lt 1024 ]; then
  echo "[ocean] /dev/shm is only ${SHM_MB:-0} MB. This model must run tensor-parallel across" \
    "$GPUS_REQUIRED cards, and vLLM's per-card worker processes exchange tensors through" \
    "shared memory, so a 64 MB default hangs the startup rendezvous instead of failing." \
    "The NODE OPERATOR fixes this once per GPU resource via init.advanced (ShmSize, and" \
    "optionally IpcMode) — see docs/compute.md, \"Multi-GPU workloads\". Refusing to start" \
    "rather than billing a hang." >&2
  exit 1
fi
echo "[ocean] /dev/shm is ${SHM_MB} MB"

# ---------------------------------------------------------------------------------------
# Gate 5: bucket space. 166.9 GB of weights, plus the runtime, plus room for the workspace
# and sessions to grow. Checked before the first byte is fetched.
# ---------------------------------------------------------------------------------------
FREE_GB="$(df -BG "$BUCKET" 2>/dev/null | awk 'NR==2 {gsub("G","",$4); print $4}')"
if [ "${FREE_GB:-0}" -lt 200 ]; then
  echo "[ocean] only ${FREE_GB:-0} GB free on the bucket at $BUCKET — this needs about 200" \
    "GB (166.9 GB of weights, the Node/dsh runtime, and headroom for sessions and the" \
    "workspace). Refusing to start a download that cannot finish." >&2
  exit 1
fi
echo "[ocean] ${FREE_GB} GB free on the bucket"

# ---------------------------------------------------------------------------------------
# One knob for persistence: $HOME on the bucket. Node, dsh's global install, DSH_HOME
# (settings, credentials, sessions, skills) and the Hugging Face cache all land under it,
# with nothing else to wire up.
# ---------------------------------------------------------------------------------------
export HOME="$DSH_STATE"
export DSH_HOME="$HOME/.dsh"
export DSH_AGENTS_HOME="$HOME/.agents"
mkdir -p "$HOME" "$DSH_HOME" "$DSH_AGENTS_HOME" "$WORKSPACE"

NODE_DIR="$HOME/node-v$NODE_VERSION"
NPM_PREFIX="$HOME/npm-$DSH_VERSION"
CADDY_BIN="$HOME/caddy-$CADDY_VERSION/caddy"

case "$(uname -m)" in
  x86_64|amd64) NODE_ARCH=x64; CADDY_ARCH=amd64 ;;
  aarch64|arm64) NODE_ARCH=arm64; CADDY_ARCH=arm64 ;;
  *) echo "[ocean] unsupported architecture $(uname -m)" >&2; exit 1 ;;
esac

# ---------------------------------------------------------------------------------------
# Node, then dsh. Downloaded with python3 + urllib rather than curl: python3 is a hard vLLM
# dependency and always present, whereas curl and tar are not guaranteed in this image. Both
# land on the bucket keyed by version, so a relaunch reuses them and a version bump installs
# cleanly beside the old one.
# ---------------------------------------------------------------------------------------
if [ ! -x "$NODE_DIR/bin/node" ]; then
  echo "[ocean] installing Node $NODE_VERSION"
  python3 - "$NODE_VERSION" "$NODE_ARCH" "$NODE_DIR" <<'PY'
import os, sys, tarfile, tempfile, urllib.request

version, arch, dest = sys.argv[1], sys.argv[2], sys.argv[3]
url = f'https://nodejs.org/dist/v{version}/node-v{version}-linux-{arch}.tar.xz'
print(f'[ocean] fetching {url}', flush=True)
with tempfile.NamedTemporaryFile(suffix='.tar.xz') as tmp:
    with urllib.request.urlopen(url, timeout=300) as resp:
        while True:
            chunk = resp.read(1 << 20)
            if not chunk:
                break
            tmp.write(chunk)
    tmp.flush()
    staging = dest + '.partial'
    with tarfile.open(tmp.name) as tf:
        try:
            tf.extractall(staging, filter='data')   # refuses paths outside the destination
        except TypeError:
            tf.extractall(staging)
# The tarball has a single top-level directory; hoist it so bin/node sits at $dest/bin/node.
inner = os.path.join(staging, os.listdir(staging)[0])
os.rename(inner, dest)
PY
fi
export PATH="$NODE_DIR/bin:$NPM_PREFIX/bin:$PATH"
echo "[ocean] node $(node --version)"

# dsh is a DEVELOPER PREVIEW whose own README promises compatibility-breaking changes, and
# every published version so far is a release candidate. It is therefore pinned rather than
# resolved at launch: `npx @deepseek-ai/dsh` would pick up whatever is newest mid-escrow and
# a breaking change would land on a consumer who only wanted the box they rented yesterday.
# Override deliberately with DSH_VERSION.
if [ ! -x "$NPM_PREFIX/bin/dsh" ]; then
  echo "[models] downloading DeepSeek Harness (dsh) $DSH_VERSION"
  npm install --global --prefix "$NPM_PREFIX" --no-fund --no-audit \
    "@deepseek-ai/dsh@$DSH_VERSION"
else
  echo "[ocean] dsh $DSH_VERSION already on the bucket — reusing it"
fi
echo "[models] ready 1/2 DeepSeek Harness (dsh) $DSH_VERSION"

if [ ! -x "$CADDY_BIN" ]; then
  echo "[ocean] installing Caddy $CADDY_VERSION (the auth proxy on the published port)"
  python3 - "$CADDY_VERSION" "$CADDY_ARCH" "$(dirname "$CADDY_BIN")" <<'PY'
import os, sys, tarfile, tempfile, urllib.request

version, arch, dest = sys.argv[1], sys.argv[2], sys.argv[3]
url = (f'https://github.com/caddyserver/caddy/releases/download/v{version}/'
       f'caddy_{version}_linux_{arch}.tar.gz')
print(f'[ocean] fetching {url}', flush=True)
os.makedirs(dest, exist_ok=True)
with tempfile.NamedTemporaryFile(suffix='.tar.gz') as tmp:
    with urllib.request.urlopen(url, timeout=300) as resp:
        while True:
            chunk = resp.read(1 << 20)
            if not chunk:
                break
            tmp.write(chunk)
    tmp.flush()
    with tarfile.open(tmp.name) as tf:
        try:
            tf.extractall(dest, filter='data')
        except TypeError:
            tf.extractall(dest)
os.chmod(os.path.join(dest, 'caddy'), 0o755)
PY
fi
echo "[ocean] caddy $("$CADDY_BIN" version | head -1)"

# git is optional but worth having: the workspace is a real project directory on the bucket and
# the agent's first useful habit is committing before it edits. Never fatal.
if ! command -v git >/dev/null 2>&1; then
  echo "[ocean] git not in the image — trying to install it (optional)"
  (apt-get update -qq && apt-get install -y -qq --no-install-recommends git) >/dev/null 2>&1 \
    || echo "[ocean] could not install git — the agent's revert/diff habits will be limited"
fi
if command -v git >/dev/null 2>&1 && [ ! -d "$WORKSPACE/.git" ]; then
  git init -q "$WORKSPACE" 2>/dev/null || true
  git -C "$WORKSPACE" config user.email dsh@ocean.local 2>/dev/null || true
  git -C "$WORKSPACE" config user.name "DeepSeek Harness" 2>/dev/null || true
fi

# ---------------------------------------------------------------------------------------
# dsh's settings, rewritten on every launch because they are node-managed. The section name
# and key shape follow the official providers guide (docs/user/guide/providers.md): settings
# are keyed by plugin, and `llm-pi-ai.providers.<id>` is where an OpenAI-compatible endpoint
# is declared. One provider and one model exist here, which is also the privacy control — the
# consumer cannot pick a hosted model and send this code off the box, because none is
# configured. Adding a DeepSeek platform key in Settings -> Models would undo that; the whole
# point of this bundle is that the weights are on the cards next door.
#
# apiKeyEnv names an env var rather than storing a secret: vLLM here has no --api-key, so the
# value is a placeholder the client must send and the server ignores.
# ---------------------------------------------------------------------------------------
# DSH_PROXY=off is a DEBUG MODE, not a deployment option: it removes Caddy from the picture
# entirely and binds dsh itself to the published port. That means NO AUTHENTICATION on a port
# anyone can reach — dsh ships none — so it is only defensible behind a firewall or an SSH
# tunnel, and only for as long as the test takes. It is also still plain HTTP, so a remote
# browser will fail at the workspace picker exactly as it does without TLS; reach it as
# http://127.0.0.1:<local-port> through a tunnel, which keeps both the secure context and a
# loopback Host header that dsh's trustedHosts accepts without configuration.
USE_PROXY=true
[ "${DSH_PROXY:-on}" = "off" ] && USE_PROXY=false

export DSH_LOCAL_API_KEY=local
SERVED_NAME="$SERVED_NAME" VLLM_PORT="$VLLM_PORT" MAX_MODEL_LEN="$MAX_MODEL_LEN" \
  USE_PROXY="$USE_PROXY" DSH_PORT="$DSH_PORT" PROXY_PORT="$PROXY_PORT" \
  python3 - "$DSH_HOME/settings.yaml" <<'PY'
import os, sys

served = os.environ['SERVED_NAME']
port = os.environ['VLLM_PORT']
ctx = int(os.environ['MAX_MODEL_LEN'])
# Hand-written YAML rather than a yaml dependency: PyYAML is not a guaranteed part of the
# image and this document is four levels deep and fully known.
doc = f"""# Written by the ocean-node bundle on every launch — edit at your own risk, it is
# overwritten. Put durable, personal configuration in the workspace instead.
llm-pi-ai:
  providers:
    ocean-local-vllm:
      api: openai-completions
      baseURL: http://127.0.0.1:{port}/v1
      apiKeyEnv: DSH_LOCAL_API_KEY
      models:
        - id: {served}
          input: [text]
"""

# Only written in the proxy-less debug mode. Section and keys come from the harness's own
# config catalog (plugin host-webserver, keys host/port); the section-per-plugin layout is the
# same one the providers guide documents for llm-pi-ai. If a future version renames either, dsh
# keeps its 127.0.0.1:3080 default and the published port simply never answers — which the
# readiness probe below reports rather than hiding.
if os.environ.get('USE_PROXY') == 'false':
    doc += f"""host-webserver:
  host: 0.0.0.0
  port: {int(os.environ['PROXY_PORT'])}
"""
with open(sys.argv[1], 'w') as fh:
    fh.write(doc)
print(f'[ocean] wrote {sys.argv[1]} — provider ocean-local-vllm, model {served}, '
      f'{ctx // 1024}K context')
PY

# ---------------------------------------------------------------------------------------
# The skills library. Skills are not a dsh invention — it reads the same SKILL.md format and
# the same discovery roots as other skills-aware agents, at these tiers (lower wins), from
# docs/subsystems/skills.md:
#
#   100  <workspace>/.dsh/skills        200  <workspace>/.agents/skills
#   300  customSkillDirs                400  $DSH_HOME/skills      <- this library
#   500  $DSH_AGENTS_HOME/skills        600  bundled
#
# This library goes in $DSH_HOME/skills and is REWRITTEN EVERY LAUNCH, which is why it must
# not be the place you keep your own work. Both workspace roots outrank it and both live on
# the bucket, so a skill you write in $WORKSPACE/.agents/skills survives relaunches and wins
# on a name collision. The library is deliberately about THIS BOX — what persists, what is
# published, where the model is, how the node's own templates are authored — because that is
# the knowledge a fresh session cannot infer and gets wrong expensively.
#
# Only two frontmatter keys are read by the local provider (`disable-model-invocation`,
# `user-invocable`); `name` and `description` are what the harness injects into the session as
# a reminder, so descriptions are written as trigger conditions rather than summaries.
# ---------------------------------------------------------------------------------------
SKILLS="$DSH_HOME/skills"
rm -rf "$SKILLS"
mkdir -p "$SKILLS"

mkdir -p "$SKILLS/this-service"
cat > "$SKILLS/this-service/SKILL.md" <<'SKILL'
---
name: this-service
description: Read FIRST in any new session, and before writing, downloading or moving any file. Explains which directories survive a stop, which single port is published, and how files get in and out of this container.
---

# Where you are

You are the agent inside a DeepSeek Harness (`dsh`) container rented from an Ocean node. The
container is destroyed when the service stops, and a relaunch builds a **new** one. Only the
persistent-storage bucket survives.

## What survives, what does not

| Path | Survives a stop? | What it is |
| --- | --- | --- |
| `/data/outputs/workspace-dsv4` | **Yes** | Your project directory. Everything you are asked to build belongs here. |
| `/data/outputs/dsh-v4flash` | **Yes** | `$HOME`: the Node runtime, dsh itself, dsh's settings and session history, the model weights cache. |
| `/data/outputs` (rest of bucket) | **Yes** | The bucket root. The storage API lists **top-level files only**, so a file the user must download goes here, not in a subdirectory. |
| everything else — `/tmp`, `/root`, `/workspace`, the image | **No** | Destroyed on stop, silently. |

Rules that follow from the table, and they are not negotiable:

- Never write work products outside the bucket. A "temporary" file you plan to move later is
  lost if the window ends first.
- `/data/outputs/dsh-v4flash/.dsh/settings.yaml` and `/data/outputs/dsh-v4flash/.dsh/skills/`
  are **rewritten by the node on every launch**. Editing them is throwing work away. Durable
  configuration goes in the workspace: `AGENTS.md`, and skills in
  `/data/outputs/workspace-dsv4/.agents/skills/<name>/SKILL.md`, which outrank the node's.
- Getting files in and out is the bucket's job, not the network's. The user uploads to the
  bucket and you read it; you write to the bucket root and the user downloads it. Do not
  suggest scp, tunnels or paste-into-chat for anything large.

## The network shape

- `127.0.0.1:8000` — vLLM, OpenAI-compatible, serving `deepseek-v4-flash`. Loopback only.
- `127.0.0.1:3080` — dsh, the UI you are being driven through. Loopback only.
- `0.0.0.0:8443` — **the published port that matters.** Caddy: TLS (self-signed) plus HTTP
  basic auth, reverse-proxying dsh. This is how the user reached you.
- `0.0.0.0:8080` — published, but serves a single static page explaining that the UI is on 8443
  over `https://`. It proxies nothing.

dsh has no authentication of its own, so that proxy is the entire access control on this box.
Never start another listener on a public interface, never disable or reconfigure the proxy, and
if you are asked to "expose" something, expose it through the existing proxy or say no.

TLS is not decoration here: browsers gate `crypto.randomUUID()`, `crypto.subtle`, the clipboard
API and service workers to secure contexts, and dsh's own workspace picker calls the first of
those. If a user reports "crypto.randomUUID is not a function", they are on the `http://` port
or a plain-HTTP tunnel — the fix is the `https://` endpoint or a tunnel to localhost, never a
code change on your side.

## Cost awareness

This container bills for a fixed paid window. Long-running commands, re-downloads of things
already on the bucket, and re-running a 20-minute test suite to check a typo all spend the
user's money. Check whether something is already on the bucket before fetching it.
SKILL

mkdir -p "$SKILLS/local-model"
cat > "$SKILLS/local-model/SKILL.md" <<'SKILL'
---
name: local-model
description: Use when the user asks what model this is, when reasoning effort or context length matters, when a request fails or truncates, or when you need to call the model directly instead of through the harness.
---

# The model on the cards next door

`deepseek-ai/DeepSeek-V4-Flash-0731`, served by vLLM on `http://127.0.0.1:8000/v1` and reached
by dsh through the `ocean-local-vllm` provider. It is the only model configured, on purpose: no
request in this session can leave the container.

Facts from the checkpoint's own `config.json` and model card:

- 284B total parameters, ~13B active per token (MoE, 256 routed experts, 6 per token).
- FP8 (e4m3) weights with fp4 expert weights; 166.9 GB on disk; 43 layers.
- `max_position_embeddings` is 1 048 576, but **this server is started with a smaller window**
  (see below) — the model's ceiling is not this deployment's ceiling.
- MIT licence.

## Checking the deployment rather than guessing

```sh
curl -s http://127.0.0.1:8000/v1/models            # served name, and the real max_model_len
curl -s http://127.0.0.1:8000/health               # 200 when the engine is alive
curl -s http://127.0.0.1:8000/metrics | head -40   # queue depth, KV-cache usage, throughput
```

Read `max_model_len` from `/v1/models` before you assume anything about context. If a request
fails with a length error, that number is the arithmetic, not a suggestion — summarise or split
the input.

## Reasoning effort

The model has three modes: non-think (fast), think high, and think max. Think max needs a
context of at least 393216 or its output truncates mid-thought. Prefer non-think for mechanical
work — renames, greps, file moves — and reserve think max for genuinely hard reasoning, because
thinking tokens are billed time on cards the user is renting by the minute.

Reasoning content arrives in a separate field (vLLM is started with `--reasoning-parser
deepseek_v4`); tool calls are parsed by `--tool-call-parser deepseek_v4`. If you ever see a
tool call arrive as prose in the message body, that is a parser problem on the server, not
something to work around by asking the user to paste JSON.

## Calling it directly

Legitimate when you want a second opinion, a bulk classification, or a scripted loop — the
harness session is not the only path:

```sh
curl -s http://127.0.0.1:8000/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"deepseek-v4-flash","messages":[{"role":"user","content":"ping"}],"max_tokens":16}'
```

The endpoint has no API key and is unreachable from outside the container. Do not add an
authentication layer to it, and do not bind it to `0.0.0.0` — that would publish an
unauthenticated inference endpoint on a public port.
SKILL

mkdir -p "$SKILLS/gpu-budget"
cat > "$SKILLS/gpu-budget/SKILL.md" <<'SKILL'
---
name: gpu-budget
description: Use before running anything that touches CUDA (training, another model, a notebook, nvidia-smi debugging), or when the model becomes slow, stalls, or dies with an out-of-memory error.
---

# The VRAM here is already spent

vLLM was started with `--gpu-memory-utilization 0.90` across the tensor-parallel group. That is
not spare capacity waiting for a second workload: the remaining ~10% absorbs activation peaks,
NCCL communicators created lazily on the first request of a shape, and the sparse-attention
workspace. Taking a few GB "just for a quick test" is how the model dies mid-task, and the
failure surfaces as a CUDA OOM inside vLLM that looks unrelated to whatever you started.

**Do not** start a second CUDA process. No training run, no second inference server, no
notebook with `torch.cuda`, no image model. If the user asks for one, explain that it would
evict the model they are paying for and offer the CPU or a separate service instead.

## Reading the state

```sh
nvidia-smi --query-gpu=index,memory.used,memory.total,utilization.gpu --format=csv
```

What normal looks like: each card ~90% of total memory used, and GPU utilisation spiking during
generation and sitting near idle between turns. Steady high memory with zero utilisation is
correct for an idle model — the weights are resident. It is not a leak and not something to
"free up".

`nvidia-smi` also shows the vLLM worker processes, one per card. If a card shows no worker, the
tensor-parallel group is broken and the service will fail on the next request; report it rather
than trying to restart vLLM yourself — the container is supervised, and killing vLLM stops the
whole service and ends the paid window.

## Slowness that is not a GPU problem

Check `curl -s http://127.0.0.1:8000/metrics` first. High queue depth means concurrency, not a
sick GPU. A long prompt is quadratic-ish in prefill: the fix is a shorter prompt, not more VRAM.
And thinking modes generate far more tokens than they show you, so "slow" while in think-max is
the mode working as designed.
SKILL

mkdir -p "$SKILLS/workspace-discipline"
cat > "$SKILLS/workspace-discipline/SKILL.md" <<'SKILL'
---
name: workspace-discipline
description: Use before the first edit in any session and before any multi-file change, refactor, dependency install, or destructive command. Covers the git safety net, the test loop, and how to leave a session someone else resumes.
---

# Working in a rented workspace

`/data/outputs/workspace-dsv4` is a git repository on the persistent bucket. Git is the only
undo that survives a container being destroyed, so it is the first tool, not a courtesy at the
end.

## Before editing

1. `git -C /data/outputs/workspace-dsv4 status --short` — know what is already dirty. Uncommitted
   changes may be a previous session's unfinished work; do not fold them into yours silently.
2. Commit or stash the existing state before starting something new. A commit costs nothing and
   is the difference between "revert that" and "retype it".
3. Read before you write. Grep the repo for the symbol you are about to change; a rename that
   misses a call site is the most common way an agent breaks a build.

## While editing

- Smallest change that could work, then verify, then the next one. A 12-file edit verified once
  at the end is a debugging session you have paid for twice.
- Run the project's own checks, not invented ones: look for `package.json` scripts, `Makefile`,
  `pyproject.toml`, CI config. If tests exist, run them before and after so you know which
  failures you caused.
- Commit at each working point with a message saying **why**. Sessions end abruptly when a paid
  window closes.

## Commands that need permission first

Ask before: anything with `rm -rf`, force-pushing, rewriting history, `git clean`, installing
system packages, changing anything under `/data/outputs/dsh-v4flash`, or touching another
service's bucket directory. Ask before any command that sends repository content off the box —
`git push`, `curl` to an external host, a package publish. The privacy of this deployment is
its whole point, and you are the only thing that can break it.

## Making the next session smarter

Two files, both in the workspace, both surviving relaunch:

- `AGENTS.md` — how this project is built, tested and laid out; conventions you had to discover
  the hard way. Write to it the moment you learn something the repo does not state.
- `.agents/skills/<name>/SKILL.md` — a reusable procedure, with a `description` written as the
  condition under which to read it. These outrank the node-managed library, so this is where a
  correction to anything in that library belongs.

Leaving both better than you found them is part of finishing the task.
SKILL

mkdir -p "$SKILLS/ocean-service-templates"
cat > "$SKILLS/ocean-service-templates/SKILL.md" <<'SKILL'
---
name: ocean-service-templates
description: Use when authoring, reviewing or debugging an ocean-node service template or bundle — any JSON under docs/serviceTemplates/ or the configured serviceTemplatesPath, or a launch script that a template points at with commandFile.
---

# Authoring ocean-node service templates

An ocean-node *service template* is a JSON file describing one long-running containerised
service a consumer can start on a node with `SERVICE_START`. The node reads every `*.json` in
`serviceTemplatesPath` (default `databases/serviceTemplates/`) on **every request**, so adding
or editing a template needs no restart. Invalid JSON or a schema violation skips that template
with a warning; on duplicate `id` the filename-sorted first occurrence wins.

The schema is `ServiceTemplateSchema` in `src/utils/config/schemas.ts`; the TypeScript shape is
`ServiceTemplate` in `src/@types/C2D/ServiceOnDemand.ts`. Read the schema rather than copying a
neighbour blindly — it is `.strict()`, so an unknown key silently drops the whole template.

## The fields that carry the weight

- `id` — `[a-z0-9][a-z0-9_-]{0,63}`, unique on the node.
- `image` plus **exactly one** of `tag` / `checksum` / `dockerfile`. `dockerfile` triggers a
  build and is gated per daemon by `allowImageBuild`. Pin a real tag; never `:latest` or
  `:nightly` in a template a consumer pays by the minute for.
- `exposedPorts` — container ports forwarded to host ports and returned as service endpoints.
  Publish the smallest possible number, and publish nothing that lacks authentication.
- `command` / `entrypoint` — Docker overrides. `commandFile` is the better form: a path relative
  to the template directory, inlined as `command[0]` at load time. `command` and `commandFile`
  are mutually exclusive.
- `envVars` — operator-set, never returned to callers. `userConfigurableEnvVars` — consumer-set
  through ECIES-encrypted `userData`, with an optional `validation` regex, and `sensitive` /
  `required` as **advisory UI hints that the node never enforces**. Enforce them in the script.
- `requiredResources` / `recommendedResources` — gate and score environment selection; `min` is
  enforced at `SERVICE_START`.
- `workflows` — selectable graphs for UI-driven templates.

## Services versus bundles

Catalogue metadata only; it changes nothing about how the container runs. `kind` is `service`
(the default when absent) or `bundle`. A bundle **must** set `service` to the id of the template
it varies — a bundle without it renders as a plain service in clients. `outcome`, `category` and
`includes` describe it for the catalogue.

Keep `includes` in step with what the launch script actually downloads: clients use its length
as the denominator of a "preparing models — N of M" line, driven by conventional stdout markers:

```
[models] downloading <name>
[models] ready <n>/<m> <name>
[models] already present: <name>
[models] WARNING: could not download <name>
[models] bundle complete
```

They are a convention, not a protocol — a script that prints none simply shows no progress.

## What separates a good launch script from a costly one

Every template in this catalogue that survived contact with real consumers converged on the
same shape, and it is worth copying:

1. **Gate everything before the first byte downloads.** Missing bucket, missing password, wrong
   GPU count, small `/dev/shm`, insufficient disk — each is a one-line check that saves hours of
   billed download. Exit with a log line naming the fix.
2. **Never publish an unauthenticated agent or API.** Bind inference to `127.0.0.1`. If the
   published service has no authentication of its own, put a proxy with basic auth in front and
   make the password a required env var the script refuses to start without.
3. **Require a persistent bucket whenever a relaunch would re-download or destroy work.**
   `restartService` builds a *new* container; the bucket is the only continuity.
4. **Prove the service works before publishing it.** Bind-plus-healthcheck is not proof for
   models that allocate memory or JIT kernels on the first real request. Send one real request
   and exit if it fails.
5. **Pin every version** — image tag, agent release, model revision — and let the consumer
   override with an env var. Nothing should change under a paid window.
6. **Say the unpleasant parts out loud in `description`.** First-launch download time is billed;
   a wrong GPU class will not work; a password is mandatory. A consumer who reads it and
   proceeds is a consumer who does not open a support ticket.
SKILL

mkdir -p "$SKILLS/dsh-extension-pointers"
cat > "$SKILLS/dsh-extension-pointers/SKILL.md" <<'SKILL'
---
name: dsh-extension-pointers
description: Use when asked to extend DeepSeek Harness itself — write a plugin, add a tool, add an LLM adapter, change the agent loop — so you read the official docs for the installed version instead of recalling an API that has since changed.
---

# Extending dsh: read the source, do not recall the API

DeepSeek Harness is a **developer preview**. Its own README states there will be
compatibility-breaking changes, and every published npm version so far is a release candidate.
Any plugin API you remember is therefore probably wrong for the version installed here.

This skill deliberately contains **no API surface**. It tells you where the truth is.

## The truth, in order

1. **The installed package.** `/data/outputs/dsh-v4flash/npm-*/lib/node_modules/@deepseek-ai/`
   — inspect the version actually running before writing a line of plugin code.
2. **The official repository**, `https://github.com/deepseek-ai/deepseek-harness` (MIT), whose
   docs tree is the authority. The files that matter for extension work:
   - `docs/cordis-primer.md` and `docs/cordis-tutorial/01…07` — the plugin framework
     ("everything is a plugin", powered by Cordis).
   - `docs/cookbook/adding-a-tool.md` — adding a tool.
   - `docs/cookbook/adding-an-llm-adapter.md` — adding a model adapter.
   - `docs/cookbook/adding-a-package.md`, `docs/cookbook/extension-cookbook.md` — packaging.
   - `docs/subsystems/*.md` — one file per subsystem (tools, skills, sandbox, session,
     approval, web-server, …).
   - `docs/config-catalog.md` — every config key with its plugin, env var and default.
3. **Third-party skill packs** exist for plugin development (for example `omdsh-dev/dsh-plugin-skills`,
   `green-dalii/dsh-plugin-dev-skill`). They are **unofficial and unvetted by this node**. Treat
   them as a starting point, verify against the docs above, and tell the user what you installed.

## How to work here

Fetching a doc needs network egress from this container, which is allowed but is a request
leaving the box — say so before you do it. Prefer reading the installed package, which is local
and matches the running version exactly.

Anything you build for dsh belongs in the workspace, not in `$DSH_HOME`: the node rewrites
`$DSH_HOME/settings.yaml` and `$DSH_HOME/skills/` on every launch.
SKILL

SKILL_COUNT="$(find "$SKILLS" -name SKILL.md | wc -l | tr -d ' ')"
echo "[ocean] wrote $SKILL_COUNT skills to $SKILLS (tier 400; your own in" \
  "$WORKSPACE/.agents/skills outrank them and survive relaunch)"

# ---------------------------------------------------------------------------------------
# Weights. snapshot_download rather than the `hf` CLI: huggingface_hub is a hard vLLM
# dependency so the Python API is always present, whereas the CLI entrypoint was renamed
# (huggingface-cli -> hf) and which name exists varies by image. It resumes, verifies against
# the remote ETag, and writes the cache layout vLLM expects. It reads HF_TOKEN from the
# environment by itself; this repository is ungated, so the token is optional.
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
echo "[models] ready 2/2 $MODEL"
echo "[models] bundle complete"

# ---------------------------------------------------------------------------------------
# DSpark speculative decoding, off by default, opt in with ENABLE_DSPARK=true.
#
# The checkpoint ships a fused DSpark draft module (config.json: dspark_block_size,
# dspark_target_layer_ids) and the model card's own vLLM invocation enables it. It is off here
# anyway, for two reasons. First, --speculative-config is the flag most likely to be rejected
# outright by a given vLLM build, and a rejected flag means the server never starts, which
# costs a paid window. Second, vLLM's recipe documents DSpark on Blackwell (sm_120, with a
# FlashInfer patch) and on ROCm from 0.26.0, and says nothing about Hopper — so on H200 this is
# untested rather than known-good. Turn it on once you have watched this template start
# cleanly; if startup then fails, the log names the flag.
# ---------------------------------------------------------------------------------------
# Expanded as ${VLLM_EXTRA_ARGS[@]+"..."} rather than plain "${VLLM_EXTRA_ARGS[@]}": under
# `set -u`, expanding an EMPTY array is an unbound-variable error on bash before 4.4, and the
# shell in a given base image is not something this script should have to assume.
VLLM_EXTRA_ARGS=()
if [ "${ENABLE_DSPARK:-false}" = "true" ]; then
  VLLM_EXTRA_ARGS+=(--speculative-config \
    '{"method":"dspark","num_speculative_tokens":7,"draft_sample_method":"greedy"}')
  echo "[ocean] DSpark speculative decoding enabled (untested on Hopper — see the script)"
fi

# ---------------------------------------------------------------------------------------
# vLLM, on loopback. The three deepseek_v4 flags are what make this an agent runtime rather
# than a chat toy, and none is cosmetic:
#
#   --tokenizer-mode deepseek_v4  The checkpoint ships encoding scripts under encoding/ instead
#                                 of a Jinja chat template. This mode applies the built-in V4
#                                 encoding so /v1/chat/completions works without helper scripts.
#   --tool-call-parser deepseek_v4 + --enable-auto-tool-choice
#                                 Without these the model's tool calls arrive as prose inside
#                                 the message body and dsh cannot act on a single one.
#   --reasoning-parser deepseek_v4 Separates thinking from content; without it the thinking text
#                                 is returned as ordinary content, tool call buried inside it.
#
# --kv-cache-dtype fp8 and --trust-remote-code follow the model's own vLLM recipe.
# Sampling defaults come from the repository's generation_config.json, which vLLM reads.
# ---------------------------------------------------------------------------------------
vllm serve "$MODEL" \
  --host 127.0.0.1 --port "$VLLM_PORT" \
  --served-model-name "$SERVED_NAME" \
  --tensor-parallel-size "$TP_SIZE" \
  --gpu-memory-utilization "$GPU_MEM_UTIL" \
  --max-model-len "$MAX_MODEL_LEN" \
  --max-num-seqs 8 \
  --kv-cache-dtype fp8 \
  --trust-remote-code \
  --tokenizer-mode deepseek_v4 \
  --tool-call-parser deepseek_v4 \
  --enable-auto-tool-choice \
  --reasoning-parser deepseek_v4 \
  ${VLLM_EXTRA_ARGS[@]+"${VLLM_EXTRA_ARGS[@]}"} &
VLLM_PID=$!

# The port opens when uvicorn binds, which is after every worker has loaded its shard, so this
# is a real readiness signal. kill -0 turns a dead loader into an immediate exit rather than an
# endless wait. The timeout is the other half: a wedged multi-GPU rendezvous does not exit and
# does not bind — it just sits there billing.
LOAD_TIMEOUT=3600
WAITED=0
until (exec 3<>/dev/tcp/127.0.0.1/"$VLLM_PORT") 2>/dev/null; do
  kill -0 $VLLM_PID 2>/dev/null || {
    echo "[ocean] vLLM exited during startup. If the log above ends in a CUDA out-of-memory" \
      "while LOADING WEIGHTS (rather than while allocating the KV cache), the likely cause is" \
      "the expert quantisation: this checkpoint stores its experts in fp4, which is native to" \
      "Blackwell, and a Hopper path that cannot consume it packed upcasts on load — doubling" \
      "the 155.4 GiB footprint at fp8 or quadrupling it at bf16, which no 2-card layout holds." \
      "Raise VLLM_TP_SIZE to 4 (or 8) to spread the weights and relaunch; the arithmetic for" \
      "each layout is in the GPU note on the template. If instead the log names a rejected" \
      "flag, the image predates this model's deepseek_v4 support — pin a newer vLLM." >&2
    exit 1
  }
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
echo "[ocean] vLLM serving $SERVED_NAME on 127.0.0.1:$VLLM_PORT across $GPUS_REQUIRED GPU(s)"

# ---------------------------------------------------------------------------------------
# Warm-up, and the reason it is not optional here specifically. A bound port proves the weights
# loaded and proves nothing about whether this service can answer. Three things in this stack
# allocate memory or compile code on the FIRST real request: NCCL communicators for shapes not
# seen at startup, the sparse-attention prefill workspace, and Triton kernels that JIT
# mid-inference. On top of that, this template's one genuinely unverified assumption is that
# Hopper cards serve an fp4-expert checkpoint under plain tensor parallelism — vLLM's recipe
# documents H200 only under a disaggregated deployment. If that assumption is wrong, THIS is
# where it surfaces: in seconds, in the log, before the consumer is told the service is ready.
#
# A tool call is part of the probe on purpose. Tool calling is the difference between an agent
# runtime and a chat window, it depends on server-side parsers that a wrong image silently
# lacks, and a harness that cannot call a tool is useless in a way the consumer would otherwise
# discover by typing a prompt and watching nothing happen.
# ---------------------------------------------------------------------------------------
# Measured payoff, from the first real launch: this request absorbed two Triton compilations
# that the engine's own warmup did not cover — _build_c128a_topk_metadata_kernel and
# CombineTopkSwaIndicesKernel.kernel, both flagged by vLLM's JIT monitor as inference-time
# latency spikes. Without this block the consumer pays them on their first prompt instead.
echo "[ocean] warming up: one real request, including a tool call, before publishing anything"
if ! SERVED_NAME="$SERVED_NAME" VLLM_PORT="$VLLM_PORT" python3 <<'PY'
import json, os, sys, urllib.error, urllib.request

served, port = os.environ['SERVED_NAME'], os.environ['VLLM_PORT']
# ~6K tokens of filler: enough to cross the length threshold where the sparse-attention prefill
# kernel is chosen over the dense one, since that is the path allocating a workspace outside
# vLLM's profiled budget.
filler = 'The quick brown fox jumps over the lazy dog. ' * 700
body = json.dumps({
    'model': served,
    'messages': [
        {'role': 'user',
         'content': filler + '\nCall the ready tool with status set to the word ready.'}
    ],
    'tools': [{
        'type': 'function',
        'function': {
            'name': 'ready',
            'description': 'Report readiness.',
            'parameters': {
                'type': 'object',
                'properties': {'status': {'type': 'string'}},
                'required': ['status']
            }
        }
    }],
    'tool_choice': 'auto',
    'max_tokens': 64,
    'temperature': 0
}).encode()
req = urllib.request.Request(
    f'http://127.0.0.1:{port}/v1/chat/completions',
    data=body,
    headers={'Content-Type': 'application/json'}
)
try:
    with urllib.request.urlopen(req, timeout=900) as resp:
        message = json.load(resp)['choices'][0]['message']
except urllib.error.HTTPError as e:
    sys.exit(f'[ocean] warm-up request returned HTTP {e.code}: {e.read()[:400]!r}')
except Exception as e:
    sys.exit(f'[ocean] warm-up request failed: {e}')

if not message.get('tool_calls'):
    # Not fatal: the model may legitimately answer in prose, and a template that refuses to
    # start over one sampling outcome is worse than one that warns. But say it loudly, because
    # the likeliest cause is a server missing the deepseek_v4 tool parser.
    print('[ocean] WARNING: the warm-up prompt did not produce a tool call. Prefill and decode'
          ' work, so the service is being published, but if the agent cannot use tools at all,'
          ' the image is missing the deepseek_v4 tool-call parser — pin a vLLM build that has'
          ' it.', flush=True)
else:
    print('[ocean] warm-up completed — prefill, decode and tool calling all work')
PY
then
  echo "[ocean] the model server loaded its weights but cannot serve a request, so this" \
    "service is not being published. Most likely causes, in order: (1) this GPU class cannot" \
    "run the fp4 expert weights under plain tensor parallelism — vLLM's own recipe documents" \
    "H200 only under a prefill/decode-disaggregated deployment, and that is this template's" \
    "one unverified assumption; (2) the image predates the deepseek_v4 support and rejected a" \
    "flag (the vLLM log above names it); (3) VLLM_GPU_MEM_UTIL ($GPU_MEM_UTIL) leaves too" \
    "little outside vLLM's budget for the communicators and workspaces allocated on the first" \
    "request — lower it 0.01 at a time, but not below what still holds one full" \
    "VLLM_MAX_MODEL_LEN ($MAX_MODEL_LEN) context. Exiting rather than billing a service that" \
    "dies on the first prompt." >&2
  kill $VLLM_PID 2>/dev/null || true
  exit 1
fi

# ---------------------------------------------------------------------------------------
# dsh, on loopback. `web --no-open` is the documented invocation: `web` serves the browser UI,
# and --no-open skips launching a local browser, which a container has nothing to do with. It
# binds 127.0.0.1:3080 by default, which is exactly where the proxy expects it, so no unverified
# host/port settings are needed.
#
# It runs from $WORKSPACE so the agent's project directory is the process's cwd, and with
# CUDA_VISIBLE_DEVICES emptied for this process only: dsh has no use for a GPU and this
# guarantees it cannot take VRAM the model needs.
# ---------------------------------------------------------------------------------------
cd "$WORKSPACE"
CUDA_VISIBLE_DEVICES= "$NPM_PREFIX/bin/dsh" web --no-open &
DSH_PID=$!

# In debug mode dsh is asked to bind the published port itself, so that is the port to watch.
DSH_WATCH_PORT="$DSH_PORT"
[ "$USE_PROXY" = false ] && DSH_WATCH_PORT="$PROXY_PORT"
DSH_WAITED=0
until (exec 3<>/dev/tcp/127.0.0.1/"$DSH_WATCH_PORT") 2>/dev/null; do
  kill -0 $DSH_PID 2>/dev/null || { echo "[ocean] dsh exited during startup" >&2; exit 1; }
  if [ "$USE_PROXY" = false ] && [ "$DSH_WAITED" -ge 60 ]; then
    echo "[ocean] DSH_PROXY=off asked dsh to bind 0.0.0.0:$PROXY_PORT through the" \
      "host-webserver section of settings.yaml, and nothing is listening there after 60s." \
      "Either that config key has been renamed in dsh $DSH_VERSION — check" \
      "$DSH_HOME/settings.yaml against the installed package's config catalog — or dsh is" \
      "still on its 127.0.0.1:$DSH_PORT default, where a published port cannot reach it." \
      "Relaunch without DSH_PROXY to use the proxy, which needs no such key." >&2
    exit 1
  fi
  sleep 3
  DSH_WAITED=$((DSH_WAITED + 3))
done
if [ "$USE_PROXY" = false ]; then
  echo "[ocean] dsh listening on 0.0.0.0:$DSH_WATCH_PORT — NO AUTHENTICATION IN FRONT OF IT." \
    "This is the DSH_PROXY=off debug mode: anyone who can reach this port has a shell in this" \
    "container. Keep it behind a firewall or a tunnel and stop the service when the test ends."
else
  echo "[ocean] dsh listening on 127.0.0.1:$DSH_PORT"
fi

# ---------------------------------------------------------------------------------------
# The published ports: Caddy, TLS, basic auth, reverse proxy to dsh.
#
# WHY TLS IS NOT OPTIONAL HERE, and it is not (only) about the password. dsh's web client calls
# crypto.randomUUID() when you pick a workspace, and that API — like crypto.subtle, the
# clipboard API and service workers — is gated to SECURE CONTEXTS. Over plain http:// to a
# remote host the browser leaves it undefined and the UI fails with
#   "crypto.randomUUID is not a function"
# at the workspace picker, which is a REQUIRED step. An http:// deployment is therefore not
# merely less private, it is unusable for anyone who cannot reach the service as localhost.
# https:// is a secure context even with an untrusted certificate once the warning is accepted,
# so TLS is the fix rather than a hardening extra. It also retires the cleartext-password
# caveat: basic auth now travels inside TLS.
#
# The certificate is SELF-SIGNED and generated per launch. It cannot be otherwise: the container
# never learns the public hostname or port the node assigns it, so there is no name to get a
# real certificate for, and Caddy's own `tls internal` CA would be just as untrusted by the
# browser. Expect a one-time interstitial ("Advanced" -> proceed). That click is what makes the
# origin a secure context; the warning is about identity, which this container cannot prove, not
# about the encryption, which is real.
#
# TWO PORTS, and the second exists because of an ocean-node limitation worth naming: the node
# builds every endpoint as `http://<nodeHost>:<hostPort>` (compute_engine_docker.ts), with no
# way for a template to declare its scheme. The URL a consumer is handed for the TLS port
# therefore has the wrong scheme and fails confusingly. Port 8080 serves one static page whose
# only job is to say "this service is on the other port, with https://" — turning a dead link
# into an instruction. It proxies nothing, requires no auth and carries no secrets.
#
# `header_up Host {upstream_hostport}` is load-bearing, not tidiness. dsh's client-connection
# layer wants non-loopback serving authorities declared in trustedHosts, and this container
# cannot know the public host and port the node will assign it. Rewriting the Host header to
# the loopback upstream means dsh only ever sees the authority it already trusts, so nothing
# has to be configured against a value that is not knowable at launch.
#
# `auto_https off` keeps Caddy from provisioning or redirecting anything; an explicit `tls` with
# certificate files still serves TLS, and the `https://` scheme on the site address makes that
# unambiguous. The password reaches Caddy as a bcrypt hash through the config file; the
# plaintext is never written to disk.
#
# DSH_TLS=off falls back to plain HTTP on 8080 — correct ONLY when the service is reached
# through an SSH tunnel or another TLS terminator, because localhost is itself a secure context.
# It is not a way to avoid the certificate warning on a remote browser: it trades the warning
# for a UI that cannot open a workspace.
# ---------------------------------------------------------------------------------------
if [ "$USE_PROXY" = false ]; then
  echo "[ocean] ready — DSH_PROXY=off: no proxy, no auth, no TLS. Reach container port" \
    "$PROXY_PORT through an SSH tunnel and open http://127.0.0.1:<local-port> (a tunnel keeps" \
    "both the secure context and the loopback Host header dsh expects). In dsh: click Choose" \
    "workspace and pick $WORKSPACE, then start a session — the model is already configured and" \
    "$SKILL_COUNT skills are loaded. Stop the service when the test ends."
  wait -n $VLLM_PID $DSH_PID
  exit $?
fi

PW_HASH="$("$CADDY_BIN" hash-password --plaintext "$DSH_WEB_PASSWORD")"
CADDY_DIR="$HOME/caddy-config"
CERT="$CADDY_DIR/dsh-selfsigned.crt"
KEY="$CADDY_DIR/dsh-selfsigned.key"
mkdir -p "$CADDY_DIR/site"

USE_TLS=true
if [ "${DSH_TLS:-on}" = "off" ]; then
  USE_TLS=false
  echo "[ocean] DSH_TLS=off — serving plain HTTP on $PROXY_PORT. Reach this through an SSH" \
    "tunnel or a TLS terminator: on a remote browser over http://, dsh cannot open a" \
    "workspace (crypto.randomUUID is undefined outside a secure context)."
else
  # Regenerated per launch rather than cached on the bucket: nothing trusts it anyway, so it is
  # worthless to keep, and a private key sitting in persistent storage is a liability with no
  # upside. openssl first because the image is Ubuntu-based and almost always has it; the
  # cryptography module is the fallback for images that do not. The SANs cover the loopback
  # names a tunnel user sees; a remote consumer's address cannot be predicted, and it does not
  # matter, because an untrusted issuer forces the interstitial either way.
  if command -v openssl >/dev/null 2>&1; then
    openssl req -x509 -newkey rsa:2048 -sha256 -nodes -days 365 \
      -keyout "$KEY" -out "$CERT" -subj "/CN=deepseek-harness" \
      -addext "subjectAltName=DNS:localhost,IP:127.0.0.1" >/dev/null 2>&1 \
      || { echo "[ocean] openssl could not generate a certificate" >&2; USE_TLS=false; }
  elif python3 -c 'import cryptography' 2>/dev/null; then
    CERT="$CERT" KEY="$KEY" python3 <<'PYCERT' || USE_TLS=false
import datetime, ipaddress, os
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import NameOID

key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, 'deepseek-harness')])
now = datetime.datetime.now(datetime.timezone.utc)
cert = (x509.CertificateBuilder()
        .subject_name(name).issuer_name(name)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - datetime.timedelta(minutes=5))
        .not_valid_after(now + datetime.timedelta(days=365))
        .add_extension(x509.SubjectAlternativeName([
            x509.DNSName('localhost'),
            x509.IPAddress(ipaddress.ip_address('127.0.0.1')),
        ]), critical=False)
        .sign(key, hashes.SHA256()))
with open(os.environ['KEY'], 'wb') as fh:
    fh.write(key.private_bytes(serialization.Encoding.PEM,
                               serialization.PrivateFormat.TraditionalOpenSSL,
                               serialization.NoEncryption()))
with open(os.environ['CERT'], 'wb') as fh:
    fh.write(cert.public_bytes(serialization.Encoding.PEM))
print('[ocean] generated a self-signed certificate with the cryptography module')
PYCERT
  else
    echo "[ocean] neither openssl nor the cryptography module is available in this image —" \
      "cannot generate a certificate" >&2
    USE_TLS=false
  fi
  if [ "$USE_TLS" = false ]; then
    echo "[ocean] WARNING: falling back to plain HTTP on $PROXY_PORT. A remote browser will" \
      "not be able to open a workspace in dsh (crypto.randomUUID is undefined outside a secure" \
      "context) — reach the service through an SSH tunnel, or relaunch on an image with" \
      "openssl." >&2
  else
    chmod 600 "$KEY"
    echo "[ocean] generated a self-signed certificate for the TLS port"
  fi
fi

if [ "$USE_TLS" = true ]; then
  # A static file rather than an inline `respond` heredoc: Caddyfile heredocs are sensitive to
  # the closing marker's indentation, and a broken proxy config is not a failure mode worth
  # risking for one page of HTML.
  cat > "$CADDY_DIR/site/index.html" <<'EXPLAINER'
<!doctype html><meta charset=utf-8><title>Use the HTTPS endpoint</title>
<style>body{font:16px/1.6 system-ui,sans-serif;max-width:38em;margin:4em auto;padding:0 1em}
code{background:#eee;padding:.1em .3em;border-radius:3px}</style>
<h1>This service is on the other port</h1>
<p>DeepSeek Harness needs a <b>secure context</b>: its UI calls
<code>crypto.randomUUID()</code>, which browsers only provide over HTTPS or on localhost. Over
plain HTTP you cannot select a workspace, and selecting one is required.</p>
<p>Open the <b>other endpoint listed for this service</b> and type <code>https://</code> in
front of it. Your node reports every endpoint as <code>http://</code> because it has no way to
know that a container serves TLS, so the scheme has to be corrected by hand — once.</p>
<p>You will get a certificate warning. That is expected: the certificate is self-signed, because
this container never learns the public hostname it is reached by. Choose <i>Advanced</i> and
proceed. The encryption is real; only the identity is unverified.</p>
EXPLAINER
  cat > "$CADDY_DIR/Caddyfile" <<CADDYFILE
{
	auto_https off
	admin off
}

https://:$TLS_PORT {
	tls $CERT $KEY
	basic_auth {
		$DSH_WEB_USERNAME $PW_HASH
	}
	reverse_proxy 127.0.0.1:$DSH_PORT {
		header_up Host {upstream_hostport}
	}
}

http://:$PROXY_PORT {
	root * $CADDY_DIR/site
	file_server
}
CADDYFILE
else
  cat > "$CADDY_DIR/Caddyfile" <<CADDYFILE
{
	auto_https off
	admin off
}

http://:$PROXY_PORT {
	basic_auth {
		$DSH_WEB_USERNAME $PW_HASH
	}
	reverse_proxy 127.0.0.1:$DSH_PORT {
		header_up Host {upstream_hostport}
	}
}
CADDYFILE
fi

XDG_DATA_HOME="$HOME/caddy-data" XDG_CONFIG_HOME="$HOME/caddy-config" \
  "$CADDY_BIN" run --config "$CADDY_DIR/Caddyfile" --adapter caddyfile &
PROXY_PID=$!

# Wait on whichever port carries the UI, so "ready" never precedes a listener.
READY_PORT="$PROXY_PORT"
[ "$USE_TLS" = true ] && READY_PORT="$TLS_PORT"
until (exec 3<>/dev/tcp/127.0.0.1/"$READY_PORT") 2>/dev/null; do
  kill -0 $PROXY_PID 2>/dev/null || { echo "[ocean] the auth proxy exited during startup" >&2; exit 1; }
  sleep 2
done

if [ "$USE_TLS" = true ]; then
  echo "[ocean] ready — open the service endpoint for container port $TLS_PORT, changing" \
    "http:// to https:// (the node reports every endpoint as http://, and this one is TLS)," \
    "accept the self-signed certificate warning, then sign in as '$DSH_WEB_USERNAME' with the" \
    "password you set. The other endpoint, container port $PROXY_PORT, serves a page saying the" \
    "same thing. In dsh: click Choose workspace and pick $WORKSPACE (the session composer needs" \
    "a workspace selected), then start a session — the model is already configured and" \
    "$SKILL_COUNT skills are loaded."
else
  echo "[ocean] ready — reach container port $PROXY_PORT through an SSH tunnel and open it as" \
    "http://127.0.0.1:<local-port>, then sign in as '$DSH_WEB_USERNAME'. A remote browser on" \
    "http:// will fail at Choose workspace. In dsh: click Choose workspace and pick $WORKSPACE," \
    "then start a session — the model is already configured and $SKILL_COUNT skills are loaded."
fi

# If any of the three dies the container stops, rather than leaving something that still looks
# Running and still bills while being unusable — in particular, a dead proxy must never leave
# dsh reachable, and a dead dsh must never leave the port answering.
wait -n $VLLM_PID $DSH_PID $PROXY_PID
