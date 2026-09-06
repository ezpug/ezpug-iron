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

# **Every agent this checkout owns, not the one pid a file remembers.** The pid
# file used to be the whole answer and it was wrong twice over: it holds the
# pid of the outer `pnpm`, two wrappers above the `tsx src/main.ts` that is the
# actual agent, so `down` could leave the agent running — and then the next
# `up` found a dead pid and started a second one on top of it. Two agents on
# one node identity replace each other's socket about once a second and never
# settle, while `status` read the winning socket and looked perfectly healthy
# (PRD-02 T21b, where it cost two runs).
#
# So discovery is by what is actually running. The scope is deliberately
# narrow: the agent runs with **its own package** as the working directory, and
# it is the only thing that ever runs there — `apps/orchestrator` executes a
# `src/main.ts` of its own and `/root/ezpug` executes two more, and none of
# them is ours to signal.
AGENT_DIR="$ROOT/apps/node"
agent_pids() {
  local pid dir
  for pid in $(pgrep -f "src/main\.ts run" 2>/dev/null || true); do
    dir="$(readlink "/proc/$pid/cwd" 2>/dev/null || true)"
    [[ "$dir" == "$AGENT_DIR" ]] || continue
    printf '%s\n' "$pid"
  done
}

# One agent started by this script is one process group (a `dash`, `tsx`'s
# launcher and the node that does the work), so groups are how `down` ends
# each of them whole and how `up` and `status` tell one agent from several.
# It is a floor, not a census — an agent started by hand through `npx` brings
# a launcher shell of its own — so nothing here ever prints the number, only
# whether it is more than one.
pgid_of() { ps -o pgid= -p "$1" 2>/dev/null | tr -d ' '; }
agent_groups() {
  local pid
  for pid in $(agent_pids); do pgid_of "$pid"; done | sort -u
}
many_agents() { [[ "$(agent_groups | grep -c . || true)" -gt 1 ]]; }
agent_list() { local pids; pids="$(agent_pids)"; printf '%s' "${pids//$'\n'/ }"; }
# Never `agent_pids | head -1`: `head` closes the pipe, the loop takes a
# SIGPIPE and `set -o pipefail` turns that into a silent exit of this script.
agent_first() { local pids; pids="$(agent_pids)"; printf '%s' "${pids%%$'\n'*}"; }
running() { [[ -n "$(agent_pids)" ]]; }

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
  # Adopt rather than duplicate: a live agent **is** the answer to `up`, and
  # the pid file is rewritten so `down` and `status` agree with reality even
  # when the agent outlived the script that started it.
  if running; then
    mkdir -p "$STATE_DIR"
    agent_first > "$PID_FILE"
    if many_agents; then
      log 'more than one agent is alive and they are fighting over one node identity — stopping all of them, then starting one'
      cmd_down
    else
      log "already running (pid $(agent_list)); \`pnpm dev:node down\` stops it"
      return
    fi
  fi

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
  # Its own process group, so `down` can end the whole `pnpm` → `pnpm` → `tsx`
  # chain with one signal instead of orphaning the agent under two wrappers.
  setsid pnpm --silent node run >>"$LOG_FILE" 2>&1 &
  local leader=$!
  echo "$leader" > "$PID_FILE"
  # The pid worth printing is the agent's, once it exists; the leader is a
  # `pnpm` that will be gone by the time anybody looks.
  local pid=''
  for _ in $(seq 1 50); do
    pid="$(agent_first)"
    [[ -n "$pid" ]] && break
    kill -0 "$leader" 2>/dev/null || break
    sleep 0.2
  done
  [[ -n "$pid" ]] || die "the agent did not start — see $LOG_FILE"
  log "agent running (pid $pid); \`pnpm dev:node logs\` follows it"
}

# Ends **every** agent this checkout owns, each one whole: an `up` from an
# older script, an agent left behind by a closed terminal and the one this
# script started all answer to the same signal, by process group, so no
# wrapper survives to be counted next time (T21b).
cmd_down() {
  local groups mine
  groups="$(agent_groups)"
  [[ -n "$groups" ]] || { log 'not running'; rm -f "$PID_FILE"; return; }
  mine="$(pgid_of "$$")"
  local group pid
  for group in $groups; do
    # Never signal our own group: an older `up` started its agent without
    # `setsid`, so it can share one with this very script.
    if [[ -n "$mine" && "$group" == "$mine" ]]; then
      for pid in $(agent_pids); do kill -TERM "$pid" 2>/dev/null || true; done
    else
      kill -TERM -- "-$group" 2>/dev/null || true
    fi
  done
  for _ in $(seq 1 40); do [[ -z "$(agent_pids)" ]] && break; sleep 0.2; done
  for pid in $(agent_pids); do kill -KILL "$pid" 2>/dev/null || true; done
  rm -f "$PID_FILE"
  log 'stopped every agent this checkout owns (their containers keep running — the orchestrator still owns them)'
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
  if ! running; then
    log 'agent not running'
  elif many_agents; then
    # The failure T21b cost two runs to find: two agents fight over one node
    # identity forever, and the socket that wins looks perfectly healthy — so
    # the count is the first thing this command says.
    printf '\033[31m[dev-node] more than one agent is running\033[0m (pid %s) — they are fighting over one node identity; run `pnpm dev:node down`, then `up`\n' \
      "$(agent_list)"
  else
    log "agent pid $(agent_list)"
  fi
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
