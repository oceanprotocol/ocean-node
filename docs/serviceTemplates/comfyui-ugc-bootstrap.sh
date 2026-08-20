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
# Model subdirectories are created on demand, next to each download, since the graph now
# says which ones it needs. $MODELS itself still has to exist unconditionally: the
# no-workflow path skips the download loop entirely, and without this the bucket would have
# no models/ for a user uploading weights through the UI, while the `du -sm "$MODELS"`
# VRAM heuristic further down could never fire.
mkdir -p "$MODELS" "$BASE/output" "$INPUT_DIR" "$BASE/temp" "$BASE/user"

# LTX-2.5 and other gated repos 401 without a token. An array, not a string: under
# `set -u` an unquoted empty string would still hand curl an empty argument, and the
# ${x[@]+"${x[@]}"} form below is what keeps an empty array safe on older bash.
# if/then rather than `[ -n ... ] && ...`: under `set -e` a failing && chain at top
# level exits the script, which would break every ungated template.
HF_AUTH=()
if [ -n "${HF_TOKEN:-}" ]; then
  HF_AUTH=(-H "Authorization: Bearer $HF_TOKEN")
  echo "[ocean] HF_TOKEN set — gated repositories are reachable"
else
  echo "[ocean] no HF_TOKEN — any gated repository this template needs will 401"
fi

# Byte count the server promises, after following HuggingFace's redirect to its CDN. The last
# content-length in the chain is the real one. Prints 0 when the server won't say.
remote_size() {
  curl -sIL ${HF_AUTH[@]+"${HF_AUTH[@]}"} --retry 3 --retry-delay 2 --max-time 60 "$1" 2>/dev/null |
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
  # Unverified without a real token: curl resends -H across cross-host redirects, and HF
  # redirects LFS to a presigned CDN URL. If that CDN rejects the doubled auth, switch to
  # resolve-then-fetch — a -I carrying the header to learn the CDN URL, then a clean GET
  # of that URL. Test on first real launch before assuming this path works.
  http_code=$(curl -L ${HF_AUTH[@]+"${HF_AUTH[@]}"} --retry 5 --retry-delay 5 -C - -o "$2.part" -w '%{http_code}' "$1")
  http_code="${http_code:-000}"
  if [ "$http_code" = "416" ] && [ -f "$2.part" ]; then
    echo "[ocean] $(basename "$2").part already complete"
  elif [ "$http_code" = "401" ] || [ "$http_code" = "403" ]; then
    echo "[ocean] $(basename "$2"): HTTP $http_code — this repository is gated." \
      "Open the model page, click 'Agree and Access' with the same account that owns" \
      "your token, then set HF_TOKEN on this service and relaunch." >&2
    rm -f "$2.part"
    return 22
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
  # Every installed workflow, not just the deep-linked one: a template can ship a second
  # workflow with its own weights (the H3 prompt generator's text encoder), and scanning only
  # the deep link would leave it without them. Ordered + deduplicated across files.
  # Emits "directory<TAB>url" per line: directory comes from the same node's properties.models[]
  # entry ComfyUI itself reads to know where a file goes, not guessed from the URL's shape —
  # the guess was wrong for files whose HuggingFace repo path doesn't match ComfyUI's layout
  # (e.g. a LoRA with neither "loras" nor "lora" in its path or filename).
  MODEL_URLS=$(python3.13 - "$PACK"/example_workflows/*.json <<'PY' || true
import json, re, sys

URL_RE = re.compile(r'https://huggingface\.co/[^\s\)\]"]+?\.safetensors')
# A directory value that doesn't look like a bare subdirectory name is rejected outright: it is
# graph content from the client (COMFY_WORKFLOW) and becomes a path segment in "$MODELS/$sub",
# so an unvalidated "../../etc" would write outside $MODELS.
# No ^/$ anchors, checked with fullmatch() instead of match(): Python's $ matches before a
# trailing newline, so "loras\n" would pass a match()-based ^...$ check. fullmatch() has no
# such gap. Do not "simplify" this to the WF_ID-style ^...$ + match() idiom above — that would
# silently reopen the bypass.
DIR_RE = re.compile(r'[a-z0-9_]{1,32}')

def guess_dir(url):
    # Fallback for a URL with no properties.models[] entry (a MarkdownNote link, for example) or
    # an invalid directory — the same shape-based guess this script always used.
    if '/diffusion_models/' in url: return 'diffusion_models'
    if '/text_encoders/' in url: return 'text_encoders'
    if '/vae_approx/' in url: return 'vae_approx'
    if '/vae/' in url: return 'vae'
    if '/loras/' in url: return 'loras'
    if re.search(r'[Ll]ora', url): return 'loras'
    if 'upscaler' in url: return 'latent_upscale_models'
    return 'checkpoints'

seen = []           # ordered, deduplicated URLs, in the order first seen
directories = {}     # normalised url -> directory, from properties.models[] entries

# URL_RE stops at '.safetensors', so a graph URL written as
# '.../clip_l.safetensors?download=true' -- a shape Comfy-Org templates do emit -- is
# collected truncated while properties.models[] stores it whole. Keying the map on the
# raw string then misses every such entry and silently falls back to the shape guess,
# which is how clip_l.safetensors was routed to checkpoints/ instead of text_encoders/
# and broke the Motion workflow at queue time. Normalise both sides.
def norm(url):
    return url.split('?', 1)[0].split('#', 1)[0]

def walk(o):
    if isinstance(o, dict):
        props = o.get('properties')
        if isinstance(props, dict) and isinstance(props.get('models'), list):
            for m in props['models']:
                if isinstance(m, dict) and isinstance(m.get('url'), str) and isinstance(m.get('directory'), str):
                    directories.setdefault(norm(m['url']), m['directory'])
        for v in o.values(): walk(v)
    elif isinstance(o, list):
        for v in o: walk(v)
    elif isinstance(o, str):
        for m in URL_RE.findall(o):
            if m not in seen: seen.append(m)

for path in sys.argv[1:]:
    try:
        walk(json.load(open(path)))
    except Exception as e:
        print(f'[ocean] cannot read model URLs from {path}: {e}', file=sys.stderr)

for url in seen:
    d = directories.get(norm(url))
    if d is None:
        # No properties.models[] entry -- a MarkdownNote link, say. Expected; the shape
        # guess is the documented fallback for it, so this is not worth a warning.
        d = guess_dir(url)
    elif not DIR_RE.fullmatch(d):
        # An entry that HAS a directory we refused is a different story: either a broken
        # template or a traversal attempt from a client-supplied graph. Say so, because
        # the misroute only surfaces much later as a red loader node, after escrow is
        # claimed.
        print(f'[ocean] {url.rsplit("/", 1)[-1]}: ignoring unusable directory {d!r} in the '
              f'graph, falling back to the URL shape', file=sys.stderr)
        d = guess_dir(url)
    print(f'{d}\t{url}')
PY
)
  if [ -z "$MODEL_URLS" ]; then
    echo "[ocean] no model URLs found in the workflow — ComfyUI will start without weights" >&2
  fi
  while IFS=$'\t' read -r sub url; do
    [ -n "$url" ] || continue
    mkdir -p "$MODELS/$sub"
    # One renamed file must not cost the whole paid session.
    get "$url" "$MODELS/$sub/$(basename "$url")" ||
      echo "[ocean] could not fetch $(basename "$url") — ComfyUI will start without it" >&2
  done <<< "$MODEL_URLS"
else
  echo "[ocean] no workflow supplied — skipping model download" >&2
fi

# The graph's LoadImage/LoadAudio widgets name example assets. Putting them in input/ is what
# makes the first Queue work without the user uploading anything — without it ComfyUI rejects
# the prompt with "Value not in list: image", because it validates combo widgets across the
# whole reachable graph even for nodes the selected branch never runs.
# Every installed workflow, not just the deep-linked one, exactly like the model-URL scan
# above: a template can ship several graphs and the user switches between them in the tab
# bar without relaunching. Seeding only the deep link left the others' LoadImage widgets
# empty ("A required media input has no file selected") whenever they named different files.
if [ -n "$WORKFLOW_JSON" ]; then
  python3.13 - "$INPUT_DIR" "$PACK"/example_workflows/*.json <<'PY' || true
import json, re, shutil, sys, urllib.parse, urllib.request
from pathlib import Path

# ComfyUI writes outputs as <prefix>_00001_.<ext>. A template's assemble workflow loads the
# clips its multishot workflow produced, so those names are generated, never seedable. Now
# that every installed workflow is scanned they would be eight guaranteed 404s per launch.
OUTPUT_NAME = re.compile(r'.+_\d{5}_\.\w+$')

# Three sources, in order: a per-node properties.inputUrl the graph carries itself, then the
# installed comfyui_workflow_templates package, then Comfy-Org's input/ directory by filename.
# The package used to vendor these assets, but every release since 0.11.26 is a ~10 KB
# meta-package carrying none, so that middle lookup currently always misses and is kept only in
# case it starts shipping them again.
RAW = 'https://raw.githubusercontent.com/Comfy-Org/workflow_templates/main/input/'

dirs = []
try:
    import comfyui_workflow_templates as pkg
    base = Path(pkg.__file__).parent
    dirs = [base / 'templates' / 'input', base / 'templates', base / 'input']
except Exception:
    pass

dest = Path(sys.argv[1])
nodes = []
for path in sys.argv[2:]:
    try:
        nodes.extend(json.load(open(path)).get('nodes', []))
    except Exception as e:
        # One unreadable graph must not stop the others from seeding.
        print(f'[ocean] could not read {path} for seeding: {e}', file=sys.stderr)
if not nodes:
    raise SystemExit(0)

for node in nodes:
  # Per-node, because the graph is client-supplied: a name with a NUL or over 255 bytes makes
  # even the cleanup below raise, and one malformed node must not stop the rest from seeding.
  try:
    if not isinstance(node, dict) or node.get('type') not in ('LoadImage', 'LoadAudio', 'LoadVideo'):
        continue
    widgets = node.get('widgets_values')
    name = widgets[0] if isinstance(widgets, list) and widgets else None
    # The graph arrives from the client, so `name` is untrusted and becomes both a URL segment
    # and a write path. Basename only: Path('../x').name and Path('/etc/x').name both differ
    # from the original, and Path('..').name is '', so traversal cannot survive this.
    if not isinstance(name, str) or not name or Path(name).name != name or name[0] == '.':
        continue
    if OUTPUT_NAME.match(name):
        continue
    if (dest / name).exists():
        continue
    # A graph may carry its own source for an input, the way loader nodes carry model URLs, so a
    # template can ship an asset that does not exist in Comfy-Org's input/ directory. https only,
    # and the filename still comes from the widget, so this widens where bytes come from without
    # widening where they land.
    override = None
    props = node.get('properties')
    if isinstance(props, dict):
        cand = props.get('inputUrl')
        if isinstance(cand, str) and cand.startswith('https://'):
            override = cand
    if override:
        part = dest / (name + '.part')
        try:
            # Several image CDNs (Pexels among them) 403 a bare urllib request, so identify.
            req = urllib.request.Request(override, headers={'User-Agent': 'ocean-node/1.0'})
            with urllib.request.urlopen(req, timeout=60) as r, open(part, 'wb') as f:
                shutil.copyfileobj(r, f)
            part.rename(dest / name)
            print(f'[ocean] fetched example input {name}')
        except Exception as e:
            try:
                part.unlink(missing_ok=True)
            except Exception:
                pass
            print(f'[ocean] could not fetch {name} from its inputUrl ({e})', file=sys.stderr)
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

# Node packs for the ALL-in-ONE MiniMax H3 template, gated on its graph like the block above.
if [ -n "${PACK:-}" ] && grep -qls H3OneNode "$PACK"/example_workflows/*.json 2>/dev/null; then
  if ! command -v git >/dev/null 2>&1; then
    echo "[ocean] no git in the image — skipping the ALL-in-ONE H3 node packs" >&2
  else
    for repo in LeonQ8/ComfyUI-ALLinONE-MinimaxH3 \
                seitanism/ComfyUI-H3-Motion-Context-MultiRef \
                kijai/ComfyUI-SolAttn_triton \
                kijai/ComfyUI-KJNodes \
                Larryvrh/ComfyUI-MiniMax-H3-Turbo; do
      H3_DIR="$BASE/custom_nodes/${repo##*/}"
      if [ -d "$H3_DIR/.git" ]; then
        # The clones live in the bucket and outlive the container, so without this they stay on
        # whatever was HEAD the first time this bucket launched — and these packs are only
        # compatible at matching versions. Motion Context added a required audio_feather_ticks
        # input that an older ALL-in-ONE never sends, which fails Extend at queue time with
        # "Required input is missing". reset --hard, not pull: the config and workflow edits
        # below are re-applied on every launch, so local modifications are expendable here.
        git -C "$H3_DIR" fetch -q --depth 1 origin HEAD &&
          git -C "$H3_DIR" reset -q --hard FETCH_HEAD ||
          echo "[ocean] could not update ${repo##*/} — staying on the installed version; if" \
            "Extend or Chain report a missing input, delete $H3_DIR and relaunch" >&2
      elif ! git clone --depth 1 "https://github.com/$repo.git" "$H3_DIR"; then
        echo "[ocean] could not clone $repo — its modes or quality presets will report" \
          "a missing node in the UI" >&2
        rm -rf "$H3_DIR"
      fi
    done
    # MiniMaxH3-Cache calls time_shift_slope, gone from core since 2026-08-06, and patches the
    # model at import — so its presence alone fails every generation. Delete a stale clone.
    if grep -qs time_shift_slope "$BASE/custom_nodes/ComfyUI-MiniMaxH3-Cache/__init__.py"; then
      echo "[ocean] removing ComfyUI-MiniMaxH3-Cache: it calls time_shift_slope, which this" \
        "ComfyUI no longer has, and it breaks every H3 generation. Speed's other half (SolAttn)" \
        "is unaffected — switch the H3 Cache chip off under the Quality dropdown." >&2
      rm -rf "$BASE/custom_nodes/ComfyUI-MiniMaxH3-Cache"
    fi
    # KJNodes is the only pack with dependencies; pip lands in the container, so reinstall each
    # launch (cheap — XDG_CACHE_HOME keeps the wheel cache in the bucket).
    if [ -f "$BASE/custom_nodes/ComfyUI-KJNodes/requirements.txt" ]; then
      python3.13 -m pip install -q -r "$BASE/custom_nodes/ComfyUI-KJNodes/requirements.txt" ||
        echo "[ocean] KJNodes dependencies failed to install — turn Live Preview off in the" \
          "node's Settings; generation itself is unaffected" >&2
    fi
    # These packs monkey-patch comfy.ldm.minimax.model; report names core no longer defines
    # before a paid Run hits the AttributeError. Names only — not signatures or shapes.
    python3.13 - "$BASE/custom_nodes" <<'PROBE' || true
import ast, re, sys
from pathlib import Path

core = Path('/default-comfyui-bundle/ComfyUI/comfy/ldm/minimax/model.py')
if not core.is_file():
    print('[ocean] no comfy.ldm.minimax.model in this image — skipping the pack compatibility check',
          file=sys.stderr)
    raise SystemExit(0)
have = set()
for n in ast.parse(core.read_text(encoding='utf-8')).body:
    if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
        have.add(n.name)
    elif isinstance(n, ast.Assign):
        have.update(t.id for t in n.targets if isinstance(t, ast.Name))
    elif isinstance(n, ast.AnnAssign) and isinstance(n.target, ast.Name):
        have.add(n.target.id)
    elif isinstance(n, (ast.Import, ast.ImportFrom)):
        # `import comfy.ldm.common_dit` binds `comfy`, and packs do reach through it.
        have.update((a.asname or a.name.split('.')[0]) for a in n.names)

REF = re.compile(r'(?:comfy\.ldm\.minimax\.model|minimax\.model|minimax_model|h3m)\.([A-Za-z_]\w*)')
root = Path(sys.argv[1])
missing = {}
for f in sorted(root.rglob('*.py')):
    try:
        src = f.read_text(encoding='utf-8', errors='replace')
    except OSError:
        continue
    gone = set(REF.findall(src)) - have
    if gone:
        missing.setdefault(f.relative_to(root).parts[0], set()).update(gone)
for pack, names in sorted(missing.items()):
    print(f'[ocean] {pack} calls {", ".join(sorted(names))}, which this ComfyUI does not define —'
          f' expect an AttributeError mid-generation. Remove the pack or turn off the feature'
          f' that uses it.', file=sys.stderr)
if not missing:
    print('[ocean] pack compatibility check: no missing core names')
PROBE
    # Make the pack's shipped defaults match what is actually installed.
    python3.13 - "$BASE/custom_nodes/ComfyUI-ALLinONE-MinimaxH3/config.json" \
      "$BASE/user/default/one-node-minimax-h3/config.json" <<'LORA' || true
import json, sys
from pathlib import Path

# Both layers: _load_config() does merged.update(user), so a saved user config shadows the pack's.
# .get() and never setdefault — a partial dict in the user layer replaces the built-in wholesale.
# speed needs the H3 Cache node and high needs sageattention; neither is installed, so drop them
# rather than ship them degraded under names that promise otherwise.
REMOVE = ('speed', 'high')
FALLBACK = 'balanced'
# Discover-tab templates for modes whose node packs are not installed.
REMOVE_MODES = ('audio_drive', 'image')

# Vertical presets: flipped copies of the pack's own shapes, plus one exact 9:16. All /32.
VERTICAL = ((352, 608, '0.2MP Vertical Preview'), (480, 864, '0.4MP Vertical Speed'),
            (544, 960, '0.5MP Vertical Balanced'), (576, 1024, '0.6MP Vertical 9:16'),
            (768, 1344, '0.98MP Vertical Max'))

for arg in sys.argv[1:]:
    cfg = Path(arg)
    if not cfg.is_file():
        continue
    try:
        data = json.loads(cfg.read_text(encoding='utf-8'))
        changed = []
        md = data.get('model_defaults')
        if isinstance(md, dict) and not md.get('speed_lora'):
            md['speed_lora'] = 'minimax_h3_turbo_v4_step600_ema.safetensors'
            changed.append('Turbo LoRA selected')
        qp = data.get('quality_presets')
        if isinstance(qp, dict):
            for preset in REMOVE:
                if qp.pop(preset, None) is not None:
                    changed.append(f'{preset} preset removed')
        # A saved `quality` naming a removed preset would point at nothing on load.
        if data.get('quality') in REMOVE:
            data['quality'] = FALLBACK
            changed.append(f'quality reset to {FALLBACK}')
        pt = data.get('prompt_templates')
        if isinstance(pt, dict):
            for mode in REMOVE_MODES:
                if pt.pop(mode, None) is not None:
                    changed.append(f'{mode} prompts removed')
        rp = data.get('resolution_presets')
        if isinstance(rp, list):
            for w, h, tag in VERTICAL:
                label = f'{w}x{h} ({tag})'
                if not any(p.get('label') == label for p in rp):
                    rp.append({'label': label, 'width': w, 'height': h})
                    changed.append(label)
        if changed:
            cfg.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding='utf-8')
            print(f'[ocean] {cfg.name} adjusted — ' + '; '.join(changed))
    except Exception as e:
        print(f'[ocean] could not adjust {cfg} ({e}) — pick the Turbo LoRA under Settings and'
              ' switch the H3 Cache chip off before using Speed', file=sys.stderr)
LORA
    # The pack saves under one-node-minimax-h3/, a subfolder listFiles cannot see. Flatten it so
    # clips land in the bucket root. Chain is not covered — its prefix is built in the JS.
    sed -i 's#one-node-minimax-h3/##g' \
      "$BASE/custom_nodes/ComfyUI-ALLinONE-MinimaxH3/workflows/"*.json 2>/dev/null || true
    # ...which leaves the node's own Library tab empty: it only walks output/one-node-minimax-h3/.
    # Scan the output root as well — one level, not recursively, because that root IS the bucket
    # and models/ and custom_nodes/ hang off it. The original walk stays for chain, which still
    # writes to the subfolder. relpath of the root against itself is ".", and a "." subfolder in
    # the media key would not match the history's "", losing the seed and prompt in the lightbox.
    python3.13 - "$BASE/custom_nodes/ComfyUI-ALLinONE-MinimaxH3/nodes.py" <<'GALLERY' || true
import sys
from pathlib import Path

OLD_WALK = """    if not out_dir.is_dir():
        return []
    found = []
    for root, _dirs, files in os.walk(str(out_dir)):
"""
NEW_WALK = """    scans = [(str(base), [], sorted(f.name for f in base.iterdir() if f.is_file()))]
    if out_dir.is_dir():
        scans += list(os.walk(str(out_dir)))
    found = []
    for root, _dirs, files in scans:
"""
OLD_SUB = '            sub = os.path.relpath(os.path.dirname(full), str(base)).replace("\\\\", "/")\n'
NEW_SUB = OLD_SUB + '            sub = "" if sub == "." else sub\n'

src = Path(sys.argv[1])
try:
    text = src.read_text(encoding="utf-8")
    for old, new in ((OLD_WALK, NEW_WALK), (OLD_SUB, NEW_SUB)):
        if new in text:
            continue
        if text.count(old) != 1:
            raise LookupError("_scan_output_videos no longer looks like the patched version")
        text = text.replace(old, new)
    src.write_text(text, encoding="utf-8")
    print("[ocean] Library tab pointed at the output root")
except Exception as e:
    print(f"[ocean] could not patch the Library scan ({e}) — generated clips still land in the"
          " bucket root and download fine, but the node's Library tab will look empty."
          " Use the History tab, or the storage API's listFiles.", file=sys.stderr)
GALLERY
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
