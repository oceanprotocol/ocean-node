#!/bin/bash
# Bypasses the image entrypoint, which writes to /root/ComfyUI and fails where the container
# is not uid 0.
set -euo pipefail

WF_ID="${COMFY_WORKFLOW_ID:-}"
# Client-supplied, and becomes a directory + filename. userConfigurableEnvVars.validation is not
# enforced node-side, so this is the only guard against traversal. No dots: it becomes a Python
# module name.
if [ -n "$WF_ID" ] && ! [[ "$WF_ID" =~ ^[A-Za-z0-9_-]{1,64}$ ]]; then
  echo "[ocean] invalid COMFY_WORKFLOW_ID" >&2
  exit 1
fi

echo "[ocean] $(id) | /data/outputs: $(ls -ld /data/outputs 2>&1 | head -1)"

if [ -d /data/outputs ]; then
  BASE=/data/outputs/comfy
  # Rendered shots land in --output-directory; LoadVideo's dropdown only lists --input-directory.
  # Same path for both, so the assemble workflow can pick up clips the generate workflow made.
  INPUT_DIR=/data/outputs
  OUTPUT_DIR_ARGS="--output-directory /data/outputs --input-directory $INPUT_DIR"
else
  BASE=/tmp/comfy
  INPUT_DIR="$BASE/input"
  OUTPUT_DIR_ARGS=""
  echo "[ocean] no bucket mounted — models download to the container and are lost on stop." \
    "If you did select a bucket, the node is not applying outputBucketId: check that it runs" \
    "ocean-node with service bucket-mount support, and that persistentStorage is configured." >&2
fi

MODELS="$BASE/models"
mkdir -p "$MODELS/checkpoints" "$MODELS/loras" "$MODELS/text_encoders" \
  "$MODELS/latent_upscale_models" "$MODELS/diffusion_models" "$MODELS/vae" \
  "$BASE/output" "$INPUT_DIR" "$BASE/temp" "$BASE/user"

# Byte count the server promises, after following HuggingFace's redirect to its CDN. The last
# content-length in the chain is the real one. Prints 0 when the server won't say.
remote_size() {
  curl -sIL --retry 3 --retry-delay 2 --max-time 60 "$1" 2>/dev/null |
    tr -d '\r' | awk 'BEGIN{IGNORECASE=1} /^content-length:/{n=$2} END{print n+0}'
}

# .part then rename, and the finished file is checked against the server's size — on both the
# download and the cache-hit path. A size floor alone is not an integrity check: these files run
# 0.6-20 GB, so a download that died at 1% clears any floor, gets renamed, and is then trusted
# forever by the -f test. safetensors only notices later, at load time, as
# "Error while deserializing header: incomplete metadata, file not fully covered".
get() {
  want=$(remote_size "$1" || echo 0); want="${want:-0}"
  if [ -f "$2" ]; then
    have=$(wc -c < "$2" | tr -dc '0-9'); have="${have:-0}"
    if [ "$want" -gt 0 ] && [ "$have" -ne "$want" ]; then
      echo "[ocean] $(basename "$2") is $have bytes but the server says $want —" \
        "the cached copy is truncated, refetching" >&2
      rm -f "$2"
    else
      echo "[ocean] cached $(basename "$2")"
      return 0
    fi
  fi
  echo "[ocean] downloading $(basename "$2") ($want bytes)"
  http_code=$(curl -L --retry 5 --retry-delay 5 -C - -o "$2.part" -w '%{http_code}' "$1")
  http_code="${http_code:-000}"
  if [ "$http_code" = "416" ] && [ -f "$2.part" ]; then
    echo "[ocean] $(basename "$2").part already complete"
  elif [ "$http_code" -lt 200 ] || [ "$http_code" -ge 300 ]; then
    echo "[ocean] download failed for $(basename "$2") (HTTP $http_code)" >&2
    return 22
  fi
  have=$(wc -c < "$2.part" | tr -dc '0-9'); have="${have:-0}"
  if [ "$want" -gt 0 ] && [ "$have" -ne "$want" ]; then
    echo "[ocean] $(basename "$2") got $have of $want bytes — discarding the partial file" >&2
    rm -f "$2.part"
    return 22
  fi
  # Only reachable when the server refused a content-length. A proxy or HF error page returns a
  # few hundred bytes with HTTP 200; without this floor that body would be cached as a model.
  if [ "$want" -eq 0 ] && [ "$have" -lt 10485760 ]; then
    echo "[ocean] $(basename "$2") is only $have bytes — not a model file. First bytes:" >&2
    head -c 300 "$2.part" >&2 || true
    echo >&2
    rm -f "$2.part"
    return 22
  fi
  mv "$2.part" "$2"
}

WORKFLOW_JSON=""
if [ -n "$WF_ID" ] && [ -n "${COMFY_WORKFLOW:-}" ]; then
  # Pack dir is named after $WF_ID (the first workflow), so ?template=<id>&source=<id> resolves
  # with no hard-coded name on either side. COMFY_WORKFLOW carries every workflow the template
  # ships as {"<id>": <graph>, ...} — each entry gets its own file in the pack + sidebar.
  PACK="$BASE/custom_nodes/$WF_ID"
  SAVED="$BASE/user/default/workflows"
  mkdir -p "$PACK/example_workflows" "$SAVED"
  echo 'NODE_CLASS_MAPPINGS = {}' > "$PACK/__init__.py"
  RAW="$PACK/.comfy_workflow_payload.json"
  # Escrow is already claimed: a corrupt payload must not kill the container.
  if printf '%s' "$COMFY_WORKFLOW" | base64 -d | gunzip > "$RAW"; then
    # `|| true`: a decoded-but-malformed payload (wrong shape, bad ids) must not abort either.
    INSTALLED=$(python3.13 - "$RAW" "$PACK/example_workflows" "$SAVED" "$WF_ID" <<'PY' || true
import json, re, sys
raw_path, pack_dir, saved_dir = sys.argv[1:4]
try:
    payload = json.load(open(raw_path, encoding='utf-8'))
    if not isinstance(payload, dict) or not payload:
        raise ValueError('expected a non-empty object')
except Exception as e:
    print(f'[ocean] COMFY_WORKFLOW did not decode to an object: {e}', file=sys.stderr)
    sys.exit(0)
# A bare graph has a top-level "nodes" list; an id -> graph map does not. Without this check a
# bare graph installs one junk file per dict-valued key it happens to have (config, extra, ...).
if isinstance(payload.get('nodes'), list):
    payload = {sys.argv[4]: payload}
for wf_id, graph in payload.items():
    if not re.fullmatch(r'[A-Za-z0-9_.-]{1,64}', wf_id):
        print(f'[ocean] skipping workflow with unsafe id {wf_id!r}', file=sys.stderr)
        continue
    if not isinstance(graph, dict):
        print(f'[ocean] skipping workflow {wf_id!r} — graph is not an object', file=sys.stderr)
        continue
    text = json.dumps(graph, ensure_ascii=False)
    open(f'{pack_dir}/{wf_id}.json', 'w', encoding='utf-8').write(text)
    open(f'{saved_dir}/{wf_id}.json', 'w', encoding='utf-8').write(text)
    print(wf_id)
PY
)
    rm -f "$RAW"
    if [ -n "$INSTALLED" ]; then
      echo "[ocean] installed workflows: $(echo "$INSTALLED" | tr '\n' ' ') (template pack + Workflows sidebar)"
      if [ -f "$PACK/example_workflows/$WF_ID.json" ]; then
        WORKFLOW_JSON="$PACK/example_workflows/$WF_ID.json"
      else
        echo "[ocean] COMFY_WORKFLOW_ID ($WF_ID) was not among the installed workflows" >&2
      fi
    else
      echo "[ocean] no workflows installed from COMFY_WORKFLOW — starting ComfyUI without one" >&2
    fi
  else
    echo "[ocean] failed to decode COMFY_WORKFLOW — starting ComfyUI without a workflow" >&2
    rm -f "$RAW"
  fi
fi

# The graph carries the HuggingFace URLs for everything it loads, so each template fetches only
# what it uses and a new workflow needs no edit here. Template envVars can't drive this: nothing
# merges them into a service container.
if [ -n "$WORKFLOW_JSON" ]; then
  # `|| true` and the except are both needed: a payload that gunzips but isn't a graph must not
  # abort the bootstrap after escrow is claimed.
  MODEL_URLS=$(python3.13 - "$WORKFLOW_JSON" <<'PY' || true
import json, re, sys
seen = []
def walk(o):
    if isinstance(o, dict):
        for v in o.values(): walk(v)
    elif isinstance(o, list):
        for v in o: walk(v)
    elif isinstance(o, str):
        for m in re.findall(r'https://huggingface\.co/[^\s\)\]"]+?\.safetensors', o):
            if m not in seen: seen.append(m)
try:
    walk(json.load(open(sys.argv[1])))
except Exception as e:
    print(f'[ocean] cannot read model URLs from the workflow: {e}', file=sys.stderr)
print('\n'.join(seen))
PY
)
  if [ -z "$MODEL_URLS" ]; then
    echo "[ocean] no model URLs found in the workflow — ComfyUI will start without weights" >&2
  fi
  for url in $MODEL_URLS; do
    case "$url" in
      */diffusion_models/*) sub=diffusion_models ;;
      */text_encoders/*)    sub=text_encoders ;;
      */vae/*)              sub=vae ;;
      */loras/*)            sub=loras ;;
      *[Ll]ora*)            sub=loras ;;
      *upscaler*)           sub=latent_upscale_models ;;
      *)                    sub=checkpoints ;;
    esac
    # One renamed file must not cost the whole paid session.
    get "$url" "$MODELS/$sub/$(basename "$url")" ||
      echo "[ocean] could not fetch $(basename "$url") — ComfyUI will start without it" >&2
  done
else
  echo "[ocean] no workflow supplied — skipping model download" >&2
fi

# The graph's LoadImage/LoadAudio widgets name example assets. Putting them in input/ is what
# makes the first Queue work without the user uploading anything — without it ComfyUI rejects
# the prompt with "Value not in list: image", because it validates combo widgets across the
# whole reachable graph even for nodes the selected branch never runs.
if [ -n "$WORKFLOW_JSON" ]; then
  python3.13 - "$WORKFLOW_JSON" "$INPUT_DIR" <<'PY' || true
import json, shutil, sys, urllib.parse, urllib.request
from pathlib import Path

# These assets live at input/ in Comfy-Org/workflow_templates. The pip package used to vendor
# them, but every release since 0.11.26 is a ~10 KB meta-package carrying none — so the local
# lookup below is a fast path that currently always misses, and the download is what actually
# seeds. Both are kept: the package may start shipping assets again.
RAW = 'https://raw.githubusercontent.com/Comfy-Org/workflow_templates/main/input/'

dirs = []
try:
    import comfyui_workflow_templates as pkg
    base = Path(pkg.__file__).parent
    dirs = [base / 'templates' / 'input', base / 'templates', base / 'input']
except Exception:
    pass

try:
    graph = json.load(open(sys.argv[1]))
except Exception as e:
    print(f'[ocean] could not read the workflow for seeding: {e}', file=sys.stderr)
    raise SystemExit(0)
dest = Path(sys.argv[2])

for node in graph.get('nodes', []):
  # Per-node, because the graph is client-supplied: a name with a NUL or over 255 bytes makes
  # even the cleanup below raise, and one malformed node must not stop the rest from seeding.
  try:
    if not isinstance(node, dict) or node.get('type') not in ('LoadImage', 'LoadAudio'):
        continue
    widgets = node.get('widgets_values')
    name = widgets[0] if isinstance(widgets, list) and widgets else None
    # The graph arrives from the client, so `name` is untrusted and becomes both a URL segment
    # and a write path. Basename only: Path('../x').name and Path('/etc/x').name both differ
    # from the original, and Path('..').name is '', so traversal cannot survive this.
    if not isinstance(name, str) or not name or Path(name).name != name or name[0] == '.':
        continue
    if (dest / name).exists():
        continue
    local = next((d / name for d in dirs if (d / name).is_file()), None)
    if local:
        shutil.copy2(local, dest / name)
        print(f'[ocean] seeded input {name}')
        continue
    # .part then rename, like the model downloads above: a truncated asset in a persistent
    # bucket would look seeded forever and fail at Queue time instead of here.
    part = dest / (name + '.part')
    try:
        url = RAW + urllib.parse.quote(name)
        with urllib.request.urlopen(url, timeout=30) as r, open(part, 'wb') as f:
            shutil.copyfileobj(r, f)
        part.rename(dest / name)
        print(f'[ocean] fetched example input {name}')
    except Exception as e:
        try:
            part.unlink(missing_ok=True)
        except Exception:
            pass
        # Non-fatal: escrow is claimed, and the user can always upload their own.
        print(f'[ocean] no example input for {name} ({e}) — upload one in the UI', file=sys.stderr)
  except Exception as e:
    print(f'[ocean] skipped an input node while seeding: {e}', file=sys.stderr)
PY
fi

export HOME="$BASE"
export PYTHONPYCACHEPREFIX="$BASE/.cache/pycache"
# Set before the pip install below, not just for ComfyUI: it puts pip's wheel cache in the
# bucket, so the reinstall on every later launch resolves from disk instead of the network.
export XDG_CACHE_HOME="$BASE/.cache"
export HF_HOME="$BASE/.cache/huggingface"

# Voice conversion for the assemble workflow: LTX re-rolls the speaker on every clip, so a
# stitched reel changes voice at each cut. The node pack that fixes it is not in the image.
# Driven by the graph, like the model URLs are — a template that doesn't use the node pays
# nothing. Cloned code lands in the bucket; pip installs land in the container and are lost
# on stop, hence the unconditional reinstall (cheap, cache is in the bucket). Plain install,
# NOT --target: a second numpy/torch ahead of the container's on PYTHONPATH would break
# ComfyUI itself. Every failure here is non-fatal — escrow is claimed and the video
# workflows need none of this.
if [ -n "${PACK:-}" ] && grep -qls UnifiedVoiceChangerNode "$PACK"/example_workflows/*.json 2>/dev/null; then
  VC_DIR="$BASE/custom_nodes/TTS-Audio-Suite"
  if ! command -v git >/dev/null 2>&1; then
    echo "[ocean] no git in the image — skipping voice-conversion nodes" >&2
  elif [ -d "$VC_DIR/.git" ] || git clone --depth 1 \
      https://github.com/diodiogod/TTS-Audio-Suite.git "$VC_DIR"; then
    echo "[ocean] installing voice-conversion dependencies (first launch is slow)"
    # install.py, not `pip install -r requirements.txt`: that file deliberately omits librosa
    # and descript-audio-codec, which install.py adds with --no-deps so pip cannot downgrade
    # numpy/torch under ComfyUI. Installing the requirements alone leaves ChatterboxVC
    # unimportable ("ChatterboxVC not available - check installation").
    ( cd "$VC_DIR" && python3.13 install.py ) ||
      echo "[ocean] voice-conversion dependencies failed to install — the Voice Changer node" \
        "will be missing; delete it in the assemble workflow and wire Audio Concat straight" \
        "into Create reel" >&2
  else
    echo "[ocean] could not clone TTS-Audio-Suite — the Voice Changer node will be missing" >&2
    rm -rf "$VC_DIR"
  fi
fi

# ComfyUI unloads a model to system RAM after every use unless told otherwise, so on a card that
# could simply hold everything it re-stages the whole checkpoint each step — visible in the log as
# "N MB Staged ... Force pre-loaded 210 weights: 1175 KB" and a VAE that re-stages per decode.
# --highvram stops that, but it is only safe when the card really fits the weight set, so decide
# from what was actually downloaded rather than hard-coding a threshold per template. 3/2 leaves
# room for activations, which at these latent sizes are not small. CLI_ARGS replaces this entirely
# when the caller sets it, so an operator can still force or suppress any flag.
AUTO_ARGS=""
if command -v nvidia-smi >/dev/null 2>&1; then
  VRAM_MB=$(nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits 2>/dev/null |
    head -1 | tr -dc '0-9')
  MODELS_MB=$(du -sm "$MODELS" 2>/dev/null | cut -f1 | tr -dc '0-9')
  if [ -n "$VRAM_MB" ] && [ -n "$MODELS_MB" ] && [ "$MODELS_MB" -gt 0 ] &&
     [ "$VRAM_MB" -ge $(( MODELS_MB * 3 / 2 )) ]; then
    AUTO_ARGS="--highvram"
  fi
  echo "[ocean] ${VRAM_MB:-?} MB VRAM, ${MODELS_MB:-?} MB of weights ->" \
    "auto args: ${AUTO_ARGS:-none (models are large relative to VRAM; letting ComfyUI offload)}"
fi

echo "[ocean] starting ComfyUI with base directory $BASE"
exec python3.13 /default-comfyui-bundle/ComfyUI/main.py \
  --base-directory "$BASE" ${OUTPUT_DIR_ARGS} --listen --port 8188 ${CLI_ARGS:-$AUTO_ARGS}
