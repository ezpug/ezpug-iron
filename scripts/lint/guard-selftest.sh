#!/usr/bin/env bash
# Proves the lint guards still have teeth: the fixtures with known violations
# must fail with exactly that many diagnostics, and the fixture with none must
# pass. A guard nobody tests is a guard that silently stops firing after a Biome
# upgrade — this runs as part of `pnpm lint`, so `pnpm verify` covers it.
set -euo pipefail

cd "$(dirname "$0")/../.."

biome=./node_modules/.bin/biome
config=scripts/lint/__fixtures__/biome.json

# fixture:marker:expected-count
cases=(
  "violations.ts:× Determinism:7"
  "isolation.ts:× Test isolation:2"
  "waitfor.ts:× Waiting budget:2"
)

for case in "${cases[@]}"; do
  fixture=${case%%:*}
  rest=${case#*:}
  marker=${rest%:*}
  expected=${rest##*:}

  output=$("$biome" lint --colors=off --config-path="$config" \
    "scripts/lint/__fixtures__/$fixture" 2>&1 || true)
  found=$(printf '%s\n' "$output" | grep -c "$marker" || true)

  if [ "$found" -ne "$expected" ]; then
    echo "lint guard self-test FAILED: expected $expected '$marker' diagnostics in" \
      "scripts/lint/__fixtures__/$fixture, got $found." >&2
    printf '%s\n' "$output" >&2
    exit 1
  fi
done

if ! "$biome" lint --colors=off --config-path="$config" \
  scripts/lint/__fixtures__/allowed.ts >/dev/null 2>&1; then
  echo "lint guard self-test FAILED: scripts/lint/__fixtures__/allowed.ts must stay clean" \
    "(explicit-argument Date construction, and the biome-ignore escape hatch)." >&2
  "$biome" lint --colors=off --config-path="$config" scripts/lint/__fixtures__/allowed.ts >&2 || true
  exit 1
fi

echo "lint guard self-test ok: determinism, redis-flush and waiting-budget violations caught," \
  "allowed patterns clean"
