# Sourced, never run (PRD-03 T15a): what keeps this repo from filling the box.
# The root disk hit 100 % on 2026-09-15 and twice on 2026-09-17; measured two
# days later it held 42 GB of build cache nobody used and 322 dangling images.
# The owner's call was to prevent it rather than alert on it, so the two
# scripts that build images — `scripts/deploy.sh` and `scripts/cs2-env.sh
# build` — refuse to start below a floor and tidy up after they succeed.
#
# **What this never does, and why.** No `docker volume prune` and no
# `docker system prune --volumes`: the CS2 install is a 68 GB volume whose
# container is usually stopped, so Docker lists it as reclaimable, and other
# projects' data sits beside it on this box. No edit to
# `/etc/docker/daemon.json` and no dockerd restart: every project on the box
# would restart with it. That is why the log caps live in each compose file
# (and on the container `ezpug-node` creates) rather than in the daemon.
#
#   EZPUG_BUILD_MIN_FREE_GB     the floor, in GB free where Docker keeps its data (default 20)
#   EZPUG_BUILD_CACHE_MAX_AGE   build cache older than this goes (default 168h, a week)
#   EZPUG_BUILD_CACHE_MAX_SIZE  and past this much, the least recently used goes too (default 20GB)
#
# Age alone is not a bound. Measured on 2026-09-21, the build cache held 42 GB
# private, every byte of it younger than 31 hours: the platform rebuilds several
# times a day from a 3.4 GB context, so a week-old cutoff reclaimed nothing. The
# size cap is what holds the line on a busy day, and the age cap is what empties
# a quiet week.

: "${EZPUG_BUILD_MIN_FREE_GB:=20}"
: "${EZPUG_BUILD_CACHE_MAX_AGE:=168h}"
: "${EZPUG_BUILD_CACHE_MAX_SIZE:=20GB}"

# The filesystem an image build fills is Docker's, which is not necessarily the
# checkout's. A daemon that will not say (or a root dir this shell cannot see)
# falls back to `/`, which is the disk that filled.
docker_data_dir() {
  local dir
  dir="$(docker info -f '{{.DockerRootDir}}' 2>/dev/null || true)"
  [[ -n $dir && -d $dir ]] || dir=/
  printf '%s' "$dir"
}

# Refuse to build below the floor, and say what is on the disk while refusing:
# a bare "no space" is the start of an hour, `df` plus `docker system df` is the
# end of one.
require_build_space() {
  local what="$1" dir free_kb floor_kb
  [[ $EZPUG_BUILD_MIN_FREE_GB =~ ^[0-9]+$ ]] \
    || { printf 'EZPUG_BUILD_MIN_FREE_GB must be a whole number of GB (got %s)\n' "$EZPUG_BUILD_MIN_FREE_GB" >&2; return 1; }
  dir="$(docker_data_dir)"
  free_kb="$(df -Pk "$dir" | awk 'NR==2 {print $4}')"
  floor_kb=$((EZPUG_BUILD_MIN_FREE_GB * 1024 * 1024))
  if [[ -z $free_kb ]] || (( free_kb < floor_kb )); then
    printf 'refusing to %s: %s GB free under %s, the floor is %s GB (EZPUG_BUILD_MIN_FREE_GB)\n' \
      "$what" "$((${free_kb:-0} / 1024 / 1024))" "$dir" "$EZPUG_BUILD_MIN_FREE_GB" >&2
    df -h "$dir" >&2
    docker system df >&2 2>/dev/null || true
    printf 'nothing was built. `docker image prune` and `docker builder prune` are safe here; pruning volumes is not.\n' >&2
    return 1
  fi
}

# After a build or a deploy that succeeded. Dangling images only (`image prune`
# without `-a`: a tagged image such as the deploy's `:previous` stays, and so
# does anything a container still uses), and build cache by age and size. All are
# box-wide, which is the point — the cache that filled the disk was nobody's in
# particular. A failure here is a warning: the thing that mattered already
# happened.
tidy_docker() {
  docker image prune -f >/dev/null \
    || printf 'warning: removing dangling images failed\n' >&2
  docker builder prune -f --filter "until=$EZPUG_BUILD_CACHE_MAX_AGE" >/dev/null \
    || printf 'warning: pruning the build cache failed\n' >&2
  docker builder prune -f --max-used-space "$EZPUG_BUILD_CACHE_MAX_SIZE" >/dev/null \
    || printf 'warning: capping the build cache failed\n' >&2
  printf 'tidied: dangling images removed, build cache older than %s or past %s pruned; %s free under %s\n' \
    "$EZPUG_BUILD_CACHE_MAX_AGE" "$EZPUG_BUILD_CACHE_MAX_SIZE" "$(df -h "$(docker_data_dir)" | awk 'NR==2 {print $4}')" "$(docker_data_dir)"
}
