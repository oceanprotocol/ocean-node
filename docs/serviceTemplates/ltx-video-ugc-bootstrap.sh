#!/bin/bash
# The image's own entrypoint copies its ComfyUI bundle into /root/ComfyUI, which fails on
# hosts where the service container is not uid 0 — bypassed here in favor of running ComfyUI
# straight from the read-only bundle via --base-directory.
set -euo pipefail

WF_ID="${COMFY_WORKFLOW_ID:-}"
# COMFY_WORKFLOW_ID is client-supplied and becomes both a directory and a filename.
# ServiceStartHandler never loads templates, so userConfigurableEnvVars.validation is NOT enforced
# node-side — this check is the only thing standing between userData and a path traversal. No dots:
# the directory becomes a Python module name that ComfyUI imports.
if [ -n "$WF_ID" ] && ! [[ "$WF_ID" =~ ^[A-Za-z0-9_-]{1,64}$ ]]; then
  echo "[ocean] invalid COMFY_WORKFLOW_ID" >&2
  exit 1
fi

echo "[ocean] $(id) | /data/outputs: $(ls -ld /data/outputs 2>&1 | head -1)"

if [ -d /data/outputs ]; then
  BASE=/data/outputs/comfy
  OUTPUT_DIR_ARGS="--output-directory /data/outputs"
else
  BASE=/tmp/comfy
  OUTPUT_DIR_ARGS=""
  echo "[ocean] no bucket mounted — models download to the container and are lost on stop." \
    "If you did select a bucket, the node is not applying outputBucketId: check that it runs" \
    "ocean-node with service bucket-mount support, and that persistentStorage is configured." >&2
fi

MODELS="$BASE/models"
mkdir -p "$MODELS/checkpoints" "$MODELS/loras" "$MODELS/text_encoders" \
  "$MODELS/latent_upscale_models" "$BASE/output" "$BASE/input" "$BASE/temp" "$BASE/user"

# Download to .part then rename: a truncated file in a persistent bucket would be treated as
# cached by every future launch.
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
  # HTTP 200 is not proof of a model file: a proxy or HF error page returns a few hundred bytes
  # with a success status. Without this floor that body gets renamed into place and every later
  # launch treats it as cached. The smallest real file here is ~300 MB, so 10 MB is unambiguous.
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

HF=https://huggingface.co
get "$HF/Lightricks/LTX-2.3-fp8/resolve/main/ltx-2.3-22b-dev-fp8.safetensors" \
  "$MODELS/checkpoints/ltx-2.3-22b-dev-fp8.safetensors"
get "$HF/Comfy-Org/ltx-2/resolve/main/split_files/text_encoders/gemma_3_12B_it_fp4_mixed.safetensors" \
  "$MODELS/text_encoders/gemma_3_12B_it_fp4_mixed.safetensors"
get "$HF/Comfy-Org/ltx-2.3/resolve/main/split_files/loras/ltx_2.3_22b_distilled_1.1_lora_dynamic_fro09_avg_rank_111_bf16.safetensors" \
  "$MODELS/loras/ltx_2.3_22b_distilled_1.1_lora_dynamic_fro09_avg_rank_111_bf16.safetensors"
get "$HF/Comfy-Org/ltx-2/resolve/main/split_files/loras/gemma-3-12b-it-abliterated_lora_rank64_bf16.safetensors" \
  "$MODELS/loras/gemma-3-12b-it-abliterated_lora_rank64_bf16.safetensors"
get "$HF/Lightricks/LTX-2.3/resolve/main/ltx-2.3-spatial-upscaler-x2-1.1.safetensors" \
  "$MODELS/latent_upscale_models/ltx-2.3-spatial-upscaler-x2-1.1.safetensors"

if [ -n "$WF_ID" ] && [ -n "${COMFY_WORKFLOW:-}" ]; then
  # Pack directory and graph filename are both $WF_ID, so the client's deep link
  # (?template=<id>&source=<id>) resolves without either side hard-coding a name.
  PACK="$BASE/custom_nodes/$WF_ID"
  SAVED="$BASE/user/default/workflows"
  mkdir -p "$PACK/example_workflows" "$SAVED"
  echo 'NODE_CLASS_MAPPINGS = {}' > "$PACK/__init__.py"
  # Escrow is already claimed by the time this runs — a corrupt payload must not take the container
  # down with it. Degrade to no workflow and keep going; the decode's stderr lands in the logs.
  if printf '%s' "$COMFY_WORKFLOW" | base64 -d | gunzip > "$PACK/example_workflows/$WF_ID.json"; then
    # Also a saved workflow, so it appears in ComfyUI's sidebar without the template browser.
    cp "$PACK/example_workflows/$WF_ID.json" "$SAVED/$WF_ID.json"
    echo "[ocean] installed workflow $WF_ID (template pack + Workflows sidebar)"
  else
    echo "[ocean] failed to decode COMFY_WORKFLOW — starting ComfyUI without a workflow" >&2
    rm -f "$PACK/example_workflows/$WF_ID.json"
  fi
fi

export HOME="$BASE"
export PYTHONPYCACHEPREFIX="$BASE/.cache/pycache"
export XDG_CACHE_HOME="$BASE/.cache"
export HF_HOME="$BASE/.cache/huggingface"

echo "[ocean] starting ComfyUI with base directory $BASE"
exec python3.13 /default-comfyui-bundle/ComfyUI/main.py \
  --base-directory "$BASE" ${OUTPUT_DIR_ARGS} --listen --port 8188 ${CLI_ARGS:-}
