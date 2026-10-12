# Node model cache

The node model cache keeps the Hugging Face weights a node's service templates use on the
node's own disk, and mounts them read-only into every service container. A service that follows
the [contract](#indexjson-contract-v1) loads its weights from local disk instead of downloading
tens or hundreds of GB inside its paid window; a service that does not is unaffected. It is off
unless the operator turns it on.

## What it is

- **Node-level and opt-in.** One cache per node, configured by the top-level
  `serviceModelCache` object and off unless `enabled` is `true`. It is not part of a compute
  engine, so the engine rebuild a config push can cause leaves it alone. Services get it;
  compute jobs never do.
- **A read-only mount in every service.** While the cache is on and verified, every service
  container gets the cache's `public/` directory bind-mounted **read-only** at
  `/ocean/model-cache`, and `OCEAN_MODEL_CACHE=/ocean/model-cache` in its environment. The node
  sets the variable exactly when it adds the mount and drops a value supplied in `userData`;
  an image should not set it itself.
- **Only a directory it verified.** Every sync checks the directory — sentinel present, local
  disk, no overlap with node data, bound into the node container at the same host path — and
  the node mounts it only while the last check passed and it is still that same directory.
  The node also checks it once right at boot, so services started in the first minutes get it.
  After `path` changes until a sync has checked the new one, and while a check fails, services
  start without mount and variable.
- **Local Docker daemons only.** dockerd resolves a bind on its own host, so only an engine
  whose daemon is reached through a local socket offers the mount; an engine that talks to a
  daemon over TCP (`protocol`/`host`/`port`) never does.
- **It never fails a start.** If dockerd refuses to create a container with the cache mount,
  the node creates it again without mount and variable. Only when that retry succeeds is the
  mount blamed: the node logs why and offers no mount until the next sync has verified the
  directory again.
- **Decided per container.** The mount is decided when a service's container is created, at
  start and at every restart. Turning the cache on does not reach services already running, and
  turning it off does not take it from them; their next restart does either.

## What goes in it

The node works out the wanted set again at every sync.

**From the service templates** (`fromTemplates`, default on) — the templates the node serves
from `serviceTemplatesPath`:

1. **Workflow URLs.** Every string anywhere in a template's `workflows[].graph`, notes
   included, is scanned for `https://huggingface.co/...safetensors` URLs, the same scan the
   ComfyUI bootstraps run. A URL of the form
   `https://huggingface.co/<org>/<name>/resolve/<revision>/<path>.safetensors`, where
   `<revision>` is a branch or tag name or a full 40-character commit, wants that one file (a
   `?query` or `#fragment` is ignored). Anything else — a short sha, a `blob/` link, a dataset or
   Space, a PR ref (`refs/pr/N`) — is skipped with a warning.
2. **Model includes.** An `includes[]` entry with `kind: "model"` and a `repoId` that none of the
   same template's workflow URLs name wants the **whole repo** at `main`. That can be far more
   than the template's bootstrap downloads; narrow it with a curated entry.

`includeUnlisted: false` leaves out templates marked `unlisted`.

**Curated entries** (`curated[]`) are the operator's own: a repo no template names, a narrower
selection, or a pinned commit. A curated entry **replaces** every template-derived entry of its
repo, at every revision. Without `allowPatterns` or `files` it wants the whole repo.

Entries for the same repo and revision are merged: a whole-repo entry wins, file lists are
united, and files mixed with patterns are united as patterns.

**Priority** decides what is left out when `maxSizeGb` cannot hold everything; lower is more
important. Templates are ranked in catalogue order — lowest `order` first, templates without
one after, unlisted after listed, then by `id` — and their entries take that rank (0, 1, 2,
...). A curated entry with a `priority` ranks on the same scale (`0` is level with the first
template); one without ranks after every template, in list order. So a curated entry that
narrows a template's repo drops below every template unless it carries a `priority`. A merged
entry keeps the best rank.

**Never cached:** repos the Hub reports as gated (anything but an explicit `gated: false`),
private or disabled. They get the status `skipped:gated`, `skipped:private` or
`skipped:disabled`, whatever the token can read: gated weights come with a licence each user
accepts for themselves, and a shared cache would hand them to every tenant. A cached repo the
Hub starts reporting that way is retired like a model no longer wanted. A Hub API error is
different and never retires anything: a repo deleted upstream, or made private, answers `404`
or `401` (status `error`), and the copy cached while it was public stays served for as long as
something wants it.

## Configuration

`serviceModelCache` lives in the config **file**; no environment variable maps to it. Edit the
file and restart the node, or [push it](#changing-it-with-pushconfig) without a restart.

```json
"serviceModelCache": {
  "enabled": true,
  "path": "/data/ocean-model-cache-v1",
  "maxSizeGb": 1300,
  "minFreeGb": 500,
  "curated": [
    { "repo": "example-org/large-model", "allowPatterns": ["*.json", "*.safetensors", "tokenizer*"], "priority": 3 },
    { "repo": "example-org/pinned-model", "commit": "4b3b1f6c2a9d8e7f6a5b4c3d2e1f0a9b8c7d6e5f" }
  ]
}
```

| Key | Type | Default | Rules |
| --- | --- | --- | --- |
| `enabled` | boolean | — | **Required** whenever the object is present, so a partial push fails validation instead of turning the cache off. Leaving the object out, or setting it to `null`, also keeps the cache off. |
| `path` | string | — | Required when enabled. Absolute and normalized (no `.` or `..` segments, no trailing or doubled `/`), not `/`. The **host** path of the cache directory, bound into the node container at the identical path. |
| `maxSizeGb` | number > 0 | — | Required when enabled. Budget in GB (10^9 bytes) for what the cache serves and downloads, each distinct file counted once. Not a hard cap: see the budget in [Sync behaviour](#sync-behaviour). |
| `minFreeGb` | number ≥ 0 | `100` | Downloads stop when they would leave less free space than this on the cache's filesystem. |
| `fromTemplates` | boolean | `true` | Derive the wanted set from the service templates. `false`: curated entries only. |
| `includeUnlisted` | boolean | `true` | Include templates marked `unlisted`. |
| `curated` | array, ≤ 500 | `[]` | Operator entries, below. |
| `syncIntervalMinutes` | integer 5–1440 | `60` | Pause between the end of one sync and the start of the next. |
| `gcGraceHours` | number ≥ 1 | `24` | Minimum time between something leaving `index.json` and its deletion. |

Curated entries (only `repo` is required):

| Key | Rules |
| --- | --- |
| `repo` | Hugging Face model repo id `<org>/<name>`: each part 1–96 characters of `A-Z a-z 0-9 . _ -`, starting with a letter or digit; no `--` or `..`, not ending in `.git` or `.`. |
| `revision` | The branch or tag **name** the cache serves it as (`refs/<revision>`), default `main`: 1–100 characters of `A-Z a-z 0-9 . _ -`, starting with a letter or digit, no `..`, no `/` (so no `refs/pr/N`), and nothing that looks like a commit (7–40 lowercase hex characters) — use `commit` for that. |
| `commit` | Full 40-character lowercase sha. The cache serves exactly this commit as `refs/<revision>`. |
| `allowPatterns` | 1–200 patterns of 1–512 characters, with huggingface_hub `allow_patterns` semantics: Python `fnmatch`, so `*` and `?` also match `/`, `[seq]` and `[!seq]` work, a trailing `/` selects a folder, and matching is case-sensitive. |
| `files` | 1–5000 exact repo-relative paths: forward slashes, no backslash, no empty, `.` or `..` segment. Not together with `allowPatterns`. |
| `priority` | Integer on the template rank scale; lower is more important. |

Every object is strict: a misspelled key (`allow_patterns`, `revison`) fails validation instead
of being ignored. The schema checks syntax only — an error there stops the node at boot or
rejects the push. The directory itself is checked at every sync, and a failure there only means
services start without the mount (see [Troubleshooting](#troubleshooting)).

## Layout on disk

```
<path>/
├── .ocean-model-cache            sentinel {"id", "createdAt"}, written when the node claims the empty directory
├── public/                       the only part mounted into services (read-only)
│   ├── index.json                the consumer contract, below
│   └── hf/hub/models--<org>--<name>/
│       ├── blobs/<hash>          file content, named by the hash it was verified against
│       ├── snapshots/<commit>/<file>   relative symlink into blobs/
│       └── refs/<revision>       the 40-character commit, no trailing newline
└── private/                      node only (0700), never mounted
    ├── state.json                the node's bookkeeping (0400)
    ├── sync.lock                 cross-process lock
    ├── tmp/<hash>.part           partial downloads, resumed by the next sync
    └── trash/                    deletions in progress
```

- `path` must be an **empty** directory the first time. The node writes the sentinel and from
  then on accepts the directory only with it. A non-empty directory without one is refused: its
  `public/` half is mounted into every service, and the node mounts only content it put there
  itself. For the same reason, never copy anything into `path`.
- `public/hf/hub` is the classic huggingface_hub cache layout — per-repo `blobs/`,
  `snapshots/` and `refs/`, no shared blob store — which huggingface_hub reads offline. LFS
  files are stored under their sha256 and other files under their git blob sha1, as
  huggingface_hub names them. A ref holds the bare sha with no newline: huggingface_hub reads it
  without stripping.
- Files are **read-only** (`0444`; `state.json` and the lock `0400`) and directories `0755`,
  readable by any user inside a service. The node replaces files only by rename, so code that
  merely writes through a path cannot change them. A file that is identical in two repos is
  stored once (a hard link).
- Everything lives on one filesystem, so every update is an atomic rename. Do not mount anything
  inside `path`.

## index.json (contract v1)

`$OCEAN_MODEL_CACHE/index.json` (on the host, `<path>/public/index.json`) says what the cache
holds. The node replaces it atomically after every change, so a reader always sees a whole
file. An abridged example — a model served while its update waits for room, one ComfyUI file,
one gated repo:

```json
{
  "version": 1,
  "generatedAt": "2026-10-08T12:00:00.000Z",
  "repos": {
    "Qwen/Qwen3.8-27B-FP8": {
      "refs": { "main": "4b3b1f6c2a9d8e7f6a5b4c3d2e1f0a9b8c7d6e5f" },
      "wanted": {
        "main": {
          "sha": "1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d",
          "status": "deferred:budget",
          "missingBytes": 31254097920
        }
      },
      "snapshots": {
        "4b3b1f6c2a9d8e7f6a5b4c3d2e1f0a9b8c7d6e5f": {
          "path": "hf/hub/models--Qwen--Qwen3.8-27B-FP8/snapshots/4b3b1f6c2a9d8e7f6a5b4c3d2e1f0a9b8c7d6e5f",
          "complete": true,
          "selection": null,
          "files": { "config.json": 1765, "model-00001-of-00007.safetensors": 4967215360 }
        }
      }
    },
    "Comfy-Org/Qwen-Image_ComfyUI": {
      "refs": { "main": "9e8d7c6b5a49382716051e2d3c4b5a6978877665" },
      "wanted": {
        "main": { "sha": "9e8d7c6b5a49382716051e2d3c4b5a6978877665", "status": "ok", "missingBytes": 0 }
      },
      "snapshots": {
        "9e8d7c6b5a49382716051e2d3c4b5a6978877665": {
          "path": "hf/hub/models--Comfy-Org--Qwen-Image_ComfyUI/snapshots/9e8d7c6b5a49382716051e2d3c4b5a6978877665",
          "complete": false,
          "selection": { "files": ["split_files/vae/qwen_image_vae.safetensors"] },
          "files": { "split_files/vae/qwen_image_vae.safetensors": 253806246 }
        }
      }
    },
    "example-org/gated-model": {
      "refs": {},
      "wanted": { "main": { "status": "skipped:gated", "missingBytes": 0 } },
      "snapshots": {}
    }
  }
}
```

- `version` is `1`.
- `refs.<revision>` is the commit of the newest snapshot published for that revision, listed
  only while that snapshot is. A revision that is itself a commit (a template URL can name one)
  has no ref: look the commit up in `snapshots` directly.
- `snapshots.<commit>` is a published snapshot. `path` is relative to `$OCEAN_MODEL_CACHE`.
  `files` maps every file present — verified against its hash and linked — to its size in bytes,
  and is the authority on what is there. `complete` is `true` when the snapshot holds every file
  of the repo at that commit. `selection` is `null` when the whole repo is wanted, otherwise what
  was asked for (`{"allowPatterns": [...]}` or `{"files": [...]}`); it is informational only and
  can name files still downloading. Decide from `complete` and `files`.
- `wanted.<revision>` is what the node is working towards, for diagnosis only: `status`; the
  target `sha` (possibly newer than `refs`; after a Hub API error, the previous target or the
  commit still served); `missingBytes` (once a sync has tried, what is left to download; for a
  `*:budget` status, what did not fit); and `error` when the status is `error`. Statuses: `ok`,
  `downloading`, `deferred:budget` (an update waits for room; the old commit stays served),
  `skipped:budget`, `skipped:gated`, `skipped:private`, `skipped:disabled`, and `error` (a Hub
  API or download failure; a commit published earlier stays served). An interrupted sync can
  leave the list incomplete. Never decide from `wanted` whether to use a snapshot: `refs` and
  `snapshots` are the contract.

A snapshot leaves `index.json` before anything of it is deleted, then stays on disk for at least
`gcGraceHours`, and for as long as a service created before it left is still live.

### Consumer rules

1. **Check the version.** Use `index.json` only when `version` is `1`. A missing, unreadable or
   malformed index, or another version, is a miss — never a reason to fail the service.
2. **Anything short of a published hit is a miss.** Look up `sha = refs[revision]` (or the
   revision itself when it is a 40-character commit), then `snapshots[sha]`, at
   `$OCEAN_MODEL_CACHE/<path>`. Use it only if `complete` is `true` or every file you need is
   in `files`. No repo entry, no ref, a file not listed: a miss. Do not wait for a model that is
   still `downloading`.
3. **Resolve at every launch.** Read the index each time the container starts. Refs move to new
   commits and retired snapshots are deleted, so keep the repo id and revision, never a resolved
   path.
4. **Never store snapshot paths in a bucket.** A bucket outlives the launch and can be mounted
   on a node without a cache, or after the snapshot is gone. Links recreated at every launch, as
   in the ComfyUI snippet below, are fine.
5. **Never set `HF_HOME` to the mount.** huggingface_hub and the libraries on top of it write
   under `HF_HOME` (locks, the Xet chunk cache, remote-code modules), and the mount is
   read-only.
6. **Set `HF_HUB_OFFLINE=1` whenever `HF_HUB_CACHE` points into the mount.** A library that only
   takes a repo id can read the cache with `HF_HUB_CACHE=$OCEAN_MODEL_CACHE/hf/hub`. Online,
   huggingface_hub writes into its cache as soon as the Hub has something the cache lacks — a
   newer commit on the branch, a file not cached — and fails on the read-only mount. Offline it
   cannot fetch a missing file either, so do this only after rule 2 found everything.
7. **Serve vLLM from the snapshot path, with `--served-model-name`:**
   `vllm serve "$OCEAN_MODEL_CACHE/<path>" --served-model-name <name>`. vLLM then reads only that
   directory, and clients keep seeing the model name they expect.
8. **On a cache node, download misses to the container's own disk, never into the bucket.** When
   `OCEAN_MODEL_CACHE` is set and the model is not cached, point `HF_HOME` (and `HF_HUB_CACHE`,
   if the template sets it) at a container directory such as `/tmp/hf`: on a node with a model
   cache, buckets may sit on network storage that loads weights far more slowly than local disk.
   Without the variable, keep what the template did before (typically the bucket, so a relaunch
   reuses the download).

### vLLM bootstrap

A drop-in for a template's `snapshot_download` step; it prints the directory to serve.
`REVISION` is a branch or a pinned commit. Set `ALLOW_PATTERNS` to whatever the template passes
to `snapshot_download` (`[]` for the whole repo): a snapshot the operator narrowed with a curated
`allowPatterns` entry is not `complete`, and is used only when it holds every file those
patterns select at that commit — one Hub API call, no download. Bootstrap checks that assume the
bucket (free space for the download, "weights already in the bucket", a bucket required at all)
must follow the same three cases: a hit, a miss on a cache node, no cache.

```bash
MODEL=Qwen/Qwen3.8-27B-FP8; REVISION=main; SERVED_NAME=qwen3.8-27b; BUCKET=/data/outputs
ALLOW_PATTERNS='[]'   # the template's snapshot_download allow_patterns, as JSON; [] = whole repo

# Prints the directory to serve: the cached snapshot, or a fresh download.
resolve_model() {
  MODEL="$MODEL" REVISION="$REVISION" ALLOW_PATTERNS="$ALLOW_PATTERNS" BUCKET="$BUCKET" \
    python3 - <<'PY'
import json, os, re, sys

repo, rev = os.environ['MODEL'], os.environ['REVISION']
patterns = json.loads(os.environ['ALLOW_PATTERNS']) or None
cache = os.environ.get('OCEAN_MODEL_CACHE')
log = lambda m: print(f'[ocean] {m}', file=sys.stderr, flush=True)

# Where a miss downloads to. huggingface_hub reads these when imported: set them first.
if cache:  # cache node: the container's own disk, never the bucket
    os.environ['HF_HOME'] = os.path.join(os.environ.get('TMPDIR') or '/tmp', 'hf')
    os.environ['HF_HUB_CACHE'] = os.path.join(os.environ['HF_HOME'], 'hub')
else:      # no cache: what the template did before, here the bucket
    os.environ['HF_HOME'] = os.path.join(os.environ['BUCKET'], 'hf')
from huggingface_hub import HfApi, snapshot_download
from huggingface_hub.utils import filter_repo_objects

def cached():
    with open(os.path.join(cache, 'index.json')) as f:
        index = json.load(f)
    if index.get('version') != 1:
        return None
    entry = index['repos'][repo]
    sha = rev if re.fullmatch('[0-9a-f]{40}', rev) else entry['refs'][rev]
    snap = entry['snapshots'][sha]
    path = os.path.join(cache, snap['path'])
    if snap['complete'] is True:
        return path
    if not patterns:
        return None
    # Narrowed by the operator: a hit only if it holds every file the template would
    # download at that commit. One Hub API call, no download.
    names = [s.rfilename for s in HfApi().model_info(repo, revision=sha).siblings]
    need = set(filter_repo_objects(names, allow_patterns=patterns))
    return path if need and need.issubset(snap['files']) else None

path = None
if cache:
    try:
        path = cached()
    except Exception:
        pass  # whatever is wrong with the cache is a miss, never a failed start
if path:
    log(f'{repo}@{rev}: from the node model cache')
else:
    log(f'{repo}@{rev}: downloading')
    path = snapshot_download(repo, revision=rev, allow_patterns=patterns, max_workers=8)
print(path)
PY
}

MODEL_PATH="$(resolve_model)" || exit 1
vllm serve "$MODEL_PATH" --served-model-name "$SERVED_NAME"   # plus the template's own flags
```

### ComfyUI bootstrap

The ComfyUI bootstraps collect `<directory><TAB><url>` lines into `$MODEL_LIST` and fetch each
URL into `$MODELS/<directory>/` with their `get` function (download, size check, rename). With
the cache, each `https://huggingface.co/<repo>/resolve/<revision>/<path>` URL is first mapped to
its cached file — `<path>` in `snapshots[refs[revision]]`, taken only when `files` lists it at
that size — and a hit is symlinked into place. This replaces the bootstrap's download loop:

```bash
# Prints <directory> TAB <url> TAB <cached file, or nothing> for each line of $MODEL_LIST.
resolve_cached() {
  python3.13 - "$MODEL_LIST" <<'PY'
import json, os, re, sys
from urllib.parse import unquote

root, repos = os.environ.get('OCEAN_MODEL_CACHE'), {}
if root:
    try:
        with open(os.path.join(root, 'index.json')) as f:
            index = json.load(f)
        if index.get('version') == 1:
            repos = index['repos']
    except Exception:
        pass  # an unusable index: every URL is a miss
URL = re.compile(r'https://huggingface\.co/([^/]+/[^/]+)/resolve/([^/]+)/(.+)')

def cached(url):
    try:
        m = URL.fullmatch(url.split('?', 1)[0].split('#', 1)[0])
        repo, rev, file = m[1], unquote(m[2]), unquote(m[3])
        entry = repos[repo]
        snap = entry['snapshots'][rev if re.fullmatch('[0-9a-f]{40}', rev) else entry['refs'][rev]]
        full = os.path.join(root, snap['path'], file)
        # Listed in files = verified and linked; the size check guards the rest.
        return full if os.path.getsize(full) == snap['files'][file] else ''
    except Exception:
        return ''

for line in open(sys.argv[1]):
    sub, _, url = line.rstrip('\n').partition('\t')
    if url:
        print(f'{sub}\t{url}\t{cached(url)}')
PY
}

if [ -s "$MODEL_LIST" ]; then
  RESOLVED="${TMPDIR:-/tmp}/models.resolved"
  # If the resolver fails, every URL is a miss rather than none being fetched.
  resolve_cached > "$RESOLVED" ||
    awk -F'\t' -v OFS='\t' '{ print $1, $2, "" }' "$MODEL_LIST" > "$RESOLVED"
  while IFS=$'\t' read -r sub url hit; do
    [ -n "$url" ] || continue
    name=$(basename "$url"); out="$MODELS/$sub/$name"
    mkdir -p "$MODELS/$sub"
    if [ -L "$out" ]; then rm -f "$out"; fi   # a link from an earlier launch: resolve again
    if [ -f "$out" ]; then
      get "$url" "$out"                        # a real file an earlier launch downloaded
    elif [ -n "$hit" ]; then
      ln -s "$hit" "$out" && echo "[ocean] $name: from the node model cache"
    elif [ -n "${OCEAN_MODEL_CACHE:-}" ]; then
      dir="${TMPDIR:-/tmp}/ocean-models/$sub"  # cache node: container disk, never the bucket
      mkdir -p "$dir" && get "$url" "$dir/$name" && ln -s "$dir/$name" "$out"
    else
      get "$url" "$out"                        # no cache: as before
    fi || echo "[ocean] could not fetch $name — ComfyUI will start without it" >&2
  done < "$RESOLVED"
fi
```

A real file an earlier launch left in the bucket is still used; delete it to load that weight
from the cache instead. `python3.13` is the interpreter these ComfyUI images ship. Anything that
sizes the model folder must follow the links — `du -smL "$MODELS"` for the `--highvram`
decision in these bootstraps — or every cached weight counts as nothing.

## Sync behaviour

- **Schedule.** The first sync starts about two minutes after the node does, each next one
  `syncIntervalMinutes` after the previous one ends, and only one runs at a time.
- **Config changes.** Every sync and every container create read the live config, so a change
  (a `pushConfig`, or an edited file after a restart) is picked up by the next sync. To apply it
  at once, restart the node. A sync in progress that sees the cache disabled or its `path`
  changed stops (`sync interrupted (...); progress kept`) and keeps its partial downloads.
- **One sync** verifies the directory, works out the wanted set, asks the Hub API for each
  entry's file list at its revision (one call per entry), selects the files, applies the budget,
  downloads, publishes and collects garbage. A Hub API failure keeps the entry's published
  commit served (status `error`), and nothing is ever retired because of one.
- **Budget.** Entries are taken in priority order, each distinct file counted once, on disk yet
  or not. Every entry books what it serves now together with what it wants, so an update to a
  new commit (or a wider selection) downloads next to what stays served until it is complete.
  An entry is accepted when both fit in `maxSizeGb` next to everything accepted before it. If
  only what it serves fits, it is `deferred:budget`: the old content stays served and the update
  waits. If even that does not fit (`maxSizeGb` lowered, more important models added), it is
  `skipped:budget`, and whatever it served is retired. An entry whose Hub API call failed books
  what it serves unconditionally. What is retired but not deleted yet is not counted: it comes
  on top of `maxSizeGb`, and `minFreeGb` is the only hard limit.
- **Downloads.** Models download in priority order, the largest file of each first, eight
  files at a time, in 2 GiB ranged chunks, at whatever rate the link gives. Each file is hashed as it arrives and checked against the hash the Hub lists
  for that commit (sha256 for LFS files, git blob sha1 otherwise) before it moves into `blobs/`;
  a mismatch discards it. A chunk that fails on a 5xx, a 429, a dropped or stalled connection
  (60 s without data) or a malformed range answer is retried up to three times in a row, with
  backoff; any other 4xx fails the file at once. A failed file is tried again at the next sync. A file
  already cached for another repo is hard-linked instead of downloaded. While data flows, a
  progress line is logged every five minutes.
- **Disk floor.** Before every chunk the node checks that the filesystem's free space, minus
  what the downloads in flight still need, stays above `minFreeGb`. If not, downloads stop until
  the next sync (`paused at the disk floor` in the summary line) and the models concerned stay
  `downloading`. Files already on disk are still linked, so a model that needs no new bytes is
  still published.
- **Publishing.** A snapshot is published as soon as all its files are verified and linked:
  `index.json` is updated and its refs written without waiting for the rest of the sync.
- **Garbage collection, in two phases.** At the end of each sync, a snapshot (or a file of one)
  that is no longer wanted is first **retired**: removed from `index.json`, which is saved
  before anything is deleted; a revision no longer wanted loses its `refs/` file at that point.
  A retired item is deleted once `gcGraceHours` have passed **and** no service created before its
  retirement is still live — starting, pulling or building its image, paying, running,
  restarting or stopping; a stopped, expired or failed service does not hold it. If the service
  list cannot be read, nothing is deleted. A snapshot is deleted by moving it out of `public/`
  into `private/trash/` in one rename, then removing it. Blobs go once no snapshot link on disk
  points at them and nothing accepted in this sync needs them. A snapshot that was never
  published goes at once. An interrupted sync skips garbage collection, and a disabled cache
  collects nothing: turning it off never deletes anything.
- **Frozen templates.** Once a sync has derived models from the templates, a later one that
  cannot load them cleanly — the folder missing or unreadable, a template, command or workflow
  file that fails to load, or no template at all — keeps that last good set (plus what the
  templates that did load ask for) and skips garbage collection, so nothing is retired or
  deleted. A broken or unmounted catalogue therefore never deletes a terabyte of weights; the
  next clean load ends it. To drop every template-derived model on purpose, set
  `fromTemplates: false`. The last good set survives that: turning `fromTemplates` back on while
  the catalogue is empty or broken brings it back.
- **Resume.** Partial downloads stay in `private/tmp/` across syncs, config pushes and node
  restarts, and resume where they stopped (the part already there is hashed again first). One
  that nothing accepted needs any more is removed after 48 hours without change.
- **Lock.** `private/sync.lock` stops two node processes using the same directory (an old
  container still running during a redeploy, say) from syncing at once: the second skips its
  turn and tries again when the lock would count as abandoned. The holder refreshes it every
  minute; it is taken over once ten minutes pass without a refresh, or at once when it was left
  by a process with the same hostname that no longer runs (a restarted container).
- **Shutdown.** Stopping the node stops a running sync; its partial downloads resume at the next
  start.

## Changing it with pushConfig

`pushConfig` (HTTP `POST /api/admin/config/update`, see [API.md](API.md#update-config)) merges
the pushed **top-level** keys into the config file, so a pushed `serviceModelCache` **replaces
the whole object**: anything left out goes back to its default, `curated` included. Push the
`serviceModelCache` key alone, and always the complete object — fetch, edit, push:

1. `fetchConfig` (HTTP `GET /api/admin/config`) returns the config file; take its
   `serviceModelCache`.
2. Edit it.
3. Push it back whole:

```json
{
  "address": "0x...",
  "nonce": "...",
  "signature": "0x...",
  "config": {
    "serviceModelCache": {
      "enabled": true,
      "path": "/data/ocean-model-cache-v1",
      "maxSizeGb": 1300,
      "minFreeGb": 500,
      "curated": []
    }
  }
}
```

- The push is validated before anything is written. One without `enabled`, or with
  `enabled: true` but no `path` or `maxSizeGb`, is rejected; one that has those and leaves other
  keys out is accepted and resets them — which is why the whole object matters.
- A push takes effect at the **next sync** (within `syncIntervalMinutes`), or at once after a
  node restart. Like every `pushConfig` today, it also rebuilds the compute engines; the cache
  is not part of them and carries on.
- To turn the cache off, push the same object with `"enabled": false` (see
  [Turning it off](#turning-it-off)).
- **`CONFIG_PATH` must name a file on a persistent local mount.** The default,
  `/usr/src/app/config.json`, lives in the container's writable layer, so the next recreate (an
  upgrade, `docker compose up --force-recreate`) brings back the image's file and every push is
  lost. A file in `/usr/src/app/databases/` persists
  ([runbook step 3](#3-persist-the-config-file)).
- **Do not use `pushConfig` on a production node until the separate config-redaction fix
  lands.** The response is the whole configuration the node resolved with only
  `keys.privateKey` masked — it still carries the node's raw private key (under
  `over.privateKey`) and every setting taken from environment variables (database credentials,
  JWT secret, registry auths, RPC URLs with API keys), so anything that relays or logs it sees
  them. `fetchConfig` returns the config file as
  stored, also masking only `keys.privateKey`. Where that matters, edit the config file and
  restart the node instead ([runbook step 4](#4-turn-it-on)). `SERVICE_MODEL_CACHE_HF_TOKEN` is
  not part of the config and appears in neither.

## Operator runbook

For a containerized node such as cp1, run on the node host. `NODE` is the node container's name;
the cache goes to `/data/ocean-model-cache-v1`. A node run directly on the host (npm, PM2) needs
no container steps: create the directory owned by the user the node runs as, and set
`serviceModelCache` in its config file.

### 1. Pre-checks (read-only)

```shell
NODE=ocean-node    # the node container's name, from docker ps

# This node image has the model cache (an older one would accept the config and ignore it).
docker exec "$NODE" ls /usr/src/app/dist/components/modelCache/manager.js

# The node runs as uid 1000; the cache directory must be writable by it.
docker exec "$NODE" id node
# uid=1000(node) gid=1000(node) groups=1000(node),...

# Mounts: /usr/src/app/databases must be a named volume or a bind, not anonymous.
docker inspect -f '{{range .Mounts}}{{.Type}} {{if .Name}}{{.Name}}{{else}}{{.Source}}{{end}} -> {{.Destination}} rw={{.RW}}{{"\n"}}{{end}}' "$NODE"

# Environment variable NAMES only: the environment holds PRIVATE_KEY.
docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$NODE" | cut -d= -f1 | sort

# The config file the node reads; no output means /usr/src/app/config.json.
docker exec "$NODE" printenv CONFIG_PATH

# The node finds its own container (by hostname, else by the ID in its mount table) to check
# the cache bind; it must be able to reach the Docker socket.
docker inspect -f '{{.Config.Hostname}} {{.Id}} {{.HostConfig.NetworkMode}}' "$NODE"

# The cache filesystem: local (ext4, xfs), not nfs or cifs, and its free space.
df -hT /data
```

### 2. Create the cache directory

A fresh, empty directory owned by uid 1000 — not the old bench cache. The node refuses a
non-empty directory it did not create, so nothing unmanaged ends up in a mount every service
gets:

```shell
sudo install -d -o 1000 -g 1000 -m 0755 /data/ocean-model-cache-v1
ls -A /data/ocean-model-cache-v1    # prints nothing
```

Use the host's real path (no symlink in it), and a directory of its own: not a filesystem root
(its `lost+found` makes it non-empty), not inside or around any node directory.

### 3. Persist the config file

Skip this if `CONFIG_PATH` already names a file on a persistent mount, in a directory the node
can write (see [Changing it with pushConfig](#changing-it-with-pushconfig)); if it names a file
that does not survive a recreate, copy that one instead.

```shell
docker exec -u node "$NODE" cp /usr/src/app/config.json /usr/src/app/databases/config.json
```

From the recreate in step 5 on, the node reads this copy, with the environment still applied on
top. When an upgrade changes the image's `config.json`, carry the change over by hand.

### 4. Turn it on

Either edit the copy now — the running node does not read it yet, so this takes effect at the
recreate:

```shell
docker exec -u node "$NODE" node -e '
const fs = require("fs")
const f = "/usr/src/app/databases/config.json"
const c = JSON.parse(fs.readFileSync(f, "utf8"))
c.serviceModelCache = {
  enabled: true, path: "/data/ocean-model-cache-v1", maxSizeGb: 1300, minFreeGb: 500
}
fs.writeFileSync(f, JSON.stringify(c, null, 4))
'
```

or, after step 5, [push](#changing-it-with-pushconfig) the same object — fetch, edit, push —
minding what the response exposes. An invalid `serviceModelCache` in the file stops the node at
boot (`Configuration validation failed`); a push is validated before it is written. Later
changes work the same way: edit the file and `docker restart "$NODE"`, or push.

### 5. Recreate the node container

Bind the cache directory at the **identical** path, read-write, and point `CONFIG_PATH` at the
copy. The path must be identical because the node checks the directory from inside its
container, while dockerd, which creates the service containers, resolves bind sources on the
host. The node finds its own container (by hostname, or by the container ID in its mount table)
to compare the two, and offers no mount when it cannot (see [Security notes](#security-notes)).
In compose:

```yaml
services:
  ocean-node:
    environment:
      CONFIG_PATH: /usr/src/app/databases/config.json
      # SERVICE_MODEL_CACHE_HF_TOKEN: hf_...   # optional, see Security notes
    volumes:
      - node-sqlite:/usr/src/app/databases
      - /var/run/docker.sock:/var/run/docker.sock
      - /data/ocean-model-cache-v1:/data/ocean-model-cache-v1
```

```shell
docker compose up -d ocean-node    # recreates the container with the new mount and environment
```

With `docker run`, add
`-v /data/ocean-model-cache-v1:/data/ocean-model-cache-v1 -e CONFIG_PATH=/usr/src/app/databases/config.json`.

### 6. Verify

```shell
# The first sync starts about two minutes after boot. Expect
# "published <repo>@<commit>" lines, "downloading: ..." every five minutes, and at the end
# "sync done: <n> wanted, <n> published, <x> GB on disk, <y> GB downloaded".
docker logs --since 15m "$NODE" 2>&1 | grep '\[modelCache\]'

# The node claimed the directory: .ocean-model-cache, private and public.
ls -A /data/ocean-model-cache-v1

# Per-model status, from the index:
python3 - <<'PY'
import json
i = json.load(open('/data/ocean-model-cache-v1/public/index.json'))
print('index version', i['version'], 'written', i['generatedAt'])
for repo, e in sorted(i['repos'].items()):
    for rev, w in sorted(e['wanted'].items()):
        print(f"{w['status']:16} {repo}@{rev}  missing {w['missingBytes'] / 1e9:.1f} GB  {w.get('error', '')}")
PY

# A service started after the first sync carries the read-only mount and the variable
# (grep keeps the output to that one variable; the rest of a service's env is the consumer's):
CID=$(docker ps -q --filter network=ocean-svc-<serviceId>)
docker inspect -f '{{range .Mounts}}{{if eq .Destination "/ocean/model-cache"}}{{.Source}} -> {{.Destination}} rw={{.RW}}{{end}}{{end}}' "$CID"
# /data/ocean-model-cache-v1/public -> /ocean/model-cache rw=false
docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$CID" | grep '^OCEAN_MODEL_CACHE='
# OCEAN_MODEL_CACHE=/ocean/model-cache
```

`docker logs` holds the node's log only when it logs to the console (the default); with
`LOG_FILES` or `LOG_DB` set and no `LOG_CONSOLE`, grep the log files under
`/usr/src/app/logs/` instead.

### Sizing

- `maxSizeGb: 1300` on cp1. Today's wanted set is about 1.04 TB; the ~260 GB above it is room
  for new templates and for updates, which download next to the commit they replace (an update
  that does not fit is deferred, and the old commit stays served).
- `minFreeGb: 500` on cp1: the cache never takes `/data` below 500 GB free, which protects
  everything else on that filesystem. A complete first fill therefore needs the wanted set plus
  `minFreeGb` free — about 1.54 TB, with the old bench cache still in place: check
  `df -h /data` before enabling.
- The cache stops at whichever limit it reaches first, so size the two together, with room for
  what is retired but not deleted yet: an updated model's old commit, or a model the templates
  dropped, stays on disk on top of `maxSizeGb` for at least `gcGraceHours`, and longer while a
  service started before the change is still live.
- After a template change, the `sync done` line (GB on disk) and the `missingBytes` of anything
  `skipped:budget` or `deferred:budget` show what the wanted set costs.

### Removing the old bench cache

Only after the first full sync — the last `sync done` line has no `not ready` list, or one that
holds nothing but `skipped:gated`, `skipped:private` or `skipped:disabled` — and only once no
running container mounts it. Whatever else the bench left in it (its `compile/` caches, say)
goes too: copy out what you want to keep first.

```shell
docker logs "$NODE" 2>&1 | grep '\[modelCache\] sync done' | tail -1
OLD=/data/ocean-model-cache    # the bench cache on cp1; never /data/ocean-model-cache-v1
ls -A "$OLD"                   # the bench's content; must not list .ocean-model-cache
# Running containers that mount it, or anything under it (prints nothing):
docker ps -q | xargs -r docker inspect -f '{{range .Mounts}}{{$.Name}} {{.Source}}{{"\n"}}{{end}}' |
  awk -v old="$OLD" '$2 == old || index($2, old "/") == 1'
sudo du -sh "$OLD"
[ -e "$OLD/.ocean-model-cache" ] || sudo rm -rf --one-file-system "$OLD"
```

### Turning it off

Push the object with `"enabled": false`, or set it in the config file and restart the node.
Services started or restarted from then on get no mount; running ones keep theirs until they
stop or restart. Nothing is deleted. To reclaim the space, remove the directory once no running
container mounts it any more:

```shell
docker ps -q | xargs -r docker inspect -f '{{range .Mounts}}{{if eq .Destination "/ocean/model-cache"}}{{$.Name}}{{"\n"}}{{end}}{{end}}'   # prints nothing
sudo rm -rf --one-file-system /data/ocean-model-cache-v1
```

## Troubleshooting

There is no API for the cache's state: its log lines (prefix `[modelCache]`) and `index.json`
are the status. The summary at the end of each sync — `sync done: <n> wanted, <n> published,
<x> GB on disk, <y> GB downloaded`, followed by `not ready: <statuses>` and
`paused at the disk floor (minFreeGb)` when they apply — and the `wanted` statuses in
`index.json` say what is missing; the lines below say why. `published`, `retired`, `deleted`,
`freed` and `no longer wanted` lines are routine.

| Log line | Cause and fix |
| --- | --- |
| `serviceModelCache.path ... does not exist`, `... is not a directory` | Missing inside the node container: create it on the host and bind it at the identical path. |
| `... is not writable by the node (uid 1000)` | Ownership: `sudo chown 1000:1000 <path>`. |
| `... is not empty and is not a model cache this node created (no valid .ocean-model-cache)` | The directory had content before the node claimed it, or the sentinel was removed; a filesystem root's `lost+found` counts. Point `path` at a new, empty directory, and do not copy an old cache into it. |
| `... is not bound into the node container at the same host path (read-write); dockerd could not mount it into services` | Bind it as `-v <path>:<path>`: read-write, identical on both sides, the host's real path. |
| `... is on a network filesystem; it must be local disk` | NFS, CIFS and SMB2 are refused. Use local disk; other network or FUSE filesystems are not detected, but are no better. |
| `cannot inspect the node container to check the cache path: cannot find the node container on the Docker daemon` | The node could find its container neither by hostname nor by the ID in its mount table (unusual runtimes). No mount is offered until it can. |
| `SERVICE_MODEL_CACHE_HF_TOKEN is malformed; ignored` | The token holds whitespace or control characters (a pasted multi-line value). Set it again as one line; until then the cache runs anonymously. |
| `... overlaps <dir>; use a dedicated directory (it is mounted into every service)` | The path is, contains or sits inside a node directory: the working directory, `databases/`, the config file's directory, the home directory, `serviceTemplatesPath`, the persistent storage folder, the C2D storage, or the TLS certificate and key directories. |
| `cannot inspect the node container to check the cache path: ...` | The node cannot ask dockerd about its own container; the sync stops and no mount is offered. |
| `dockerd rejected the cache mount (...)`, and from the docker engine `service <id>: container create failed with the model cache mount (...); retrying without it` | The service was created without the mount, and the mount is withheld until the next successful sync. If the retry failed too, the cause was not the mount. Otherwise dockerd could not bind the directory on the host, usually because the path differs there: for example a bind that changed after the last check. |
| `free space would drop below minFreeGb (... GB); pausing downloads` | Free space on the filesystem, or lower `minFreeGb` or `maxSizeGb`. Downloads resume at the next sync. |
| `<repo>@<commit>: deferred:budget (maxSizeGb ... reached)` | An update does not fit next to the commit still served, which stays served. Raise `maxSizeGb`, or narrow or drop less important models. |
| `<repo>@<commit>: skipped:budget (maxSizeGb ... reached)` | Does not fit at all; if it was cached before, it is being retired. Same fixes. |
| `templates loaded with problems (...); keeping the previous template models`, then `templates did not load cleanly; nothing is retired this run` | [Frozen templates](#sync-behaviour): nothing is retired or deleted until the templates load cleanly again. Fix them, or set `fromTemplates: false` to drop template models on purpose. |
| `... is being synced by another process; skipping this run` | Another node process, typically an old container, holds `private/sync.lock`. Clears when it exits; a stale lock is taken over after ten minutes. |
| `<repo>@<rev>: unauthorized (gated or private)`, `... not found`, `... rate limited`, `... HTTP <status>` | Hub API errors (status `error`); a commit published earlier stays served. For rate limits, set `SERVICE_MODEL_CACHE_HF_TOKEN`. |
| `<repo>@<rev>: the selection matches no file of the repo`, `<repo>@<commit>: not in the repo: ...` | A curated `allowPatterns` or `files` entry, or a template URL, names nothing (or, in the second line, some files) that the repo has at that commit. |
| `<repo>: ignoring N file(s) with unusable names or hashes; the snapshot will not count as complete` | The Hub listed files whose names or hashes fail validation; the rest is cached, and `complete` stays `false`. |
| `<repo>@<commit>: N file(s) failed, first: ...` | Download errors (HTTP, hash mismatch); retried at the next sync. |
| `template:<id>: skipped unsupported model URL ...` | A workflow URL not of the supported form (short sha, `blob/` link, PR ref, ...). |
| `cannot list services (...); deleting nothing` | The liveness check could not read the service list, so nothing retired is deleted this sync. |
| `cannot save state: ...` | `state.json` or `index.json` could not be written (disk full, ownership). |
| `sync failed: ...` | Any other error ended the sync; the next one runs after `syncIntervalMinutes`. |
| `config key "<key>" is ignored; did you mean serviceModelCache?` | A misspelled top-level key, logged at boot. Unknown top-level keys pass validation, so a push with one is accepted and does nothing. |

**A service has no mount.** It was created before the first successful sync, while the cache
was off, or while one of the checks above was failing; the mount is decided when the container
is created. Restart the service once the log shows a clean sync. `skipped:gated`,
`skipped:private` and `skipped:disabled` are by design (see [What goes in it](#what-goes-in-it)).

## Security notes

- **What every tenant can read:** all of `public/` — the weights, and `index.json` with every
  repo id the node wants (skipped ones included), commits, file names, sizes, statuses and error
  messages. It is all public Hugging Face content, so a tenant gains nothing they could not
  download, but they can see which models the node holds. Do not curate repo names you consider
  confidential.
- **Read-only, fixed and node-managed.** Source, target and mode come only from the node:
  nothing in a template, `userData` or a request can add, move or widen the mount, and a
  user-supplied `OCEAN_MODEL_CACHE` is dropped.
- **Integrity against bucket symlinks.** The node's bucket code follows symlinks a tenant
  plants in a bucket (a separate, pre-existing bug to fix in persistent storage). Through that,
  node code could write into or create files under the cache directory. The cache defends
  itself: every file it publishes is read-only, so writing through a path fails (the node runs
  as uid 1000, not root), and it records the inode of every blob it installs, so a file created
  at a blob path by anything else is never trusted, linked or published; it is replaced by a
  verified download. A node run as root loses the first defence: do not.
- **Gated, private and disabled repos are never downloaded**, whatever the token can read. A
  repo that was public when cached and later answers `401` or `404` stays served while wanted
  (see [What goes in it](#what-goes-in-it)).
- **The token**, `SERVICE_MODEL_CACHE_HF_TOKEN`, comes from the environment only: it is never in
  the config (so `fetchConfig` and `pushConfig` never return it) and never written to disk. It is
  sent only to `huggingface.co`, never to the CDN downloads redirect to, and only lifts anonymous
  rate limits. Use a fine-grained, read-only token with no access to gated or private
  repositories: it needs none.
- **`private/` is never mounted:** state, lock, partial downloads and trash stay with the node,
  as does the sentinel.
- **Non-recursive bind.** The mount is `NonRecursive`, so a filesystem mounted somewhere under
  the cache directory on the host is not carried into services.
- **The same-path check guards the mount source.** dockerd mounts whatever the host has at
  `<path>/public`. At boot and at every sync the node finds its own container (by hostname, or
  by the container ID in its mount table) and checks that this host path is the directory it
  verified. If it cannot find its container, the check fails and no mount is offered.
- **What reaches the disk is checked.** Repo ids, revisions and file paths from templates,
  config and the Hub API are validated before they become paths, and every filesystem operation
  is confined to the cache root. Downloads follow redirects only to Hugging Face hosts over
  HTTPS, and every file is verified against the hash the Hub lists for its commit before it is
  published. Signed CDN URLs are never logged, and `index.json` carries no host paths.
- **Node data stays out.** The node refuses a directory on a network filesystem, a non-empty one
  it did not create, and any that overlaps its own data (the `overlaps` line in
  [Troubleshooting](#troubleshooting) lists them), so nothing of the node's can end up in a
  mount every service gets.
