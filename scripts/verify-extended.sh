#!/usr/bin/env bash
# The extended verification tier (CLAUDE.md "Verify"): everything `pnpm verify`
# covers, then the suites that need more than a unit test's world. This round
# that is the conformance suite against the fake over HTTP and the simulator's
# determinism test (PRD-01 T5, T8), each published by its package as a
# `test:extended` script. PRD-02 adds compose (Postgres, Redis), the
# orchestrator in sim mode, the fault-injection suite and the opt-in live lanes.
set -euo pipefail

cd "$(dirname "$0")/.."

# **The report survives the run** (PRD-02 T39a). The first `verify:extended`
# that went red on a crowded box printed its failure into a terminal that was
# gone by the time anyone asked which file it was; the suites that cost a night
# when they go red write a JSON report under `.verify/` instead, and this
# script prints what failed out of them whether the tier ends green or red.
# Cleared before anything runs — including `pnpm verify`, which is where the
# orchestrator's own suite fails — so a stale report from yesterday can never
# be read as today's.
REPORT_DIR="$PWD/.verify"
rm -rf "$REPORT_DIR"
mkdir -p "$REPORT_DIR"

report() {
  local status=$?
  node scripts/verify-report.mjs "$REPORT_DIR" || true
  return $status
}
trap report EXIT

pnpm verify

# The dev world (PRD-02 T2): Postgres and Redis from compose.yaml, migrated.
# `up` is idempotent, and the orchestrator's database suites are *required*
# from here on — `pnpm verify` lets them skip when the world is down, this
# tier does not. Without docker there is no world, and the tier says so.
if command -v docker >/dev/null 2>&1; then
  ./scripts/dev-env.sh up
  export EZPUG_IRON_DATABASE_TESTS=required
else
  echo "verify:extended: docker is not installed — the database suites will skip" >&2
fi

# `turbo run` refuses a task no package defines, so only ask for it once one
# does — the tier is scripted before it has content on purpose.
# (`|| true` because a workspace directory that does not exist yet — `apps/`
# before PRD-02 — makes grep exit non-zero, and `pipefail` would read that as
# "nothing found".)
if (grep -rl --include=package.json --exclude-dir=node_modules --exclude-dir=references \
  '"test:extended"' apps packages plugins gamemode-kit 2>/dev/null || true) | grep -q .; then
  pnpm exec turbo run test:extended
else
  echo "verify:extended: no package defines test:extended yet — nothing beyond pnpm verify to run"
fi

# The published artifact itself (PRD-01 T9): pack `@ezpug/match-api` the way a
# release would, audit the tarball, and run publint and arethetypeswrong over it
# (`node16` and `bundler`). It needs the build `pnpm verify` just made, which is
# why it lives here and not in a unit test.
node scripts/release.mjs check --no-build
