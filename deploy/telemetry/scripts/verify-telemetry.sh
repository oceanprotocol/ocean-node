#!/usr/bin/env bash
#
# End-to-end telemetry check for ocean-node: brings up the local collector/Prometheus/Tempo/
# Grafana stack, and — if the environment is already configured to run a node (PRIVATE_KEY set,
# etc., per docs/env.md) — starts one with telemetry enabled and asserts that P2P metrics land in
# Prometheus and the dashboards are provisioned.
#
#   ./deploy/telemetry/scripts/verify-telemetry.sh
#
# Exits non-zero with a summary if any check fails. Safe to re-run; it cleans up what it starts.
#
# Flags:
#   --keep    leave the stack (and the node, if started) running afterwards
#   --no-up   assume the stack is already running
#   --no-node don't attempt to start a node — just verify the stack + provisioning
#
# Starting a real ocean-node requires a working node config (PRIVATE_KEY, RPCS, etc. — see
# docs/env.md). This script does not fabricate one: if PRIVATE_KEY isn't already set in the
# environment, it verifies the telemetry stack only and tells you how to drive traffic yourself.

set -uo pipefail

# Guarded: with `set -uo pipefail` (no -e) a failed cd would silently run every check against the
# caller's directory.
cd "$(dirname "$0")/../../.." || { echo "cannot cd to repo root" >&2; exit 2; }

COMPOSE_FILE="deploy/telemetry/docker-compose.telemetry.yml"
PROM_URL="${PROM_URL:-http://localhost:9090}"
TEMPO_URL="${TEMPO_URL:-http://localhost:3200}"
GRAFANA_URL="${GRAFANA_URL:-http://localhost:3001}"

KEEP=0
DO_UP=1
DO_NODE=1
for arg in "$@"; do
  case "$arg" in
    --keep) KEEP=1 ;;
    --no-up) DO_UP=0 ;;
    --no-node) DO_NODE=0 ;;
    *) echo "unknown flag: $arg" >&2; exit 2 ;;
  esac
done

PASS=0
FAIL=0
RESULTS=()

ok()   { PASS=$((PASS+1)); RESULTS+=("  PASS  $1"); printf '  \033[32mPASS\033[0m  %s\n' "$1"; }
bad()  { FAIL=$((FAIL+1)); RESULTS+=("  FAIL  $1"); printf '  \033[31mFAIL\033[0m  %s\n' "$1"; }
step() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }

BUILD_LOG=$(mktemp -t ocean-node-build.XXXXXX)
SERVER_LOG=$(mktemp -t ocean-node-server.XXXXXX)

SERVER_PID=""
cleanup() {
  rm -f "$BUILD_LOG" "$SERVER_LOG"
  if [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  if [ "$KEEP" -eq 0 ] && [ "$DO_UP" -eq 1 ]; then
    docker compose -f "$COMPOSE_FILE" down -v >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

need() { command -v "$1" >/dev/null 2>&1 || { echo "missing required command: $1" >&2; exit 2; }; }
need curl
need docker
need node

# ── 1. stack ────────────────────────────────────────────────────────────────────────────────
if [ "$DO_UP" -eq 1 ]; then
  step "Starting telemetry stack"
  docker compose -f "$COMPOSE_FILE" up -d
fi

wait_for() { # url, label, attempts
  local url="$1" label="$2" tries="${3:-60}"
  for _ in $(seq 1 "$tries"); do
    if curl -fsS -o /dev/null "$url" 2>/dev/null; then ok "$label is up"; return 0; fi
    sleep 2
  done
  bad "$label did not become ready at $url"
  return 1
}

step "Waiting for backends"
wait_for "$PROM_URL/-/ready" "Prometheus"
wait_for "$TEMPO_URL/ready" "Tempo"
wait_for "$GRAFANA_URL/api/health" "Grafana"

# ── 2. dashboards provisioned ───────────────────────────────────────────────────────────────
step "Checking Grafana provisioning"
if curl -fsS "$GRAFANA_URL/api/dashboards/uid/ocean-node-p2p" >/dev/null 2>&1; then
  ok 'dashboard ocean-node-p2p is provisioned'
else
  bad 'dashboard ocean-node-p2p was not found in Grafana'
fi
if curl -fsS "$GRAFANA_URL/api/dashboards/uid/ocean-node-compute" >/dev/null 2>&1; then
  ok 'dashboard ocean-node-compute is provisioned'
else
  bad 'dashboard ocean-node-compute was not found in Grafana'
fi

# ── 3. build + run a node (best-effort — needs a real node config) ─────────────────────────
if [ "$DO_NODE" -eq 1 ] && [ -n "${PRIVATE_KEY:-}" ]; then
  step "Building ocean-node"
  if npm run build >"$BUILD_LOG" 2>&1; then
    ok "build succeeded"
  else
    bad "build failed:"
    tail -20 "$BUILD_LOG" >&2 || true
    exit 1
  fi

  step "Starting ocean-node with telemetry enabled"
  export OTEL_EXPORTER_OTLP_ENDPOINT="http://localhost:4318"
  export OTEL_SERVICE_NAME="${OTEL_SERVICE_NAME:-ocean-node}"
  export DEPLOYMENT_ENVIRONMENT=verify
  # Export fast so the script does not wait a full minute for the first metric flush.
  export OTEL_METRIC_EXPORT_INTERVAL=5000

  node --import ./dist/telemetry/otel.js dist/index.js >"$SERVER_LOG" 2>&1 &
  SERVER_PID=$!

  for _ in $(seq 1 45); do
    if ! kill -0 "$SERVER_PID" 2>/dev/null; then
      bad "node exited during startup — see log below"
      tail -30 "$SERVER_LOG" || true
      exit 1
    fi
    if grep -q '\[telemetry\] enabled' "$SERVER_LOG" 2>/dev/null; then break; fi
    sleep 2
  done

  if kill -0 "$SERVER_PID" 2>/dev/null; then
    ok "node is running (pid $SERVER_PID)"
  else
    bad "node is not running"
  fi

  if grep -q '\[telemetry\] enabled' "$SERVER_LOG" 2>/dev/null; then
    ok "telemetry reported itself enabled"
  else
    bad "no telemetry-enabled line seen in node output — telemetry did not start"
  fi

  step "Waiting for export (metric interval ${OTEL_METRIC_EXPORT_INTERVAL}ms + collector batch)"
  sleep 25

  step "Checking Prometheus"

  prom_value() { # promql -> scalar (empty when no series)
    curl -fsS --get "$PROM_URL/api/v1/query" --data-urlencode "query=$1" 2>/dev/null \
      | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);const r=j.data?.result??[];console.log(r.length?r[0].value[1]:"")}catch{console.log("")}})'
  }

  check_present() { # promql, label
    if [ -n "$(prom_value "$1")" ]; then
      ok "$2"
    else
      bad "$2 — no data for: $1"
    fi
  }

  check_present 'ocean_p2p_ready' 'ocean_p2p_ready is present'
  check_present 'ocean_p2p_connections' 'ocean_p2p_connections is present'
  check_present 'ocean_p2p_dht_routing_table_peers' 'ocean_p2p_dht_routing_table_peers is present'

  # Cardinality guard: peerId/did/jobId must never appear as metric labels.
  # A selector matches `<label>!=""` only on series that actually carry that label, so an
  # absent label yields no series (empty result) and a leaked one yields a count. (The old
  # `count by (<label>)(...)` grouped all series under a single empty-labeled group and so
  # returned a value even when the label was absent — a false positive.)
  for label in did jobId peerId consumerAddress; do
    if [ -z "$(prom_value "count({__name__=~\"ocean_.+\", $label!=\"\"})")" ]; then
      ok "$label is NOT a metric label (cardinality guard)"
    else
      bad "$label leaked onto a metric as a label"
    fi
  done
else
  step "Skipping node startup"
  if [ "$DO_NODE" -eq 0 ]; then
    echo "  (--no-node passed)"
  else
    echo "  PRIVATE_KEY is not set — this script does not fabricate a node config."
    echo "  Set up a node per docs/env.md, export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318,"
    echo "  and run 'npm start' yourself, then re-run with --no-up to check the resulting metrics."
  fi
fi

# ── summary ─────────────────────────────────────────────────────────────────────────────────
step "Summary"
printf '%s\n' "${RESULTS[@]}"
printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"

if [ "$KEEP" -eq 1 ]; then
  printf '\nStack left running. P2P dashboard: %s/d/ocean-node-p2p\n' "$GRAFANA_URL"
  printf 'Compute dashboard: %s/d/ocean-node-compute\n' "$GRAFANA_URL"
  printf 'Stop with: docker compose -f %s down -v\n' "$COMPOSE_FILE"
fi

[ "$FAIL" -eq 0 ]
