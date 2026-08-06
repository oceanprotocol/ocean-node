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
  "$MODELS/latent_upscale_models" "$BASE/output" "$INPUT_DIR" "$BASE/temp" "$BASE/user"

# .part then rename: a truncated file in a persistent bucket would look cached forever.
get() {
  if [ -f "$2" ]; then
    echo "[ocean] cached $(basename "$2")"
    return 0
  fi
  echo "[ocean] downloading $(basename "$2")"
  http_code=$(curl -L --retry 5 --retry-delay 5 -C - -o "$2.part" -w '%{http_code}' "$1")
  if [ "$http_code" = "416" ] && [ -f "$2.part" ]; then
    echo "[ocean] $(basename "$2").part already complete"
  elif [ "$http_code" -lt 200 ] || [ "$http_code" -ge 300 ]; then
    echo "[ocean] download failed for $(basename "$2") (HTTP $http_code)" >&2
    return 22
  fi
  # A proxy or HF error page returns a few hundred bytes with HTTP 200; without this floor that
  # body would be cached as a model. Smallest real file is ~300 MB.
  size=$(wc -c < "$2.part")
  if [ "$size" -lt 10485760 ]; then
    echo "[ocean] $(basename "$2") is only $size bytes — not a model file. First bytes:" >&2
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
    INSTALLED=$(python3.13 - "$RAW" "$PACK/example_workflows" "$SAVED" <<'PY' || true
import json, re, sys
raw_path, pack_dir, saved_dir = sys.argv[1:4]
try:
    workflows = json.load(open(raw_path, encoding='utf-8'))
    if not isinstance(workflows, dict) or not workflows:
        raise ValueError('expected a non-empty object of "<id>": <graph>')
except Exception as e:
    print(f'[ocean] COMFY_WORKFLOW did not decode to an id -> graph object: {e}', file=sys.stderr)
    sys.exit(0)
for wf_id, graph in workflows.items():
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
      */text_encoders/*) sub=text_encoders ;;
      */loras/*)         sub=loras ;;
      *upscaler*)        sub=latent_upscale_models ;;
      *)                 sub=checkpoints ;;
    esac
    # One renamed file must not cost the whole paid session.
    get "$url" "$MODELS/$sub/$(basename "$url")" ||
      echo "[ocean] could not fetch $(basename "$url") — ComfyUI will start without it" >&2
  done
else
  echo "[ocean] no workflow supplied — skipping model download" >&2
fi

# The graph's LoadImage/LoadAudio widgets name example assets that ship inside the
# comfyui-workflow-templates package. Copying them into input/ is what makes the first Queue
# work without the user uploading anything.
if [ -n "$WORKFLOW_JSON" ]; then
  python3.13 - "$WORKFLOW_JSON" "$INPUT_DIR" <<'PY' || true
import json, shutil, sys
from pathlib import Path
try:
    import comfyui_workflow_templates as pkg
    src = Path(pkg.__file__).parent / 'templates'
    graph = json.load(open(sys.argv[1]))
    dest = Path(sys.argv[2])
    for node in graph.get('nodes', []):
        if node.get('type') in ('LoadImage', 'LoadAudio'):
            name = (node.get('widgets_values') or [None])[0]
            if name and (src / name).is_file() and not (dest / name).exists():
                shutil.copy2(src / name, dest / name)
                print(f'[ocean] seeded input {name}')
except Exception as e:
    print(f'[ocean] could not seed example inputs: {e}', file=sys.stderr)
PY
fi

export HOME="$BASE"
export PYTHONPYCACHEPREFIX="$BASE/.cache/pycache"
export XDG_CACHE_HOME="$BASE/.cache"
export HF_HOME="$BASE/.cache/huggingface"

echo "[ocean] starting ComfyUI with base directory $BASE"
exec python3.13 /default-comfyui-bundle/ComfyUI/main.py \
  --base-directory "$BASE" ${OUTPUT_DIR_ARGS} --listen --port 8188 ${CLI_ARGS:-}
