#!/usr/bin/env bash
#
# Upload an ocean-node telemetry dashboard to a running Grafana via the HTTP API.
#
# Only needed when you are NOT using file provisioning (the local docker-compose stack already
# provisions both dashboards on boot). Use this for Grafana Cloud or an existing shared Grafana.
#
#   GRAFANA_URL=https://your-org.grafana.net \
#   GRAFANA_TOKEN=glsa_xxx \
#   PROM_NAME=Prometheus \
#   ./deploy/telemetry/scripts/import-dashboard.sh [p2p|compute]
#
# Minting a token: Grafana -> Administration -> Users and access -> Service accounts ->
# Add service account -> role "Editor" -> Add service account token. Copy it into GRAFANA_TOKEN.
#
# Datasource resolution (the dashboards declare a DS_PROMETHEUS variable that must be pinned to a
# real Prometheus datasource uid). This does NOT blindly take the first Prometheus-type datasource
# — a Grafana with several (mon.oceanprotocol.io has 7) would then get the wrong one and the
# dashboard's variables resolve empty, so every panel shows "No data". Precedence:
#     1. PROM_UID     — explicit uid, used verbatim.
#     2. PROM_NAME    — exact datasource name (case-insensitive); must match exactly one.
#     3. the default  — the single Prometheus datasource marked isDefault.
#     4. the only one — if the Grafana has exactly one Prometheus datasource.
#     5. otherwise    — fail loudly, listing candidates. No silent guessing.
#
# Optional:
#   GRAFANA_FOLDER_UID   target folder (default: the "General" folder)
#   DASHBOARD_FILE       path to the dashboard JSON (overrides the p2p|compute shorthand)

set -euo pipefail

cd "$(dirname "$0")/../../.."

WHICH="${1:-p2p}"
case "$WHICH" in
  p2p)     DEFAULT_FILE="deploy/telemetry/grafana/dashboards/ocean-node-p2p.json" ;;
  compute) DEFAULT_FILE="deploy/telemetry/grafana/dashboards/ocean-node-compute.json" ;;
  *)       DEFAULT_FILE="$WHICH" ;;  # allow passing a path directly
esac

# Exported, not just assigned: the final `node -e` block reads it from `process.env`.
# Strip any trailing slash so composed URLs don't end up with a `//`.
export GRAFANA_URL="${GRAFANA_URL:-http://localhost:3001}"
GRAFANA_URL="${GRAFANA_URL%/}"
DASHBOARD_FILE="${DASHBOARD_FILE:-$DEFAULT_FILE}"

if [ ! -f "$DASHBOARD_FILE" ]; then
  echo "dashboard JSON not found: $DASHBOARD_FILE" >&2
  echo "usage: $0 [p2p|compute|<path-to-dashboard.json>]" >&2
  exit 1
fi

if [ -z "${GRAFANA_TOKEN:-}" ]; then
  echo "GRAFANA_TOKEN is required (service-account token with Editor rights)." >&2
  echo "See the header of this script for how to mint one." >&2
  exit 1
fi

# Resolve the Prometheus datasource uid for the DS_PROMETHEUS variable (see the header).
PROM_UID="${PROM_UID:-}"
if [ -z "$PROM_UID" ]; then
  # The resolver is written to a temp file (rather than `node -e '...'`) so its template
  # literals and single quotes are not mangled by the shell.
  RESOLVER="$(mktemp -t import-dashboard-resolver.XXXXXX.js)"
  trap 'rm -f "$RESOLVER"' EXIT
  cat >"$RESOLVER" <<'RESOLVER_JS'
let s = ''
process.stdin.on('data', (d) => (s += d)).on('end', () => {
  let list
  try {
    list = JSON.parse(s)
  } catch {
    console.error('Could not parse the /api/datasources response from Grafana.')
    process.exit(1)
  }
  const proms = (Array.isArray(list) ? list : []).filter((d) => d.type === 'prometheus')
  const fmt = (ds) =>
    ds
      .map((d) => `    - ${d.name}  (uid=${d.uid})${d.isDefault ? '  [default]' : ''}`)
      .join('\n')

  if (proms.length === 0) {
    console.error('No Prometheus-type datasource found on this Grafana. Add one, or set PROM_UID.')
    process.exit(1)
  }

  const name = (process.env.PROM_NAME || '').trim()
  if (name) {
    const byName = proms.filter((d) => String(d.name).toLowerCase() === name.toLowerCase())
    if (byName.length === 1) return void console.log(byName[0].uid)
    if (byName.length === 0) {
      console.error(`PROM_NAME="${name}" matched no Prometheus datasource. Candidates:\n${fmt(proms)}`)
      process.exit(1)
    }
    console.error(`PROM_NAME="${name}" is not unique (${byName.length} matches). Set PROM_UID:\n${fmt(byName)}`)
    process.exit(1)
  }

  const defaults = proms.filter((d) => d.isDefault === true)
  if (defaults.length === 1) return void console.log(defaults[0].uid)
  if (defaults.length > 1) {
    console.error(`Multiple Prometheus datasources are marked default. Set PROM_NAME or PROM_UID:\n${fmt(defaults)}`)
    process.exit(1)
  }

  if (proms.length === 1) return void console.log(proms[0].uid)

  console.error(
    `This Grafana has ${proms.length} Prometheus datasources and none is marked default.\n` +
      `Refusing to guess (that is the bug this avoids). Set PROM_NAME=<name> or PROM_UID=<uid>:\n` +
      fmt(proms)
  )
  process.exit(1)
})
RESOLVER_JS

  DATASOURCES="$(curl -fsS -H "Authorization: Bearer $GRAFANA_TOKEN" "$GRAFANA_URL/api/datasources")"
  PROM_UID="$(printf '%s' "$DATASOURCES" | PROM_NAME="${PROM_NAME:-}" node "$RESOLVER")" || {
    echo "Could not resolve a Prometheus datasource (see the message above)." >&2
    exit 1
  }
fi

if [ -z "$PROM_UID" ]; then
  echo "No Prometheus datasource uid resolved on $GRAFANA_URL — set PROM_NAME or PROM_UID." >&2
  exit 1
fi

echo "Importing $DASHBOARD_FILE -> $GRAFANA_URL"
echo "  Prometheus datasource: $PROM_UID"

PAYLOAD=$(
  DASHBOARD_FILE="$DASHBOARD_FILE" \
  PROM_UID="$PROM_UID" \
  FOLDER_UID="${GRAFANA_FOLDER_UID:-}" \
  node -e '
    const fs = require("fs")
    const dashboard = JSON.parse(fs.readFileSync(process.env.DASHBOARD_FILE, "utf8"))
    // Strip the id so Grafana creates or updates by uid rather than rejecting a stale id.
    dashboard.id = null
    const inputs = [
      { name: "DS_PROMETHEUS", type: "datasource", pluginId: "prometheus", value: process.env.PROM_UID }
    ]
    const body = { dashboard, overwrite: true, inputs }
    if (process.env.FOLDER_UID) body.folderUid = process.env.FOLDER_UID
    process.stdout.write(JSON.stringify(body))
  '
)

RESPONSE=$(
  curl -fsS -X POST "$GRAFANA_URL/api/dashboards/import" \
    -H "Authorization: Bearer $GRAFANA_TOKEN" \
    -H 'Content-Type: application/json' \
    -d "$PAYLOAD"
)

echo "$RESPONSE" | node -e '
  let s = ""
  process.stdin.on("data", (d) => (s += d)).on("end", () => {
    try {
      const j = JSON.parse(s)
      console.log(`\nImported: ${j.title ?? "dashboard"}`)
      console.log(`URL: ${process.env.GRAFANA_URL}${j.importedUrl ?? ""}`)
    } catch {
      console.log(s)
    }
  })
'
