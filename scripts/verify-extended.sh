#!/usr/bin/env bash
# The extended verification tier (CLAUDE.md "Verify"): everything `pnpm verify`
# covers, then the suites that need more than a unit test's world. This round
# that is the conformance suite against the fake over HTTP and the simulator's
# determinism test (PRD-01 T5, T8), each published by its package as a
# `test:extended` script. PRD-02 adds compose (Postgres, Redis), the
# orchestrator in sim mode, the fault-injection suite and the opt-in live lanes.
set -euo pipefail

cd "$(dirname "$0")/.."

pnpm verify

# `turbo run` refuses a task no package defines, so only ask for it once one
# does — the tier is scripted before it has content on purpose.
if grep -rl --include=package.json --exclude-dir=node_modules --exclude-dir=references \
  '"test:extended"' apps packages plugins gamemode-kit 2>/dev/null | grep -q .; then
  pnpm exec turbo run test:extended
else
  echo "verify:extended: no package defines test:extended yet — nothing beyond pnpm verify to run"
fi
