#!/bin/bash
# afk-ralph.sh — autonomous Ralph loop for EZPug Iron. ONE task per iteration.
#
# Usage:   ./ralph/afk-ralph.sh <PRD-file> <iterations>
# Example: ./ralph/afk-ralph.sh ralph/PRD-01-spine.md 12
#
# Each iteration reads the PRD + its progress file (<PRD>.progress.txt, created if
# missing), implements the first unchecked task, verifies, ticks the box, appends a
# progress line, commits — then loops. Stops early on <promise>COMPLETE</promise>.
#
# Model routing (see PRD-TEMPLATE.md): tasks tagged '(fable)' run on claude-fable-5-1,
# everything else on claude-opus-5. Override for a run with RALPH_MODEL=<model>.
# A '**Branch:** `x`' header in the PRD is enforced when present.

set -e
cd "$(dirname "$0")/.."   # repo root, regardless of caller cwd

PRD="${1:?Usage: $0 <PRD-file> <iterations>}"
ITERATIONS="${2:?Usage: $0 <PRD-file> <iterations>}"
[ -f "$PRD" ] || { echo "ERROR: PRD '$PRD' not found (paths are repo-root-relative)"; exit 1; }
PROGRESS="${PRD%.md}.progress.txt"
touch "$PROGRESS"

BRANCH=$(grep -oEm1 '\*\*Branch:\*\* `[^`]+`' "$PRD" | sed 's/.*`\(.*\)`.*/\1/' || true)
if [ -n "$BRANCH" ] && [ "$(git branch --show-current)" != "$BRANCH" ]; then
  echo "ERROR: PRD wants branch '$BRANCH', you are on '$(git branch --show-current)'."
  exit 1
fi

# A model out of budget waits instead of spending iterations; give up after ~4 h.
LIMIT_WAITS=0
MAX_LIMIT_WAITS="${RALPH_MAX_LIMIT_WAITS:-24}"

echo "AFK Ralph — EZPug Iron — PRD: $PRD — up to $ITERATIONS iterations"
echo ""

for ((i=1; i<=ITERATIONS; i++)); do
  NEXT_LINE=$(grep -m1 '^- \[ \]' "$PRD" || true)
  NEXT_TASK=$(echo "$NEXT_LINE" | grep -oE 'T[0-9]+' | head -1 || true)

  if [ -n "$RALPH_MODEL" ]; then
    RUN_MODEL="$RALPH_MODEL"
  elif [[ "$NEXT_LINE" == *"(fable)"* ]]; then
    RUN_MODEL="claude-fable-5-1"
  else
    RUN_MODEL="claude-opus-5"
  fi

  # Trailer must name the model that actually did the work.
  case "$RUN_MODEL" in
    *fable*) TRAILER="Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" ;;
    *haiku*) TRAILER="Co-Authored-By: Claude Haiku 4.5 <noreply@anthropic.com>" ;;
    *)       TRAILER="Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>" ;;
  esac

  echo "=========================================="
  echo "  Ralph $i/$ITERATIONS — $(date '+%Y-%m-%d %H:%M:%S')"
  echo "  next task: ${NEXT_TASK:-finalize} -> model: $RUN_MODEL"
  echo "=========================================="

  PROMPT="@$PRD @$PROGRESS

One EZPug Iron Ralph iteration — ONE task per run.

1. Read CLAUDE.md, the PRD, the progress file, and the docs the PRD names for
   your task (docs/decisions.md wins on conflict). Check 'git status': uncommitted
   changes to files this PRD owns mean a previous run died mid-task — review the partial
   work, keep what is correct, and finish that task (its box is still unchecked).
2. Pick the FIRST unchecked task ('- [ ]') in the PRD. Top-to-bottom is dependency order;
   do not skip ahead. Genuinely hard-blocked? Add a '> blocked: ...' note under it and
   take the next task only.
3. Implement that ONE task end-to-end. You own the HOW; the PRD's references win over its
   task summaries. No bundling, no stealth refactors — separate work becomes a new
   '- [ ]' line in the PRD instead.
4. Verify per the PRD's working rules and CLAUDE.md. UI tasks get a real browser check at
   1440 and 390 px with zero console warnings.
5. Tick the box, then append one line to $PROGRESS:
   '<task-id>: <what + notable decisions> — <short sha> — <date>'.
6. Commit (PRD tick + progress line included) with a scoped conventional message ending
   in: '$TRAILER'.

If every box is already checked, do the PRD's completion section if present, then output
exactly: <promise>COMPLETE</promise>"

  # A crashed run must NOT kill the loop (set -e): capture rc, warn, retry next iteration.
  set +e
  result=$(claude --dangerously-skip-permissions --model "$RUN_MODEL" -p "$PROMPT")
  rc=$?
  set -e

  echo "$result"
  echo ""

  if [ $rc -ne 0 ]; then
    # A usage limit is not a failed iteration — it is the clock. Waiting costs
    # nothing; retrying every two minutes costs the round its iteration budget
    # (PRD-08 lost 14 of 45 that way before anyone looked).
    if [[ "$result" == *"session limit"* || "$result" == *"usage limit"* || "$result" == *"rate limit"* ]]; then
      LIMIT_WAITS=$((LIMIT_WAITS + 1))
      if [ $LIMIT_WAITS -gt "$MAX_LIMIT_WAITS" ]; then
        echo "ERROR: still limited after $LIMIT_WAITS waits (~$((LIMIT_WAITS * 10)) min). Stopping so the budget survives."
        exit 1
      fi
      echo "LIMIT: ${RUN_MODEL} is out of budget (wait $LIMIT_WAITS/$MAX_LIMIT_WAITS). Iteration $i not consumed. Sleeping 600s."
      i=$((i - 1))
      sleep 600
      continue
    fi
    echo "WARN: iteration $i exited rc=$rc (task ${NEXT_TASK:-finalize}). Box stays unchecked -> next iteration retries. Pausing 120s."
    sleep 120
    continue
  fi
  LIMIT_WAITS=0

  if [[ "$result" == *"<promise>COMPLETE</promise>"* ]]; then
    echo "PRD complete after $i iterations."
    exit 0
  fi

  [ $i -lt $ITERATIONS ] && sleep 5
done

echo ""
echo "Reached $ITERATIONS iterations. Check $PROGRESS and run again to continue."
