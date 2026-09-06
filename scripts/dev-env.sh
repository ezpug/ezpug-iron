#!/usr/bin/env bash
# The offline dev world (CLAUDE.md "Offline-first"): Postgres and Redis from
# compose.yaml, migrated, ready for `pnpm dev`. One command boots everything a
# fresh clone needs — no external service is involved, ever.
#
#   ./scripts/dev-env.sh up      boot (creates .env if missing), wait healthy, migrate,
#                                and run this box as a node when it is configured as one
#   ./scripts/dev-env.sh down    stop, keep the data
#   ./scripts/dev-env.sh reset   drop the volumes and boot a clean world (asks first)
#   ./scripts/dev-env.sh status  health + a real query against every service
#   ./scripts/dev-env.sh logs    follow the stack's logs
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

SERVICES=(postgres redis)

log() { printf '\033[36m[dev-env]\033[0m %s\n' "$*"; }
die() { printf '\033[31m[dev-env] error:\033[0m %s\n' "$*" >&2; exit 1; }

require_docker() {
  command -v docker >/dev/null 2>&1 || die 'docker is not installed'
  docker compose version >/dev/null 2>&1 || die 'docker compose v2 is required'
}

ensure_env_file() {
  if [[ ! -f .env ]]; then
    cp .env.example .env
    log 'created .env from .env.example (gitignored — edit it freely)'
  fi
}

get_env() {
  node --env-file-if-exists=.env -e "process.stdout.write(process.env['$1'] ?? '$2')"
}

# The container gets the parts (user/password/db/port), the orchestrator gets
# the URL. Drift between the two is a classic hour-long debugging session;
# warn loudly.
check_env_consistency() {
  node --env-file-if-exists=.env -e '
    const url = process.env.EZPUG_IRON_DATABASE_URL
    if (!url) process.exit(0)
    let parsed
    try { parsed = new URL(url) } catch { console.error("EZPUG_IRON_DATABASE_URL is not a URL"); process.exit(1) }
    const want = {
      port: process.env.EZPUG_IRON_POSTGRES_PORT,
      user: process.env.EZPUG_IRON_POSTGRES_USER,
      password: process.env.EZPUG_IRON_POSTGRES_PASSWORD,
      database: process.env.EZPUG_IRON_POSTGRES_DB,
    }
    const got = {
      port: parsed.port,
      user: decodeURIComponent(parsed.username),
      password: decodeURIComponent(parsed.password),
      database: parsed.pathname.slice(1),
    }
    const drift = Object.keys(want).filter(k => want[k] && want[k] !== got[k])
    if (drift.length)
      console.error(`EZPUG_IRON_DATABASE_URL disagrees with EZPUG_IRON_POSTGRES_* on: ${drift.join(", ")}`)
  ' || true
}

summary() {
  node --env-file-if-exists=.env -e '
    const e = process.env
    const rows = [
      ["postgres", e.EZPUG_IRON_DATABASE_URL ?? `postgres://127.0.0.1:${e.EZPUG_IRON_POSTGRES_PORT ?? 5443}`],
      ["postgres (test)", e.EZPUG_IRON_TEST_DATABASE_URL ?? "-"],
      ["redis", e.EZPUG_IRON_REDIS_URL ?? `redis://127.0.0.1:${e.EZPUG_IRON_REDIS_PORT ?? 6383}`],
      ["orchestrator", `${e.EZPUG_IRON_BASE_URL ?? "http://localhost:3430"} (run it: pnpm dev)`],
    ]
    const pad = Math.max(...rows.map(([k]) => k.length))
    for (const [k, v] of rows) console.log(`  ${k.padEnd(pad)}  ${v}`)
  '
}

migrate() {
  # Both databases, through the one code path the deploy script uses too.
  pnpm --silent --filter @ezpug/orchestrator db:migrate
  pnpm --silent --filter @ezpug/orchestrator db:migrate --target=test
}

cmd_up() {
  require_docker
  ensure_env_file
  check_env_consistency
  log 'booting Postgres and Redis…'
  docker compose up -d --wait "${SERVICES[@]}"
  log 'applying migrations to the dev and the test database…'
  migrate
  log 'dev world ready:'
  summary
  # This box as a node (T12), when the orchestrator is up and
  # `EZPUG_IRON_PROVIDERS` names `nodes`; a printed reason otherwise.
  ./scripts/dev-node.sh auto || true
}

cmd_down() {
  require_docker
  ./scripts/dev-node.sh down >/dev/null 2>&1 || true
  docker compose down
  log 'stopped (data volumes kept — use `reset` to wipe them)'
}

cmd_reset() {
  require_docker
  # Dropping a volume needs a human (CLAUDE.md "Verify"): this is that human's
  # command, and it says what it is about to do.
  read -r -p '[dev-env] drop the dev Postgres and Redis volumes and boot a clean world? [y/N] ' answer
  [[ "${answer:-}" =~ ^[Yy]$ ]] || die 'reset cancelled'
  log 'dropping data volumes…'
  docker compose down -v
  cmd_up
}

probe() {
  local name="$1" command="$2"
  if eval "$command" >/dev/null 2>&1; then
    printf '  \033[32mok\033[0m    %s\n' "$name"
  else
    printf '  \033[31mfail\033[0m  %s\n' "$name"
    return 1
  fi
}

cmd_status() {
  require_docker
  docker compose ps
  echo
  log 'probing services…'
  local pg_user pg_db base_url failed=0
  pg_user="$(get_env EZPUG_IRON_POSTGRES_USER ezpug_iron)"
  pg_db="$(get_env EZPUG_IRON_POSTGRES_DB ezpug_iron)"
  base_url="$(get_env EZPUG_IRON_BASE_URL http://localhost:3430)"
  probe postgres "docker compose exec -T postgres psql -U '$pg_user' -d '$pg_db' -tAc 'select 1'" || failed=1
  probe redis 'docker compose exec -T redis redis-cli ping' || failed=1
  # The orchestrator is a host process (`pnpm dev`); absent is not a failure
  # of the world, so it is reported and not counted.
  if curl -fsS "$base_url/healthz" >/dev/null 2>&1; then
    printf '  \033[32mok\033[0m    orchestrator (%s/healthz)\n' "$base_url"
  else
    printf '  \033[33m--\033[0m    orchestrator not running (start it with `pnpm dev`)\n'
  fi
  return "$failed"
}

case "${1:-up}" in
  up) cmd_up ;;
  down) cmd_down ;;
  reset) cmd_reset ;;
  status) cmd_status ;;
  logs) require_docker && docker compose logs -f ;;
  *) die "unknown command '$1' (up | down | reset | status | logs)" ;;
esac
