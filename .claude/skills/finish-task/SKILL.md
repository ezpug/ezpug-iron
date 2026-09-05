---
name: finish-task
description: Definition of Done for the in-flight EZPug Iron Ralph task — verify (pnpm verify, the extended tier for flows, a real server check for plugin work), tick the PRD box, append the progress line, and make the conventional commit with the model trailer. Use after implementation, before declaring the task done.
---

# /finish-task

End of an EZPug Iron Ralph iteration: verify the Definition of Done and stage the closing
edits + commit. Stop on any failure — never close a task on broken work.

## Steps

1. **Confirm the active task** (Tnn) and its PRD in `ralph/` (from the conversation, or
   `git status` against the first unchecked task). If unclear, ask.
2. **Verify:** `pnpm verify` from the repo root (TypeScript and C# both — until T1 of the
   spine lands it, the PRD's working rules define verification). Flow work also runs the
   extended tier. Plugin work that changes what a server does gets a run on the dev CS2
   server when the container is up, and says so in the progress line when it is not.
3. **Tick the task's box** in the PRD (`- [ ]` → `- [x]`) and **commit** the task's work
   with a scoped conventional message ending in the Co-Authored-By trailer of the model
   that did the work (Claude Fable 5.1 for `(fable)` tasks, Claude Opus 5 otherwise).
4. **Append one line** to the PRD's progress file
   (`ralph/PRD-<nn>-<slug>.progress.txt`):
   `<task-id>: <what + notable decisions> — <short sha of step 3> — <date>`, then commit it
   as `chore(ralph): T<nn> progress line` with the same trailer. Two commits, in this
   order — the line records the sha of the commit before it, so never amend to fold them
   together.
