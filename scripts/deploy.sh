#!/usr/bin/env bash
# The deploy (PRD-02 T35; `ralph/DEPLOY.md` is the ops note that goes with it,
# `docs/operations.md` the reference around it).
#
#   ./scripts/deploy.sh            everything: preflight → build → backup →
#                                  migrate → up → routes → smoke
#   ./scripts/deploy.sh preflight  refuse early: tooling, env file, drift
#   ./scripts/deploy.sh build      build the image, keep the old one as
#                                  `:previous` (or pull the pinned tag)
#   ./scripts/deploy.sh backup     pg_dump now, rotate, list
#   ./scripts/deploy.sh migrate    back up first, then apply what is pending
#   ./scripts/deploy.sh up         start/replace the stack and wait healthy
#   ./scripts/deploy.sh routes     install docker/traefik/ezpug-iron.yml on the box
#   ./scripts/deploy.sh smoke      prove gs.ezpug.com answers
#   ./scripts/deploy.sh key [args] mint this deployment's FIRST API key, once
#   ./scripts/deploy.sh rollback   put `:previous` back and smoke it again
#
# Every step is idempotent: running the whole thing twice in a row changes
# nothing the second time (the build hits its cache, the migration finds
# nothing pending, compose leaves healthy containers alone, the route file is
# already byte-identical). That is the property that matters — a deploy you are
# afraid to re-run is a deploy you hesitate to run at all.
#
# What this script does NOT do is verify the code. `pnpm verify` and
# `pnpm verify:extended` are the gate and they run against the *dev* world;
# deploying is a separate act with separate failure modes. Run them first.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

ENV_FILE=.env.production
COMPOSE=(docker compose -f compose.prod.yaml --env-file "$ENV_FILE")
# The image this checkout builds. A `.env.production` naming
# EZPUG_IRON_IMAGE deploys a published tag instead and this name is never
# touched — see cmd_build.
IMAGE=ezpug-iron/orchestrator
ROUTE_SOURCE=docker/traefik/ezpug-iron.yml
ROUTE_TARGET=/opt/traefik/routes/ezpug-iron.yml
# Where the dumps land. On the host, outside the repo and outside the compose
# volumes — see the note on the `backup` service in compose.prod.yaml.
BACKUP_DIR_DEFAULT=/var/backups/ezpug-iron
# The docker bridge gateway. Compose publishes the orchestrator here and
# nowhere else, and Traefik — on this same box — is the only thing that can
# reach it. The smoke hits both sides: this address proves the container, the
# public URL proves the front door.
BRIDGE=172.17.0.1

step() { printf '\n\033[1m▸ %s\033[0m\n' "$*"; }
log() { printf '\033[36m[deploy]\033[0m %s\n' "$*"; }
warn() { printf '\033[33m[deploy] warning:\033[0m %s\n' "$*" >&2; }
die() { printf '\033[31m[deploy] error:\033[0m %s\n' "$*" >&2; exit 1; }

# Values come from the one file that holds them; nothing production-shaped is
# duplicated in here (gs.ezpug.com is configuration, never a literal).
env_value() {
  node --env-file-if-exists="$ENV_FILE" -e "process.stdout.write(process.env['$1'] ?? '')"
}

# Empty unless `.env.production` pins a published tag. Everything that would
# otherwise build, tag or rotate an image asks this first.
pinned_image() { env_value EZPUG_IRON_IMAGE; }

# ── preflight ──────────────────────────────────────────────────────────────
# Everything that can be known before a single container is touched. A deploy
# that fails here has changed nothing.
cmd_preflight() {
  command -v docker >/dev/null 2>&1 || die 'docker is not installed'
  docker compose version >/dev/null 2>&1 || die 'docker compose v2 is required'
  command -v curl >/dev/null 2>&1 || die 'curl is required for the smoke checks'
  [[ -f $ENV_FILE ]] \
    || die "$ENV_FILE is missing — cp .env.production.example $ENV_FILE and fill in the secrets"

  # Value lines only: the template's own prose says the word CHANGE_ME, and a
  # copied comment is not an unfilled secret.
  grep -Eq '^[[:space:]]*[A-Z_]+=.*CHANGE_ME' "$ENV_FILE" \
    && die "$ENV_FILE still holds CHANGE_ME placeholders — fill them in first"

  # The dev doors. Every one of these is refused by the process itself under
  # NODE_ENV=production, but finding that out from a crash loop is worse than
  # finding it out here, while nothing has been touched.
  local bypass
  bypass="$(grep -Eo '^[[:space:]]*(EZPUG_IRON_BOOTSTRAP_API_KEY|EZPUG_IRON_TRACE_FILE|EZPUG_IRON_CHAOS|EZPUG_IRON_STEAM_FAKE_TOKENS)' "$ENV_FILE" || true)"
  [[ -n $bypass ]] \
    && die "$ENV_FILE names a dev door ($(tr -d ' ' <<<"$bypass" | tr '\n' ' ')) — those belong to dev only"

  local node_env base host_port providers
  node_env="$(env_value NODE_ENV)"
  [[ $node_env == production ]] \
    || die "NODE_ENV in $ENV_FILE is '$node_env', not 'production' — every dev-door lock reads it"

  base="$(env_value EZPUG_IRON_PUBLIC_URL)"
  [[ $base == https://* ]] || die "EZPUG_IRON_PUBLIC_URL must be an https URL (got '$base')"

  # The two places a hostname and a port are written down are this env file and
  # the Traefik route file. They are allowed to change — together. Drift
  # between them is a 404 that reads like an outage, so it is caught here.
  host_port="$(env_value EZPUG_IRON_HOST_PORT)"
  host_port="${host_port:-3431}"
  grep -q "Host(\`${base#https://}\`)" "$ROUTE_SOURCE" \
    || die "$ROUTE_SOURCE does not route $base"
  grep -q "http://$BRIDGE:$host_port" "$ROUTE_SOURCE" \
    || die "$ROUTE_SOURCE does not point at the orchestrator port $host_port from $ENV_FILE"

  # The database and Redis are compose services with no host port, so a URL
  # naming this box is a URL that will never connect from inside the network.
  local database_url redis_url
  database_url="$(env_value EZPUG_IRON_DATABASE_URL)"
  redis_url="$(env_value EZPUG_IRON_REDIS_URL)"
  [[ $database_url == *@postgres:* ]] \
    || die "EZPUG_IRON_DATABASE_URL must name the compose service (postgres:5432), not a host address"
  [[ $redis_url == *//redis:* ]] \
    || die "EZPUG_IRON_REDIS_URL must name the compose service (redis:6379), not a host address"

  # Providers. `dathost` without its trio is a boot failure; saying so here
  # costs nothing and a crash loop costs a night.
  providers="$(env_value EZPUG_IRON_PROVIDERS)"
  [[ -n $providers ]] || die "EZPUG_IRON_PROVIDERS is empty in $ENV_FILE"
  if [[ ,$providers, == *,dathost,* ]]; then
    local missing=()
    [[ -n "$(env_value EZPUG_IRON_DATHOST_EMAIL)" ]] || missing+=(EZPUG_IRON_DATHOST_EMAIL)
    [[ -n "$(env_value EZPUG_IRON_DATHOST_PASSWORD)" ]] || missing+=(EZPUG_IRON_DATHOST_PASSWORD)
    [[ -n "$(env_value EZPUG_IRON_DATHOST_TEMPLATE_SERVER_ID)" ]] \
      || missing+=(EZPUG_IRON_DATHOST_TEMPLATE_SERVER_ID)
    [[ ${#missing[@]} -eq 0 ]] \
      || die "EZPUG_IRON_PROVIDERS names dathost but $ENV_FILE is missing ${missing[*]} — add them, or deploy with sim,nodes"
    [[ -n "$(env_value STEAM_WEB_API_KEY)$(env_value EZPUG_IRON_STEAM_WEB_API_KEY)" ]] \
      || warn 'dathost is registered but no STEAM_WEB_API_KEY is set: a rented server with no GSLT accepts LAN connections only'
  fi

  # The dumps are a bind mount, so the directory is the box's, not compose's.
  # Creating it here rather than letting docker do it keeps the failure ("that
  # path is a file", "that path is in the repo") in the step that changes
  # nothing.
  local backup_dir
  backup_dir="$(env_value EZPUG_IRON_BACKUP_DIR)"
  backup_dir="${backup_dir:-$BACKUP_DIR_DEFAULT}"
  [[ $backup_dir == /* ]] || die "EZPUG_IRON_BACKUP_DIR must be an absolute path (got '$backup_dir')"
  [[ $backup_dir == "$ROOT"/* ]] \
    && die "EZPUG_IRON_BACKUP_DIR ($backup_dir) is inside the repo — backups do not belong in a checkout"
  mkdir -p "$backup_dir" || die "cannot create the backup directory $backup_dir"
  [[ -w $backup_dir ]] || die "$backup_dir is not writable"

  if [[ -n "$(git status --porcelain 2>/dev/null)" ]]; then
    warn 'the working tree is dirty — the image will hold uncommitted code'
  fi

  local pinned
  pinned="$(pinned_image)"
  log "deploying ${pinned:-$(git_revision)} to $base (providers=$providers, dumps in $backup_dir)"
}

# Stamped into the image as an OCI label, so `:previous` can answer "previous
# to what?" months later. `-dirty` is part of the answer, not noise.
git_revision() {
  local sha dirty=''
  sha="$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
  [[ -n "$(git status --porcelain 2>/dev/null)" ]] && dirty='-dirty'
  printf '%s%s' "$sha" "$dirty"
}

image_id() { docker image inspect -f '{{.Id}}' "$1" 2>/dev/null || true; }

# Images built before the label existed answer "unlabelled" rather than an
# empty string — during a rollback, "→ nothing" reads like a broken command.
image_revision() {
  local revision
  revision="$(docker image inspect -f '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$1" 2>/dev/null || true)"
  [[ -z $revision || $revision == '<no value>' ]] && revision=unlabelled
  printf '%s' "$revision"
}

# ── build ──────────────────────────────────────────────────────────────────
# Two modes, and the env file picks. **Pinned**: EZPUG_IRON_IMAGE names a
# published tag (docs/pins.md) and this step pulls it — never builds, because a
# local build over a released tag is a lie about what is running, and rolling
# back is bumping that line. **From source** (the default): build this
# checkout, and whatever `:latest` pointed at before becomes `:previous` — but
# only if the build actually produced a different revision, so re-running a
# deploy does not quietly throw away the last real version.
cmd_build() {
  local pinned
  pinned="$(pinned_image)"
  if [[ -n $pinned ]]; then
    log "EZPUG_IRON_IMAGE pins $pinned — pulling, not building"
    docker pull "$pinned"
    return 0
  fi

  local before_id before_rev
  before_id="$(image_id "$IMAGE:latest")"
  before_rev="$(image_revision "$IMAGE:latest")"

  EZPUG_GIT_SHA="$(git_revision)" "${COMPOSE[@]}" build orchestrator

  # What moves `:previous` is a change of *revision*, not of image id: a
  # rebuild of the same commit can produce a new id for nothing, and letting
  # that rotate the rollback target would leave `:previous` holding the release
  # it is supposed to be the way back from.
  if [[ -n $before_id && $before_rev != "$(image_revision "$IMAGE:latest")" ]]; then
    docker image tag "$before_id" "$IMAGE:previous"
    log "$IMAGE:previous now holds $before_rev"
  fi
}

# ── backup ─────────────────────────────────────────────────────────────────
# A dump, rotated, listed. It is its own verb because a human wants one before
# touching anything, and it is what `migrate` runs first for the same reason.
# `run --rm` rather than `exec`, so it works whether or not the stack is up.
#
# The file it writes holds every webhook secret and every GSLT login token this
# database keeps in clear: it is written 0600 into a directory outside the
# checkout, and it belongs in the same drawer as a credential.
cmd_backup() {
  "${COMPOSE[@]}" --profile tools run --rm backup
}

# ── migrate ────────────────────────────────────────────────────────────────
# Compose already orders this (`service_completed_successfully`), so running it
# here is not what makes it safe — it is what makes it *legible*: a dump, then
# the migration as its own step with its own exit code, before any running
# container is replaced. A failure leaves the old stack serving.
#
# Migrations are additive-safe by rule (CLAUDE.md), so the dump is not a plan
# for undoing one; it is the answer to the failure additivity does not cover —
# a migration that dies halfway through the data it is rewriting.
cmd_migrate() {
  "${COMPOSE[@]}" up -d --wait postgres redis
  cmd_backup
  "${COMPOSE[@]}" run --rm migrate
}

cmd_up() {
  # Compose re-runs the one-shot `migrate` here as the dependency it is
  # declared to be. Against an up-to-date schema that is a no-op, and the
  # advisory lock makes it safe even if two deploys overlap — so the compose
  # file stays the single source of ordering truth.
  EZPUG_GIT_SHA="$(git_revision)" "${COMPOSE[@]}" up -d --wait --remove-orphans
  "${COMPOSE[@]}" ps --format 'table {{.Service}}\t{{.Status}}'
}

# ── routes ─────────────────────────────────────────────────────────────────
# The one path outside this repo the deploy writes. Traefik's file provider
# watches the directory, so the copy *is* the reload — and because the source
# lives in the repo, the front door is diffable and restorable like everything
# else.
cmd_routes() {
  [[ -d "$(dirname "$ROUTE_TARGET")" ]] \
    || die "$(dirname "$ROUTE_TARGET") does not exist — is Traefik on this box?"
  if cmp -s "$ROUTE_SOURCE" "$ROUTE_TARGET"; then
    log "$ROUTE_TARGET is already the repo's copy"
    return 0
  fi
  if [[ -f $ROUTE_TARGET ]]; then
    local backup="$ROUTE_TARGET.bak-$(date +%Y%m%d%H%M%S)"
    cp "$ROUTE_TARGET" "$backup"
    log "backed up the previous routes to $backup"
  fi
  cp "$ROUTE_SOURCE" "$ROUTE_TARGET"
  log "installed $ROUTE_SOURCE → $ROUTE_TARGET (Traefik picks it up by itself)"

  # **A new hostname is a certificate, and a certificate takes seconds.** The
  # `letsencrypt` resolver goes and gets one over HTTP-01 the first time a
  # router names a host it has never served; until it comes back the host
  # answers with Traefik's own self-signed default and every check against it
  # fails on `SSL certificate problem` rather than on anything this repo did.
  # So the step that opened the door is the step that waits for it — only after
  # a *changed* file, because that is the only time a host can be new, and only
  # up to a bounded wait: a certificate that never arrives is a real failure and
  # the smoke below is where it gets reported.
  local base
  base="$(env_value EZPUG_IRON_PUBLIC_URL)"
  if wait_for_tls "$base"; then
    log "${base#https://}: serving a trusted certificate"
  else
    warn "${base#https://} is not serving a trusted certificate yet — the smoke will say so"
  fi
}

# Trusted, not merely present: curl refuses an untrusted chain (exit 60), which
# is exactly the state a host is in between "Traefik knows the router" and
# "Let's Encrypt answered".
wait_for_tls() {
  local url="$1" deadline=$((SECONDS + 120))
  while [[ $SECONDS -lt $deadline ]]; do
    curl -sS -o /dev/null -m 10 "$url/healthz" >/dev/null 2>&1 && return 0
    sleep 3
  done
  return 1
}

# ── key ────────────────────────────────────────────────────────────────────
# The deployment's **first** API key, and only the first: the bootstrap key is
# refused under NODE_ENV=production and `ezpug-iron keys create` needs an
# `admin` key to already exist, so this is the one door that opens without one.
# The secret goes to stdout, once, and nowhere else — paste it into
# `.env.production` as EZPUG_IRON_API_KEY and the smoke below can read
# /v1/capacity with it.
#
#   ./scripts/deploy.sh key --name operator --scopes admin,matches,fleet
cmd_key() {
  "${COMPOSE[@]}" up -d --wait postgres >/dev/null
  "${COMPOSE[@]}" --profile tools run --rm mint-key "$@"
}

# ── smoke ──────────────────────────────────────────────────────────────────
# Not "did compose say ok" — that is what `--wait` already answered. These are
# the things that have to be true for the platform to have an orchestrator,
# checked from the outside, over the real TLS.
SMOKE_FAILED=0
SMOKE_KEY=''

check() {
  local name="$1"
  shift
  if "$@" >/dev/null 2>&1; then
    printf '  \033[32mok\033[0m    %s\n' "$name"
  else
    printf '  \033[31mfail\033[0m  %s\n' "$name"
    SMOKE_FAILED=1
  fi
}

http_status() { curl -sS -o /dev/null -w '%{http_code}' -m 15 "$@"; }

expect_status() {
  local expected="$1"
  shift
  [[ "$(http_status "$@")" == "$expected" ]]
}

# curl carrying the operator key, which never appears in argv: `--config -`
# reads the header off stdin, so the secret is not in `ps`, not in
# `/proc/*/cmdline` and not in the shell's history. `ezpug-iron` refuses a key
# as a flag for exactly this reason, and the deploy holds itself to it.
keyed() {
  printf 'header = "authorization: Bearer %s"\n' "$SMOKE_KEY" | curl --config - "$@"
}

expect_keyed_status() {
  local expected="$1"
  shift
  [[ "$(keyed -sS -o /dev/null -w '%{http_code}' -m 15 "$@")" == "$expected" ]]
}

expect_keyed_body() {
  local needle="$1"
  shift
  keyed -sS -m 15 "$@" | grep -q -- "$needle"
}

expect_body() {
  local needle="$1"
  shift
  curl -sS -m 15 "$@" | grep -q -- "$needle"
}

cmd_smoke() {
  local base host_port
  base="$(env_value EZPUG_IRON_PUBLIC_URL)"
  host_port="$(env_value EZPUG_IRON_HOST_PORT)"
  local bridge="http://$BRIDGE:${host_port:-3431}"
  SMOKE_KEY="$(env_value EZPUG_IRON_API_KEY)"

  # The container itself, on the bridge: green here and red below means Traefik
  # or DNS, never the service.
  check 'the container answers /healthz on the bridge' expect_status 200 "$bridge/healthz"
  check 'every rail and every provider is healthy' expect_body '"ok":true' "$bridge/healthz"

  # The front door, over the real certificate.
  check "$base/healthz answers over TLS" expect_status 200 "$base/healthz"
  check 'http redirects to https' expect_status 301 "${base/https:/http:}/healthz"

  # The Match API, with a key and without one. `GET /v1/capacity` is the
  # smallest route that needs the database, the key store and every registered
  # provider at once — it is what a client asks before it asks for a match.
  if [[ -n $SMOKE_KEY ]]; then
    check 'GET /v1/capacity with the operator key' expect_keyed_status 200 "$base/v1/capacity"
    check "…and it names this deployment's providers" \
      expect_keyed_body '"providers"' "$base/v1/capacity"
  else
    printf '  \033[31mfail\033[0m  %s\n' \
      "GET /v1/capacity: no EZPUG_IRON_API_KEY in $ENV_FILE — mint one with \`./scripts/deploy.sh key\`"
    SMOKE_FAILED=1
  fi
  check 'the same route without a key is refused' expect_status 401 "$base/v1/capacity"

  [[ $SMOKE_FAILED -eq 0 ]] || die 'the smoke failed — the stack is up but not serving what it should'
  printf '\n\033[32m✓ %s is serving\033[0m\n' "${base#https://}"
}

# ── rollback ───────────────────────────────────────────────────────────────
# Images only. The schema stays where it is on purpose: migrations are
# additive-safe by rule (CLAUDE.md), so the previous release can read the newer
# schema — which is precisely why there is no down-migration to run here.
cmd_rollback() {
  local pinned
  pinned="$(pinned_image)"
  [[ -z $pinned ]] \
    || die "EZPUG_IRON_IMAGE pins $pinned — roll back by naming the previous tag there and re-deploying"
  [[ -n "$(image_id "$IMAGE:previous")" ]] \
    || die "no $IMAGE:previous exists — nothing to roll back to (see ralph/DEPLOY.md)"
  log "$IMAGE: $(image_revision "$IMAGE:latest") → $(image_revision "$IMAGE:previous")"
  docker image tag "$IMAGE:previous" "$IMAGE:latest"
  "${COMPOSE[@]}" up -d --wait --remove-orphans
  cmd_smoke
  warn 'the next `deploy.sh build` will make *this* image :previous — fix forward soon'
}

cmd_all() {
  step 'preflight'
  cmd_preflight
  step 'build'
  cmd_build
  step 'migrate'
  cmd_migrate
  step 'up'
  cmd_up
  step 'routes'
  cmd_routes
  step 'smoke'
  cmd_smoke
  local what
  what="$(pinned_image)"
  printf '\n\033[32m✓ deployed %s to %s\033[0m\n' \
    "${what:-$(git_revision)}" "$(env_value EZPUG_IRON_PUBLIC_URL)"
}

case "${1:-all}" in
  all) cmd_all ;;
  preflight) cmd_preflight ;;
  build) cmd_preflight && cmd_build ;;
  backup) cmd_backup ;;
  migrate) cmd_migrate ;;
  up) cmd_up ;;
  routes) cmd_routes ;;
  smoke) cmd_smoke ;;
  key) shift; cmd_key "$@" ;;
  rollback) cmd_rollback ;;
  *) die "unknown command '$1' (all | preflight | build | backup | migrate | up | routes | smoke | key | rollback)" ;;
esac
