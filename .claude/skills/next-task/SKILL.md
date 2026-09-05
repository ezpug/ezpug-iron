---
name: next-task
description: Load the next unchecked task of the active EZPug Iron PRD and its required reading for a Ralph iteration. Use at the start of an iteration to identify which Tnn to work on and surface the docs it points at.
---

# /next-task

Start of an EZPug Iron Ralph iteration: load just enough context to implement the right
task — no more.

## Steps

1. **Find the active PRD:** the `ralph/PRD-*.md` with unchecked boxes (the highest-numbered
   one if several; ask if genuinely ambiguous).
2. **Take the FIRST `- [ ]` task** (top-down = dependency order; never skip ahead). Capture
   its id (Tnn), title, model tag (`(fable)` or default Opus), and the references it names.
3. **Read the required material:** `CLAUDE.md`, the PRD's header, findings, attitude and
   working-rules sections, `docs/decisions.md` where the task touches a decided seam, and
   the files and reference clones the task points at.
4. **Check `git status`:** uncommitted changes to files the PRD owns mean a previous run
   died mid-task — review the partial work and finish that task from where it stands.
5. **State the plan in three lines** — the task, what done looks like, how it will be
   verified — then implement. One task only; `/finish-task` closes it.
