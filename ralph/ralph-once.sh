#!/bin/bash
# ralph-once.sh — ONE interactive Ralph iteration for EZPug Iron. Same task contract as
# afk-ralph.sh, but human-in-the-loop: run it, watch, check the commit, run it again.
# Use this to build trust in a fresh PRD before going AFK.
#
#   ./ralph/ralph-once.sh <PRD-file>

set -e
cd "$(dirname "$0")/.."

PRD="${1:?Usage: $0 <PRD-file>}"
[ -f "$PRD" ] || { echo "ERROR: PRD '$PRD' not found (paths are repo-root-relative)"; exit 1; }
PROGRESS="${PRD%.md}.progress.txt"
touch "$PROGRESS"

BRANCH=$(grep -oEm1 '\*\*Branch:\*\* `[^`]+`' "$PRD" | sed 's/.*`\(.*\)`.*/\1/' || true)
if [ -n "$BRANCH" ] && [ "$(git branch --show-current)" != "$BRANCH" ]; then
  echo "ERROR: PRD wants branch '$BRANCH', you are on '$(git branch --show-current)'."
  exit 1
fi

NEXT_LINE=$(grep -m1 '^- \[ \]' "$PRD" || true)
if [ -n "$RALPH_MODEL" ]; then
  RUN_MODEL="$RALPH_MODEL"
elif [[ "$NEXT_LINE" == *"(fable)"* ]]; then
  RUN_MODEL="claude-fable-5-1"
else
  RUN_MODEL="claude-opus-5"
fi
echo "model: $RUN_MODEL"

claude --permission-mode acceptEdits --model "$RUN_MODEL" "@$PRD @$PROGRESS
1. Read CLAUDE.md, the PRD, the progress file, and the docs the PRD names for
   your task (docs/decisions.md wins on conflict). Check git status for a dead
   previous run's partial work and finish it if found.
2. Implement the FIRST unchecked task ('- [ ]') end-to-end — one task only, you own the
   HOW, the PRD's references win over its task summaries.
3. Verify per the PRD's working rules and CLAUDE.md (UI: real browser check at 1440 and
   390 px, zero console warnings).
4. Tick the box, append a progress line to $PROGRESS, and commit with a conventional
   message and the Co-Authored-By trailer for the model that did the work."
