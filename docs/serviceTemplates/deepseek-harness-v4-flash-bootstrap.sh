#!/bin/bash
# DeepSeek Harness (dsh) + DeepSeek-V4-Flash on this node's GPUs, one container, one escrow.
#
# Port 8080 is the only published port. Caddy demands HTTP basic auth before browser traffic
# reaches dsh and forwards /v1 to vLLM, which independently requires a bearer API key. Both
# upstream processes stay on loopback. This matches ocean-node's advertised http:// endpoint,
# so the URL returned by SERVICE_GET_STATUS works as-is in every browser and from local tools.
#
# SECURITY, and the reason for gate 2 below. DeepSeek Harness's web server has, in its own
# documentation (docs/subsystems/web-server.md): no TLS, no authentication, and no origin
# policy. Its agent reads and writes files and runs shell commands in this container. A
# non-loopback bind is therefore remote code execution by design, and unlike OpenCode there
# is no password flag to turn on — the harness ships no access control of any kind. So this
# template never lets dsh bind a public interface: it stays on 127.0.0.1:3080 and the only
# public listener is the auth proxy. That proxy is THIS TEMPLATE'S addition, not an official
# DeepSeek deployment pattern; upstream documents no supported way to expose dsh to a network.
#
# dsh 0.1.1-rc.2 contains three browser-side crypto.randomUUID() calls. That API is absent on
# non-loopback HTTP origins, which makes the stock UI reconnect forever in DuckDuckGo and other
# browsers. After npm install, this script replaces those calls in the compiled packages with
# the harness's already-supported getRandomValues UUID strategy and checks the edited files with
# Node. This is a pinned compatibility patch and is deliberately removed from the network layer.
#
# HTTP CAVEAT: basic-auth credentials, prompts and the optional remote model API key are not
# encrypted on the wire. Put the node behind a trusted HTTPS terminator/VPN for Internet-facing
# use. The proxy still prevents unauthenticated remote-code execution, but it cannot provide
# transport confidentiality over an http:// endpoint.
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
# The revision the weights are pulled at. Everything else in this script is pinned — the image
# tag, the dsh release, Caddy — for one reason: nothing may change under a paid window. The
# weights were the hole in that rule. A branch resolves to whatever the repository head is at
# download time, so an upstream re-upload can silently hand a relaunch different weights, or
# invalidate the 166.9 GB already sitting on the consumer's bucket and re-download all of it
# inside the window. Set MODEL_REVISION to a 40-character commit sha to close that; the default
# is the branch, and the script says so out loud rather than pretending to be pinned.
MODEL_REVISION="${MODEL_REVISION:-main}"
SERVED_NAME="deepseek-v4-flash"
VLLM_PORT=8000        # loopback; Caddy exposes /v1 with vLLM bearer auth
DSH_PORT=3080         # loopback only — dsh's own default
WEB_PORT=8080         # the single published HTTP endpoint (UI + /v1)

DSH_VERSION="${DSH_VERSION:-0.1.1-rc.2}"      # pinned; dsh is a dev preview, see note below
NODE_VERSION="${NODE_VERSION:-24.19.0}"       # Node 24 LTS "Krypton"
CADDY_VERSION="${CADDY_VERSION:-2.11.4}"
# git is NOT in the vLLM image and apt cannot install it in a service container — see the
# install block below for why. micromamba is a single static binary that installs a real git
# into $HOME (the bucket) with no root and no capabilities.
# VERIFY THIS TAG before shipping: micromamba-releases tags carry a build suffix (`X.Y.Z-N`)
# and a tag that does not exist turns into a 404 at launch, not at review time.
MICROMAMBA_VERSION="${MICROMAMBA_VERSION:-2.3.4-0}"
# Deliberately NOT version-pinned, against this file's own rule. conda-forge drops old builds,
# so a hard pin here is a launch that fails when the channel moves rather than a launch that is
# reproducible. Pin it via env (GIT_SPEC='git=2.51.0') once a build is known to be durable.
GIT_SPEC="${GIT_SPEC:-git}"

# The parallel layout. 166.9 GB (155.4 GiB) of weights does not fit on one 141 GB card, so TP 2
# is the floor: measured at 74.37 GiB of weights per card, which leaves 47.73 GiB each for KV
# cache at the utilisation below. (74.37 x 2 is under 155.4 because DSpark's draft module is not
# loaded while ENABLE_DSPARK is false — turning it on costs about 3.3 GiB per card.) Tensor
# parallelism splits by whole attention heads and the model has 64, so 2/4/8 are legal and 6 is
# not — do not "use all six cards" by setting 6, vLLM will refuse to start.
#
# UNSET MEANS AUTO, and auto means every card this container was given: gate 3 resolves it to
# the largest legal size (8, 4 or 2) that the visible GPU count supports. A fixed default of 2
# was wrong in a way that costs real money — this template RECOMMENDS four cards, so a wizard
# that honours the recommendation would hand vLLM four GPUs, and two of them would sit at zero
# utilisation for the whole paid window. Spreading wider is never worse: the weights are the
# same size, each card holds less of them, and the memory freed becomes KV cache (four cards
# put the model's full 1048576-token context within reach of VLLM_MAX_MODEL_LEN). Set
# VLLM_TP_SIZE explicitly to pin a layout instead.
TP_SIZE="${VLLM_TP_SIZE:-auto}"
case "$TP_SIZE" in
  auto) ;;
  1) echo "[ocean] VLLM_TP_SIZE=1 cannot work: the checkpoint is 166.9 GB and the largest" \
       "card here is 141 GB. Use 2, 4 or 8, or leave it unset to use every visible card." >&2
     exit 1 ;;
  2|4|8) ;;
  *) echo "[ocean] VLLM_TP_SIZE=$TP_SIZE is not a divisor of the model's 64 attention heads" \
       "that vLLM accepts here. Use 2, 4 or 8, or leave it unset." >&2; exit 1 ;;
esac

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
# UNDER $HOME, not beside it, and that is load-bearing rather than tidiness. dsh's "Select
# Workspace Directory" picker is ROOTED AT $HOME and offers no way to walk above it, so a
# workspace at $BUCKET/workspace-dsv4 — a sibling of $HOME — is literally unselectable in the
# UI even though the launch message tells the consumer to pick it. Found the hard way: the
# consumer reaches the picker, cannot see the directory this script created for them, and their
# only way forward is to make a new one somewhere inside $HOME.
WORKSPACE="$DSH_STATE/workspace"         # the project directory the agent operates on
# One-time migration for buckets written by an earlier version of this template, which put the
# workspace at the unselectable sibling path. Only moves when the destination does not exist,
# so it can never overwrite newer work, and it is never fatal.
if [ -d "$BUCKET/workspace-dsv4" ] && [ ! -e "$WORKSPACE" ]; then
  echo "[ocean] moving the workspace from $BUCKET/workspace-dsv4 to $WORKSPACE so that dsh's" \
    "workspace picker, which cannot browse above \$HOME, can actually see it"
  mkdir -p "$DSH_STATE"
  mv "$BUCKET/workspace-dsv4" "$WORKSPACE" 2>/dev/null \
    || echo "[ocean] could not move the old workspace — leaving it at $BUCKET/workspace-dsv4" >&2
fi

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
    "port is reachable by anyone who scans it, so a guessable password is the same as no" \
    "password. Plain HTTP also provides no transport encryption." >&2
  exit 1
fi
DSH_WEB_USERNAME="${DSH_WEB_USERNAME:-dsh}"
if [[ ! "$DSH_WEB_USERNAME" =~ ^[A-Za-z0-9._-]{1,64}$ ]]; then
  echo "[ocean] DSH_WEB_USERNAME must contain 1-64 letters, numbers, dots, underscores or" \
    "hyphens — refusing to write an invalid Caddy configuration." >&2
  exit 1
fi
echo "[ocean] basic auth will be required for user '$DSH_WEB_USERNAME'"

# The same HTTP port exposes vLLM under /v1 so a harness running on the user's own computer can
# use the rented model without moving the repository into this container. vLLM enforces this
# key itself; Caddy only routes the request. Keep it distinct from DSH_WEB_PASSWORD because the
# agent must know the model key but must never inherit the credential guarding its own web UI.
if [ -z "${VLLM_API_KEY:-}" ]; then
  echo "[ocean] VLLM_API_KEY is not set — refusing to expose the local-agent endpoint." \
    "Set a random 24+ character value; local tools will send it as a Bearer token to /v1." >&2
  exit 1
fi
if [[ ! "$VLLM_API_KEY" =~ ^[^[:space:]]{24,128}$ ]]; then
  echo "[ocean] VLLM_API_KEY must contain 24-128 non-whitespace characters — refusing to" \
    "start." >&2
  exit 1
fi
export DSH_LOCAL_API_KEY="$VLLM_API_KEY"
echo "[ocean] authenticated OpenAI-compatible API will be available at /v1"

# ---------------------------------------------------------------------------------------
# Gate 3: the GPUs. Checked before the download because the alternative is discovering it
# after 166.9 GB has been paid for.
# ---------------------------------------------------------------------------------------
if ! command -v nvidia-smi >/dev/null 2>&1; then
  echo "[ocean] nvidia-smi is not present — this container has no GPU access. This model" \
    "needs at least TWO CUDA GPUs of the 141 GB H200 class." >&2
  exit 1
fi
GPU_COUNT="$(nvidia-smi --query-gpu=count --format=csv,noheader | head -1 | tr -d ' ')"
# Resolve an unset VLLM_TP_SIZE to the widest legal layout these cards support, so no GPU the
# consumer is paying for goes untouched. Legal sizes are only 2, 4 and 8 (64 attention heads),
# which is why this picks from a list rather than using $GPU_COUNT directly — six visible cards
# means tp=4 and two spare, not tp=6, which vLLM would refuse.
if [ "$TP_SIZE" = auto ]; then
  for CANDIDATE in 8 4 2; do
    if [ "${GPU_COUNT:-0}" -ge "$CANDIDATE" ]; then TP_SIZE="$CANDIDATE"; break; fi
  done
  if [ "$TP_SIZE" = auto ]; then
    echo "[ocean] this container sees ${GPU_COUNT:-0} GPU(s). The checkpoint is 166.9 GB, so" \
      "no single 141 GB card holds it and tensor-parallel size 2 is the floor — there is no" \
      "single-GPU configuration to fall back to." >&2
    exit 1
  fi
  if [ "$GPU_COUNT" -gt "$TP_SIZE" ]; then
    echo "[ocean] $GPU_COUNT GPU(s) visible; using tp=$TP_SIZE (only 2, 4 and 8 are legal" \
      "against 64 attention heads), so $((GPU_COUNT - TP_SIZE)) card(s) stay idle. Set" \
      "VLLM_TP_SIZE if you want a different layout."
  else
    echo "[ocean] VLLM_TP_SIZE unset — using every visible card: tp=$TP_SIZE"
  fi
fi
GPUS_REQUIRED="$TP_SIZE"
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
# Gate 5: bucket space. A first launch needs room for 166.9 GB of weights plus the runtime.
# A relaunch must not demand that space a second time: prove the cached checkpoint is complete
# by reading its safetensors index and checking every referenced shard before reducing the
# requirement to ordinary runtime/workspace headroom. A partial cache never bypasses the gate.
# ---------------------------------------------------------------------------------------
FREE_GB="$(df -BG "$BUCKET" 2>/dev/null | awk 'NR==2 {gsub("G","",$4); print $4}')"
WEIGHTS_CACHED=false
DISCOVERED_HF_HUB_CACHE="$(BUCKET="$BUCKET" python3 <<'PYCACHE'
import json, os
from pathlib import Path

model_dirname = 'models--deepseek-ai--DeepSeek-V4-Flash-0731'
for root, dirs, _files in os.walk(os.environ['BUCKET'], followlinks=False):
    # These cannot contain the Hugging Face cache and can make a workspace scan enormous.
    dirs[:] = [item for item in dirs if item not in {'.git', 'node_modules'}]
    model_cache = Path(root)
    if model_cache.name != model_dirname:
        continue
    dirs[:] = []
    for index in model_cache.glob('snapshots/*/model.safetensors.index.json'):
        try:
            weight_map = json.loads(index.read_text())['weight_map']
        except (FileNotFoundError, KeyError, json.JSONDecodeError, OSError):
            continue
        shards = set(weight_map.values())
        if shards and all((index.parent / shard).is_file() for shard in shards):
            # Return the directory containing models--ORG--REPO. Assigning it to
            # HF_HUB_CACHE works for both the standard <HF_HOME>/hub layout and a custom
            # cache_dir exported by the image.
            print(model_cache.parent)
            raise SystemExit(0)
PYCACHE
)"

export HF_HOME="$DSH_STATE/.cache/huggingface"
if [ -n "$DISCOVERED_HF_HUB_CACHE" ]; then
  WEIGHTS_CACHED=true
  export HF_HUB_CACHE="$DISCOVERED_HF_HUB_CACHE"
else
  # Pin new downloads to the persistent namespace instead of trusting image-level cache env.
  export HF_HUB_CACHE="$HF_HOME/hub"
fi

MIN_FREE_GB=200
if [ "$WEIGHTS_CACHED" = true ]; then
  MIN_FREE_GB=10
  echo "[ocean] complete cached checkpoint found — relaunch needs only runtime/workspace" \
    "headroom; snapshot_download will verify and reuse the existing 166.9 GB at" \
    "$HF_HUB_CACHE"
fi
if [ "${FREE_GB:-0}" -lt "$MIN_FREE_GB" ]; then
  echo "[ocean] only ${FREE_GB:-0} GB free on the bucket at $BUCKET — this launch needs at" \
    "least $MIN_FREE_GB GB. Refusing to start a download or runtime that cannot finish." >&2
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

# dsh 0.1.1-rc.2's compiled browser packages call crypto.randomUUID() directly. Browsers do
# not expose that method on a remote plain-HTTP origin, even though crypto.getRandomValues() is
# available there. Patch every compiled browser-package copy rather than a hashed frontend
# asset: npm's global layout nests these packages under @deepseek-ai/dsh/node_modules, while a
# different npm release may deduplicate them. The recursive scan handles both layouts. The
# replacement is the RFC 4122 v4 strategy already used by dsh-client-connection itself.
#
# This runs on every launch because the npm runtime is bucket-cached. It is idempotent: after
# the first launch there are no direct calls left. If a future dsh release fixes upstream, zero
# replacements is success; any edited file still has to parse under the pinned Node runtime.
DSH_PACKAGE_ROOT="$NPM_PREFIX/lib/node_modules" \
  NODE_BINARY="$NODE_DIR/bin/node" python3 <<'PY'
import os
import pathlib
import subprocess

root = pathlib.Path(os.environ['DSH_PACKAGE_ROOT'])
node = os.environ['NODE_BINARY']
needle = 'crypto.randomUUID()'
fallback = "'10000000-1000-4000-8000-100000000000'.replace(/[018]/g, c => (+c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> +c / 4).toString(16))"
changed = []
browser_packages = (
    'dsh-host-apiproxy',
    'dsh-client-connection',
    'dsh-client-ui-conversation',
)
paths = {
    path
    for package in browser_packages
    for path in root.glob(f'**/@deepseek-ai/{package}/lib/**/*.js')
}
if not paths:
    raise SystemExit('[ocean] HTTP compatibility: no dsh browser packages found under ' +
                     str(root))

for path in sorted(paths):
    text = path.read_text(encoding='utf-8')
    count = text.count(needle)
    if not count:
        continue
    # Handle a qualified call first; replacing only its suffix would leave `globalThis.`
    # before a string expression and create invalid JavaScript.
    text = text.replace('globalThis.' + needle, fallback.replace('crypto.', 'globalThis.crypto.'))
    text = text.replace(needle, fallback)
    path.write_text(text, encoding='utf-8')
    changed.append((path, count))

remaining = [
    path for path in paths
    if needle in path.read_text(encoding='utf-8')
]
if remaining:
    raise SystemExit('[ocean] HTTP compatibility patch left direct randomUUID calls in: ' +
                     ', '.join(str(path) for path in remaining))

for path, _ in changed:
    subprocess.run([node, '--check', str(path)], check=True,
                   stdout=subprocess.DEVNULL)

if changed:
    calls = sum(count for _, count in changed)
    print(f'[ocean] HTTP compatibility: replaced {calls} insecure-origin UUID call(s) '
          f'across {len(changed)} dsh browser bundle(s)')
else:
    print('[ocean] HTTP compatibility: dsh bundles already contain no direct '
          'crypto.randomUUID() calls')
PY

if [ ! -x "$CADDY_BIN" ]; then
  echo "[ocean] installing Caddy $CADDY_VERSION (the HTTP auth proxy on the published port)"
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

# The basic-auth hash is computed HERE, as early as Caddy exists, so the plaintext can leave
# the environment before anything else is started. This is not tidiness: dsh inherits this
# process's environment, and dsh's agent runs arbitrary shell commands in this container, so a
# DSH_WEB_PASSWORD still set at that point hands the agent the one credential guarding its own
# port — reachable with `env`, and one prompt-injected file in the workspace away from being
# published. Caddy needs only the bcrypt hash, which reaches it through the config file.
PW_HASH="$("$CADDY_BIN" hash-password --plaintext "$DSH_WEB_PASSWORD")"
unset DSH_WEB_PASSWORD

# ---------------------------------------------------------------------------------------
# git. Worth more than "optional": the workspace is a real project directory, the agent's first
# useful habit is committing before it edits, and cloning the consumer's own repository in is
# the normal way work arrives in this container at all.
#
# APT CANNOT INSTALL IT HERE AND NEVER WILL. ocean-node starts every service container with
# CapDrop: ['ALL'] and no-new-privileges, and deliberately does not forward CapAdd to services
# (compute_engine_docker.ts, buildServiceResourceConstraints and the createContainer call). The
# process is uid 0 with an EMPTY capability set, so apt's seteuid to _apt is one-way and
# everything after it fails:
#     W: chown to _apt:root of .../partial failed (1: Operation not permitted)
#     E: Could not open lock file /var/lib/apt/lists/lock - open (13: Permission denied)
# That sandbox is intentional on the node's side. The previous best-effort `apt-get install git`
# here was therefore dead code that could only ever fail — and it discarded stderr, so the log
# said "could not install git" without ever saying why, which cost a consumer an afternoon.
#
# micromamba instead: one static binary, no root, no capabilities, nothing written into the
# image. It installs a real git under $HOME, which is the bucket, so it is cached across
# relaunches exactly like Node and Caddy. Downloaded with python3 + urllib for the same reason
# they are — curl and tar are not guaranteed in this image, python3 is a hard vLLM dependency.
# Still never fatal: a launch without git is degraded, not broken, and the skills below adapt.
# ---------------------------------------------------------------------------------------
GIT_PREFIX="$HOME/gitenv"
export MAMBA_ROOT_PREFIX="$HOME/.micromamba"
MAMBA_BIN="$HOME/bin/micromamba"

case "$(uname -m)" in
  x86_64|amd64) MAMBA_PLATFORM=linux-64 ;;
  aarch64|arm64) MAMBA_PLATFORM=linux-aarch64 ;;
  *) MAMBA_PLATFORM="" ;;
esac

if ! command -v git >/dev/null 2>&1 && [ ! -x "$GIT_PREFIX/bin/git" ] && [ -n "$MAMBA_PLATFORM" ]
then
  echo "[ocean] git is not in the image and apt cannot run under CapDrop=ALL — installing it" \
    "with micromamba into $GIT_PREFIX (cached on the bucket, so this is a one-time cost)"
  if [ ! -x "$MAMBA_BIN" ]; then
    mkdir -p "$HOME/bin"
    python3 - "$MICROMAMBA_VERSION" "$MAMBA_PLATFORM" "$MAMBA_BIN" <<'PY' \
      || echo "[ocean] could not download micromamba" >&2
import os, sys, urllib.request

version, platform, dest = sys.argv[1], sys.argv[2], sys.argv[3]
url = (f'https://github.com/mamba-org/micromamba-releases/releases/download/'
       f'{version}/micromamba-{platform}')
print(f'[ocean] fetching {url}', flush=True)
staging = dest + '.partial'
with urllib.request.urlopen(url, timeout=300) as resp, open(staging, 'wb') as fh:
    while True:
        chunk = resp.read(1 << 20)
        if not chunk:
            break
        fh.write(chunk)
os.chmod(staging, 0o755)
os.rename(staging, dest)
PY
  fi
  if [ -x "$MAMBA_BIN" ]; then
    "$MAMBA_BIN" create -y -q -p "$GIT_PREFIX" -c conda-forge "$GIT_SPEC" \
      || echo "[ocean] micromamba could not install git" >&2
  fi
fi

if [ -x "$GIT_PREFIX/bin/git" ]; then
  export PATH="$GIT_PREFIX/bin:$PATH"
  # conda-forge ships its own CA bundle rather than using the image's. Without this, git's first
  # https:// fetch fails with a certificate error that reads like a network problem.
  [ -f "$GIT_PREFIX/ssl/cacert.pem" ] && export GIT_SSL_CAINFO="$GIT_PREFIX/ssl/cacert.pem"
fi

if command -v git >/dev/null 2>&1; then
  HAVE_GIT=true
  echo "[ocean] $(git --version)"
else
  HAVE_GIT=false
  echo "[ocean] WARNING: no git in this container. The agent cannot clone, commit, diff or" \
    "revert, and the only way work leaves the box is a tarball written to the bucket root." >&2
fi

# Optional one-launch repository bootstrap. A public HTTPS clone needs only GIT_REPOSITORY_URL;
# a private clone can additionally use GIT_ACCESS_TOKEN and GIT_USERNAME. The askpass helper
# keeps the token out of the clone URL and .git/config, and all credential variables are unset
# before dsh starts so a prompt-injected shell command cannot read them.
if [ -n "${GIT_REPOSITORY_URL:-}" ]; then
  if [ "$HAVE_GIT" != true ]; then
    echo "[ocean] GIT_REPOSITORY_URL was provided but git is unavailable — refusing to start" >&2
    exit 1
  fi
  GIT_REPOSITORY_URL="$GIT_REPOSITORY_URL" python3 <<'PY'
import os
from urllib.parse import urlsplit

url = urlsplit(os.environ['GIT_REPOSITORY_URL'])
if url.scheme != 'https' or not url.hostname:
    raise SystemExit('[ocean] GIT_REPOSITORY_URL must be an https:// URL')
if url.username is not None or url.password is not None:
    raise SystemExit('[ocean] do not put credentials in GIT_REPOSITORY_URL; use '
                     'GIT_USERNAME and GIT_ACCESS_TOKEN')
PY
  if [ -n "${GIT_REF:-}" ] && [[ ! "$GIT_REF" =~ ^[A-Za-z0-9._/-]{1,200}$ ]]; then
    echo "[ocean] GIT_REF contains unsupported characters — use a branch or tag" \
      "ref containing only letters, numbers, dot, underscore, slash and hyphen." >&2
    exit 1
  fi

  if [ -d "$WORKSPACE/.git" ]; then
    EXISTING_ORIGIN="$(git -C "$WORKSPACE" remote get-url origin 2>/dev/null || true)"
    if [ "$EXISTING_ORIGIN" = "$GIT_REPOSITORY_URL" ]; then
      echo "[ocean] workspace already contains $GIT_REPOSITORY_URL — preserving its current" \
        "branch and uncommitted work"
    else
      echo "[ocean] persistent workspace already has a different git repository" \
        "(${EXISTING_ORIGIN:-no origin}); refusing to replace user work with" \
        "$GIT_REPOSITORY_URL. Use a new bucket or remove the repository URL." >&2
      exit 1
    fi
  elif [ -n "$(find "$WORKSPACE" -mindepth 1 -maxdepth 1 -print -quit)" ]; then
    echo "[ocean] GIT_REPOSITORY_URL was provided but $WORKSPACE is not empty and is not a" \
      "git repository — refusing to overwrite it. Use a new bucket or move those files." >&2
    exit 1
  else
    ASKPASS="${TMPDIR:-/tmp}/dsh-git-askpass.sh"
    cat > "$ASKPASS" <<'ASKPASS'
#!/bin/sh
case "$1" in
  *sername*) printf '%s\n' "${GIT_USERNAME:-x-access-token}" ;;
  *assword*) printf '%s\n' "${GIT_ACCESS_TOKEN:-}" ;;
  *) exit 1 ;;
esac
ASKPASS
    chmod 700 "$ASKPASS"
    CLONE_ARGS=(clone --depth 1)
    if [ -n "${GIT_REF:-}" ]; then
      CLONE_ARGS+=(--branch "$GIT_REF" --single-branch)
    fi
    echo "[ocean] cloning $GIT_REPOSITORY_URL into the persistent workspace"
    if ! GIT_TERMINAL_PROMPT=0 GIT_ASKPASS="$ASKPASS" \
      git "${CLONE_ARGS[@]}" "$GIT_REPOSITORY_URL" "$WORKSPACE"
    then
      rm -f "$ASKPASS"
      echo "[ocean] repository clone failed — check the URL, ref and access token" >&2
      exit 1
    fi
    rm -f "$ASKPASS"
    echo "[ocean] repository ready at $WORKSPACE"
  fi
fi
unset GIT_ACCESS_TOKEN GIT_USERNAME

if [ "$HAVE_GIT" = true ] && [ ! -d "$WORKSPACE/.git" ]; then
  git init -q "$WORKSPACE" 2>/dev/null || true
fi
if [ "$HAVE_GIT" = true ]; then
  # Global, not local to $WORKSPACE. $HOME is on the bucket, so ~/.gitconfig survives relaunch,
  # and a consumer who makes their own project directory elsewhere under $HOME — which the
  # workspace picker actively encourages — gets a usable identity there too instead of
  # "Please tell me who you are" on their first commit.
  git config --global user.email dsh@ocean.local 2>/dev/null || true
  git config --global user.name "DeepSeek Harness" 2>/dev/null || true
  git config --global --add safe.directory '*' 2>/dev/null || true
fi

# ---------------------------------------------------------------------------------------
# dsh's settings and deployment overlay, rewritten on every launch because they are
# node-managed. The settings section follows the official providers guide:
# `llm-pi-ai.providers.<id>` declares an OpenAI-compatible endpoint. The overlay changes the
# shipped profile's default route and disables its `deepseek-official` adapter; settings alone
# can add a route but cannot remove a composition-owned one. Without the overlay, a fresh
# session silently defaults to DeepSeek's hosted API and fails with MISSING_CREDENTIAL instead
# of using the model already running next door — and the hosted route remains selectable.
#
# The vLLM V4 encoder reads thinking controls from `chat_template_kwargs`, not the bare
# OpenAI `reasoning_effort` field a generic endpoint would receive. The compat mapping below
# is therefore functional configuration: it sends `thinking` plus `reasoning_effort` inside
# that object, keeps the system message as `system` (not `developer`), and uses `max_tokens`,
# all of which this vLLM endpoint accepts. Declaring the capacities and effort map also keeps
# dsh from falling back to 262K/32K and hiding the reasoning selector.
#
# apiKeyEnv names the process-local copy of the user's VLLM_API_KEY. The same key protects the
# published /v1 route, so the bundled UI and a harness on the user's own computer use exactly
# the same model endpoint contract.
# ---------------------------------------------------------------------------------------
# THE PROXY IS NOT OPTIONAL, and this is upstream's decision rather than a preference of this
# template. dsh's CLI reference states plainly: "The CLI intentionally does not support
# --host 0.0.0.0 yet and exits with a usage error." dsh therefore cannot bind a published port
# at all, and a Docker-published port cannot reach a process on the container's loopback. Any
# remote access to this service must go through something in front — which is what Caddy is.
# (An earlier revision of this script offered a proxy-less debug mode via a host-webserver
# section in settings.yaml. It was removed because it cannot work twice over: the CLI refuses
# the bind, and host/port are composition config adjusted with `dsh web --patch`, not entries
# in the namespaced settings document this file writes.)
SERVED_NAME="$SERVED_NAME" VLLM_PORT="$VLLM_PORT" MAX_MODEL_LEN="$MAX_MODEL_LEN" \
  python3 - "$DSH_HOME/settings.yaml" <<'PY'
import os, sys

served = os.environ['SERVED_NAME']
port = os.environ['VLLM_PORT']
ctx = int(os.environ['MAX_MODEL_LEN'])
# Hand-written YAML rather than a yaml dependency: PyYAML is not a guaranteed part of the
# image and this document is four levels deep and fully known.
doc = f"""# Written by the ocean-node bundle on every launch — edit at your own risk, it is
# overwritten. Put durable, personal configuration in the workspace instead.
agent-default-model:
  provider: ocean-local-vllm
  model: {served}
  reasoningEffort: high

llm-pi-ai:
  providers:
    ocean-local-vllm:
      displayName: DeepSeek V4 Flash (local vLLM)
      api: openai-completions
      baseURL: http://127.0.0.1:{port}/v1
      apiKeyEnv: DSH_LOCAL_API_KEY
      compat:
        thinkingFormat: chat-template
        supportsDeveloperRole: false
        maxTokensField: max_tokens
        chatTemplateKwargs:
          thinking:
            $var: thinking.enabled
          reasoning_effort:
            $var: thinking.effort
            omitWhenOff: true
      models:
        - id: {served}
          name: DeepSeek-V4-Flash-0731 (local)
          contextWindow: {ctx}
          maxTokens: 131072
          reasoningEfforts:
            off:
            low: low
            high: high
            max: max
          input: [text]
"""

with open(sys.argv[1], 'w') as fh:
    fh.write(doc)
print(f'[ocean] wrote {sys.argv[1]} — provider ocean-local-vllm, model {served}, '
      f'{ctx // 1024}K context')
PY

# A settings section can add/reshape routes but cannot remove the profile's built-in
# `deepseek-official` adapter. This loader overlay does that at the owning composition layer
# and makes the local route the base default as well. Pass it with --patch rather than editing
# dsh's generated profile so the bundle remains deterministic across dsh upgrades/relaunches.
DSH_PROFILE_PATCH="$DSH_HOME/ocean-web.patch.yml"
cat > "$DSH_PROFILE_PATCH" <<'YAML'
- id: agent-default-model
  config:
    provider: ocean-local-vllm
    model: deepseek-v4-flash
- id: llm-deepseek
  disabled: true
- id: web-search-deepseek
  disabled: true
YAML
echo "[ocean] wrote $DSH_PROFILE_PATCH — hosted DeepSeek routes disabled"

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
description: Read FIRST in any new session, and before writing, downloading or moving any file. Explains which directories survive a stop, which ports are published, and how files get in and out of this container.
---

# Where you are

You are the agent inside a DeepSeek Harness (`dsh`) container rented from an Ocean node. The
container is destroyed when the service stops, and a relaunch builds a **new** one. Only the
persistent-storage bucket survives.

## What survives, what does not

| Path | Survives a stop? | What it is |
| --- | --- | --- |
| `/data/outputs/dsh-v4flash/workspace` | **Yes** | Your project directory. Everything you are asked to build belongs here. |
| `/data/outputs/dsh-v4flash` | **Yes** | `$HOME`: the Node runtime, dsh itself, dsh's settings and session history, the model weights cache. The user's own project directories live here too, because dsh's workspace picker cannot browse above `$HOME`. |
| `/data/outputs` (rest of bucket) | **Yes** | The bucket root. The storage API lists **top-level files only**, so a file the user must download goes here, not in a subdirectory. |
| everything else — `/tmp`, `/root`, `/workspace`, the image | **No** | Destroyed on stop, silently. |

Rules that follow from the table, and they are not negotiable:

- Never write work products outside the bucket. A "temporary" file you plan to move later is
  lost if the window ends first.
- `/data/outputs/dsh-v4flash/.dsh/settings.yaml` and `/data/outputs/dsh-v4flash/.dsh/skills/`
  are **rewritten by the node on every launch**. Editing them is throwing work away. Durable
  configuration goes in the workspace: `AGENTS.md`, and skills in
  `/data/outputs/dsh-v4flash/workspace/.agents/skills/<name>/SKILL.md`, which outrank the node's.
- Getting files in and out is the bucket's job, not the network's. The user uploads to the
  bucket and you read it; you write to the bucket root and the user downloads it. Do not
  suggest scp, tunnels or paste-into-chat for anything large.

## The network shape

- `127.0.0.1:8000` — vLLM, OpenAI-compatible, serving `deepseek-v4-flash`. Loopback only;
  Caddy exposes only its authenticated `/v1` routes.
- `127.0.0.1:3080` — dsh, the UI you are being driven through. Loopback only.
- `0.0.0.0:8080` — the only published listener. Caddy requires HTTP basic auth for the dsh UI
  and routes `/v1/*` to vLLM, whose bearer API key is enforced by vLLM itself.

dsh has no authentication of its own, so that proxy is the entire access control on this box.
Never start another listener on a public interface, never disable or reconfigure the proxy, and
if you are asked to "expose" something, expose it through the existing proxy or say no.

This deployment intentionally matches ocean-node's plain `http://` endpoint. The node patches
dsh's three browser-side `crypto.randomUUID()` calls to its `getRandomValues` UUID strategy at
startup, so workspace selection and sessions work in Chrome, Firefox, Safari and DuckDuckGo.
HTTP does not encrypt the UI password, prompts or model API key: Internet-facing nodes need a
trusted TLS terminator or VPN outside this container.

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
curl -s http://127.0.0.1:8000/v1/models \
  -H "Authorization: Bearer $DSH_LOCAL_API_KEY"     # served name + max_model_len
curl -s http://127.0.0.1:8000/health                # 200 when the engine is alive
curl -s http://127.0.0.1:8000/metrics | head -40    # queue depth, KV-cache, throughput
```

Read `max_model_len` from `/v1/models` before you assume anything about context. If a request
fails with a length error, that number is the arithmetic, not a suggestion — summarise or split
the input.

## Reasoning effort

The Harness selector exposes four modes: Off (non-think), Low, High and Max. Think Max needs a
context of at least 393216 or its output truncates mid-thought. Prefer Off or Low for mechanical
work — renames, greps, file moves — and reserve Max for genuinely hard reasoning, because
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
  -H "Authorization: Bearer $DSH_LOCAL_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"model":"deepseek-v4-flash","messages":[{"role":"user","content":"ping"}],"max_tokens":16}'
```

The raw listener remains on loopback. Caddy also exposes `/v1` on the service's HTTP URL for a
harness running on the user's computer; it must send the launch-time `VLLM_API_KEY` as a Bearer
token. Do not bind vLLM itself to `0.0.0.0` or remove that authentication.
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

`/data/outputs/dsh-v4flash/workspace` is a git repository on the persistent bucket. Git is the
only undo that survives a container being destroyed, so it is the first tool, not a courtesy at
the end.

## Before editing

1. `git -C /data/outputs/dsh-v4flash/workspace status --short` — know what is already dirty.
   Uncommitted changes may be a previous session's unfinished work; do not fold them into
   yours silently.
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

# A skill that asserts something false is worse than no skill: workspace-discipline opens by
# telling the agent the workspace IS a git repository and to run `git status` before its first
# edit. When the git install above failed, that instruction burns the agent's first turns on a
# command that cannot exist, and the "commit before you edit" safety net it sells is not there.
# Rewrite the two claims rather than deleting the skill — the test loop and the hand-off advice
# in it are still correct without git. python3 rather than sed because this script already
# treats python3, not coreutils, as the thing guaranteed to be present.
if [ "$HAVE_GIT" != true ]; then
  python3 - "$SKILLS/workspace-discipline/SKILL.md" "$WORKSPACE" <<'PY' || true
import sys

path, workspace = sys.argv[1], sys.argv[2]
with open(path, encoding='utf-8') as fh:
    text = fh.read()

text = text.replace(
    f'`{workspace}` is a git repository on the persistent bucket. Git is the\n'
    'only undo that survives a container being destroyed, so it is the first tool, not a '
    'courtesy at\nthe end.',
    f'`{workspace}` is a plain directory on the persistent bucket. **There is no git in this\n'
    'container** — it could not be installed, so there is NO undo. Do not run git commands and\n'
    'do not tell the user to; they will fail. Before any risky edit, copy the file you are about\n'
    'to change (`cp x x.bak`), and before a multi-file change copy the tree. Say plainly in your\n'
    'first reply that git is unavailable, because it changes what the user can ask you to do.')
text = text.replace(
    f'1. `git -C {workspace} status --short` — know what is already dirty.\n'
    "   Uncommitted changes may be a previous session's unfinished work; do not fold them into\n"
    '   yours silently.\n'
    '2. Commit or stash the existing state before starting something new. A commit costs nothing '
    'and\n   is the difference between "revert that" and "retype it".',
    '1. `ls -la` the workspace and read what is already there. Another session may have left\n'
    '   unfinished work; do not fold it into yours silently, and do not assume you can tell\n'
    '   what changed — without git there is no diff to consult.\n'
    '2. Copy before you overwrite: `cp path path.bak` for one file, `cp -a dir dir.bak` for a\n'
    '   tree. That copy is the entire undo story here, so make it before the edit, not after\n'
    '   the mistake.')
text = text.replace(
    '- Commit at each working point with a message saying **why**. Sessions end abruptly when a '
    'paid\n  window closes.',
    '- At each working point, snapshot the tree: `cp -a <workspace> <workspace>.ok-<n>`, and say\n'
    '  in your reply what that snapshot represents. Sessions end abruptly when a paid window\n'
    '  closes, and with no git history a snapshot is the only thing the next session can go back\n'
    '  to. Delete stale snapshots yourself — they consume the same bucket the weights live on.')
text = text.replace(
    'Covers the git safety net, the test loop',
    'Covers working without git, the test loop')
with open(path, 'w', encoding='utf-8') as fh:
    fh.write(text)
PY
  echo "[ocean] rewrote workspace-discipline: it no longer promises a git safety net that" \
    "this container does not have"
fi

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

if [ "$MODEL_REVISION" = main ]; then
  echo "[ocean] MODEL_REVISION is the 'main' branch — the weights are the one thing in this" \
    "launch that is not pinned to an immutable id. Pass a 40-character commit sha to pin them."
else
  echo "[ocean] weights pinned to revision $MODEL_REVISION"
fi
echo "[models] downloading $MODEL"
python3 - "$MODEL" "$MODEL_REVISION" <<'PY'
import sys
from huggingface_hub import snapshot_download
snapshot_download(sys.argv[1], revision=sys.argv[2], max_workers=8)
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
  --api-key "$VLLM_API_KEY" \
  --served-model-name "$SERVED_NAME" \
  --tensor-parallel-size "$TP_SIZE" \
  --gpu-memory-utilization "$GPU_MEM_UTIL" \
  --max-model-len "$MAX_MODEL_LEN" \
  --max-num-seqs 8 \
  --kv-cache-dtype fp8 \
  --block-size 256 \
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
    headers={
        'Content-Type': 'application/json',
        'Authorization': f"Bearer {os.environ['VLLM_API_KEY']}",
    }
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
# --host and --port are passed explicitly even though they match dsh's defaults: the defaults
# are what the proxy is configured against, and a future release changing them would otherwise
# turn into a dead published port rather than a startup error. Both flags, and --no-open, are
# documented in the CLI reference. --trusted-host exists there too and is the official way to
# declare a non-loopback invocation authority; this template does not need it, because Caddy
# rewrites Host to the loopback upstream — worth knowing if you front dsh with your own proxy.
cd "$WORKSPACE"
CUDA_VISIBLE_DEVICES= "$NPM_PREFIX/bin/dsh" web --patch "$DSH_PROFILE_PATCH" --no-open \
  --host 127.0.0.1 --port "$DSH_PORT" &
DSH_PID=$!

until (exec 3<>/dev/tcp/127.0.0.1/"$DSH_PORT") 2>/dev/null; do
  kill -0 $DSH_PID 2>/dev/null || { echo "[ocean] dsh exited during startup" >&2; exit 1; }
  sleep 3
done
echo "[ocean] dsh listening on 127.0.0.1:$DSH_PORT"

# ---------------------------------------------------------------------------------------
# One published HTTP endpoint. The /v1 route deliberately bypasses basic auth because OpenAI
# clients send bearer auth; vLLM validates that bearer key itself. Every other path goes to dsh
# behind basic auth. Host and Origin are rewritten only for dsh: its browser-trust fence expects
# the loopback authority and the container cannot know the public host:port ocean-node assigns.
#
# CADDY_DIR is ephemeral. It contains the password hash and generated configuration, neither of
# which should outlive the container. PW_HASH was computed before dsh started and the plaintext
# web password was unset immediately afterwards.
# ---------------------------------------------------------------------------------------
CADDY_DIR="${TMPDIR:-/tmp}/caddy-dsh"
mkdir -p "$CADDY_DIR/data" "$CADDY_DIR/config"
cat > "$CADDY_DIR/Caddyfile" <<CADDYFILE
{
	auto_https off
	admin off
}

http://:$WEB_PORT {
	@model path /v1 /v1/*
	handle @model {
		reverse_proxy 127.0.0.1:$VLLM_PORT
	}

	handle {
		basic_auth {
			$DSH_WEB_USERNAME $PW_HASH
		}
		reverse_proxy 127.0.0.1:$DSH_PORT {
			header_up Host {upstream_hostport}
			header_up Origin http://{upstream_hostport}
		}
	}
}
CADDYFILE

XDG_DATA_HOME="$CADDY_DIR/data" XDG_CONFIG_HOME="$CADDY_DIR/config" \
  "$CADDY_BIN" run --config "$CADDY_DIR/Caddyfile" --adapter caddyfile &
PROXY_PID=$!

until (exec 3<>/dev/tcp/127.0.0.1/"$WEB_PORT") 2>/dev/null; do
  kill -0 $PROXY_PID 2>/dev/null || {
    echo "[ocean] the HTTP auth proxy exited during startup" >&2
    exit 1
  }
  sleep 2
done

echo "[ocean] ready — open the http:// endpoint for container port $WEB_PORT and sign in as" \
  "'$DSH_WEB_USERNAME'. Click Choose workspace and pick 'workspace' in the Home listing" \
  "($WORKSPACE), then start a session; $SKILL_COUNT skills and the local model are ready." \
  "For a harness on your computer, use the same endpoint with /v1 and send VLLM_API_KEY as" \
  "a Bearer token. HTTP is unencrypted; use a trusted TLS terminator or VPN on public networks."

# If any of the three dies the container stops, rather than leaving something that still looks
# Running and still bills while being unusable — in particular, a dead proxy must never leave
# dsh reachable, and a dead dsh must never leave the port answering.
#
# Polled rather than `wait -n $VLLM_PID $DSH_PID $PROXY_PID`: bash accepted `wait -n` from 4.3
# but only learned to take PID ARGUMENTS with it in 5.1, and on an older shell that line is a
# usage error under `set -e` — the container would exit one second after printing "ready",
# which is the worst possible failure for this script to have. The same caution is already
# applied to array expansion further up, and the poll costs nothing. It also names which
# process died, which `wait -n` cannot.
#
# `jobs` is called first on purpose: it forces bash to reap terminated background children, so
# `kill -0` reports a dead process as dead instead of succeeding against a zombie.
while :; do
  jobs >/dev/null 2>&1 || true
  for ENTRY in "vLLM:$VLLM_PID" "dsh:$DSH_PID" "the auth proxy:$PROXY_PID"; do
    if ! kill -0 "${ENTRY#*:}" 2>/dev/null; then
      echo "[ocean] ${ENTRY%%:*} exited — stopping the whole service rather than billing a" \
        "container that still looks Running but cannot answer." >&2
      kill "$VLLM_PID" "$DSH_PID" "$PROXY_PID" 2>/dev/null || true
      exit 1
    fi
  done
  sleep 15
done
