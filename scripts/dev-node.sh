#!/usr/bin/env bash
# The dev box as a real node (PRD-02 T12). `ezpug-node` enrolled against the
# dev orchestrator, dialling `/node`, holding the CS2 image `pnpm cs2:build`
# wrote — so a `requirements.lan` request on this box lands on real hardware
# through the same enrolment flow a venue uses, and nothing about the path is
# simulated except the venue.
#
#   ./scripts/dev-node.sh up      enrol (once) and run the agent in the background
#   ./scripts/dev-node.sh down    stop the agent (its containers keep running)
#   ./scripts/dev-node.sh status  what the agent thinks it is and what docker says
#   ./scripts/dev-node.sh logs    follow the agent's log
#   ./scripts/dev-node.sh forget  un-enrol here and at the orchestrator
#   ./scripts/dev-node.sh auto    what `pnpm dev:up` calls: `up`, or a reason it did not
#
# It needs two things `pnpm dev:up` cannot give it: the orchestrator has to be
# running (`pnpm dev`), and `EZPUG_IRON_PROVIDERS` has to name `nodes`. The
# second is opt-in on purpose — registering a real provider takes the sim out
# of selection for every request that did not ask for it (`providers/selection.ts`),
# which is exactly right for a venue and wrong for an offline afternoon.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

log() { printf '\033[36m[dev-node]\033[0m %s\n' "$*"; }
die() { printf '\033[31m[dev-node] error:\033[0m %s\n' "$*" >&2; exit 1; }

get_env() {
  node --env-file-if-exists=.env -e "process.stdout.write(process.env['$1'] ?? '$2')"
}

BASE_URL="$(get_env EZPUG_IRON_BASE_URL "$(get_env EZPUG_IRON_PUBLIC_URL http://127.0.0.1:3430)")"
# Absolute, always: the agent runs with its own package as the working
# directory, so a relative state dir would put the identity under `apps/node/`
# while this script looked for it at the root — and a second `up` would try to
# enrol a host that is already enrolled (found in T13).
STATE_DIR="$(get_env EZPUG_NODE_STATE_DIR "$ROOT/.ezpug-node")"
[[ "$STATE_DIR" = /* ]] || STATE_DIR="$ROOT/$STATE_DIR"
PROVIDERS="$(get_env EZPUG_IRON_PROVIDERS sim)"
NODE_ID="$(get_env EZPUG_IRON_DEV_NODE_ID devbox)"
REGION="$(get_env EZPUG_NODE_REGION saarland)"
WARM="$(get_env EZPUG_NODE_WARM 0)"
KEY_FILE="$STATE_DIR/dev-key"
LOG_FILE="$STATE_DIR/agent.log"
PID_FILE="$STATE_DIR/agent.pid"

# A checkout's .env predates the agent's variables more often than not, and
# this script already knows every answer: give the agent the environment it
# needs rather than making an operator edit a file to run one command.
# `get_env` reads the process environment first, so anything already set wins.
export EZPUG_NODE_ORCHESTRATOR_URL="$BASE_URL"
export EZPUG_NODE_STATE_DIR="$STATE_DIR"
export EZPUG_NODE_REGION="$REGION"
# Zero by default: a warm container on this box is a real CS2 server and the
# 67 GB game volume it needs. `EZPUG_NODE_WARM=1 pnpm dev:node up` asks for one.
export EZPUG_NODE_WARM="$WARM"

reachable() { curl -fsS --max-time 3 "$BASE_URL/healthz" >/dev/null 2>&1; }
enabled() { [[ ",$PROVIDERS," == *,nodes,* ]]; }
running() { [[ -f "$PID_FILE" ]] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; }

# One key for the dev node, minted once and kept 0600 beside the identity. It
# is a dev convenience and lives where the node token already lives; nothing
# here ever prints it.
#
# The name carries the moment it was minted because a key's name is unique
# **while it lives** and this script holds no `admin` scope, so it cannot
# revoke one: `forget` deletes the secret here and the key at the orchestrator
# outlives it, unusable. Minting under a fresh name is what lets a second
# `up` work at all (found on this box in T13, where the first one did not).
dev_key() {
  if [[ -s "$KEY_FILE" ]]; then cat "$KEY_FILE"; return; fi
  mkdir -p "$STATE_DIR"
  chmod 700 "$STATE_DIR"
  local secret
  secret="$(pnpm --silent --filter @ezpug/orchestrator keys:mint -- \
    --name "dev-node-$NODE_ID-$(date +%s)" --scopes fleet,matches 2>/dev/null | tail -n 1)"
  [[ "$secret" == ezik_* ]] || die 'could not mint a dev key (is the dev database up? `pnpm dev:up`)'
  printf '%s' "$secret" > "$KEY_FILE"
  chmod 600 "$KEY_FILE"
  printf '%s' "$secret"
}

api() {
  local method="$1" path="$2" body="${3:-}"
  local args=(-fsS -X "$method" -H "Authorization: Bearer $(dev_key)" "$BASE_URL$path")
  [[ -n "$body" ]] && args+=(-H 'Content-Type: application/json' -d "$body")
  curl "${args[@]}"
}

cmd_up() {
  enabled || die "EZPUG_IRON_PROVIDERS is \"$PROVIDERS\"; add \`nodes\` in .env and restart \`pnpm dev\`"
  reachable || die "no orchestrator at $BASE_URL — run \`pnpm dev\` first"
  running && { log "already running (pid $(cat "$PID_FILE"))"; return; }

  if [[ ! -s "$STATE_DIR/node.json" ]]; then
    log "enrolling \"$NODE_ID\" in $REGION…"
    local token
    token="$(api POST /v1/fleet/nodes \
      "{\"id\":\"$NODE_ID\",\"region\":\"$REGION\",\"labels\":{\"venue\":\"devbox\",\"address\":\"127.0.0.1\"}}" \
      | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>process.stdout.write(JSON.parse(s).token))')"
    [[ -n "$token" ]] || die 'the orchestrator returned no enrolment token'
    # The token crosses one pipe and is never written anywhere but the agent's
    # own 0600 identity file, which is what `enrol` writes.
    pnpm --silent node enrol "$token" >/dev/null
    log 'enrolled; the one-time token is spent'
  fi

  mkdir -p "$STATE_DIR"
  : > "$LOG_FILE"
  pnpm --silent node run >>"$LOG_FILE" 2>&1 &
  echo $! > "$PID_FILE"
  log "agent running (pid $(cat "$PID_FILE")); \`pnpm dev:node logs\` follows it"
}

cmd_down() {
  running || { log 'not running'; rm -f "$PID_FILE"; return; }
  local pid
  pid="$(cat "$PID_FILE")"
  kill "$pid" 2>/dev/null || true
  for _ in $(seq 1 20); do kill -0 "$pid" 2>/dev/null || break; sleep 0.2; done
  rm -f "$PID_FILE"
  log 'agent stopped (its containers keep running — the orchestrator still owns them)'
}

cmd_forget() {
  cmd_down
  if reachable && [[ -s "$KEY_FILE" ]]; then
    api DELETE "/v1/fleet/nodes/$NODE_ID" >/dev/null 2>&1 || true
    log "revoked \"$NODE_ID\" at the orchestrator"
  fi
  pnpm --silent node forget >/dev/null 2>&1 || true
  rm -f "$KEY_FILE"
  log 'forgotten here too'
}

cmd_status() {
  enabled || log "EZPUG_IRON_PROVIDERS is \"$PROVIDERS\" — the orchestrator has no \`nodes\` provider"
  running && log "agent pid $(cat "$PID_FILE")" || log 'agent not running'
  pnpm --silent node status || true
}

cmd_logs() { [[ -f "$LOG_FILE" ]] || die "no log yet ($LOG_FILE)"; tail -f "$LOG_FILE"; }

# `pnpm dev:up`'s call: never fatal, always says why it did nothing.
cmd_auto() {
  enabled || { log "skipped: EZPUG_IRON_PROVIDERS is \"$PROVIDERS\" (add \`nodes\` to run this box as one)"; return 0; }
  reachable || { log "skipped: no orchestrator at $BASE_URL yet — run \`pnpm dev\`, then \`pnpm dev:node up\`"; return 0; }
  cmd_up || log 'the node did not start; `pnpm dev:node up` says why'
}

case "${1:-up}" in
  up) cmd_up ;;
  down) cmd_down ;;
  forget) cmd_forget ;;
  status) cmd_status ;;
  logs) cmd_logs ;;
  auto) cmd_auto ;;
  *) die "unknown command \"$1\" (up|down|forget|status|logs|auto)" ;;
esac
