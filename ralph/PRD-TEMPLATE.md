# EZPug Iron PRD conventions & template

A PRD is one Ralph round: a commit-sized task list derived from `docs/decisions.md` and
the platform's specs where they reach into a server. The decisions stay the source of
intent; the PRD is the work order. Name PRDs `ralph/PRD-<nn>-<slug>.md`; the loop scripts
create the matching `PRD-<nn>-<slug>.progress.txt` beside it and both get committed as
they change. A task closes in two commits: the work (with the PRD box ticked), then the
progress line naming that commit's sha. Never amend to merge them.

Writing rules (the context-engineering short version): give intent, references and
invariants — never step-by-step instructions; the model owns the HOW. Point every task at
the files, fixtures, vendor docs and reference clones it needs (rich references beat
prose). Don't restate what CLAUDE.md or the decisions already say. If pre-round
investigation happened, write the findings down with `file:line` so no iteration
searches twice.

## Model routing

`claude-opus-5` is the default and needs no tag. Tag a task `(fable)` to run it on Claude
Fable 5.1 — reserve it for work that must be thought through once and right: contracts,
package boundaries, the SDK's core abstractions, state machines, load-bearing algorithms,
gnarly cross-language debugging. Mechanical follow-ups, adapters over a settled interface
and wiring stay on Opus.

## Template

    # PRD <nn>: <round title>

    <2–5 sentences: the outcome of this round and why now. Which decisions it delivers.>

    **Branch:** `<branch>`. **Surface:** <folders this round may touch>.
    **Model:** `claude-opus-5`; tasks tagged `(fable)` run on Fable 5.1.
    <standing budgets when relevant: migrations, money rules, flags.>

    ## Findings

    <Only if investigation preceded the round: file:line, what exists to reuse.>

    ## Attitude

    <The 2–4 standing decisions that keep every task honest this round, each with its why.>

    ## Tasks

    - [ ] **T1 (fable): <title>.** <What done looks like. References.>
    - [ ] **T2: <title>.** <…>

    ## Working rules

    <Round-specific verification beyond CLAUDE.md's defaults; budgets; hard don'ts.>

    ## When the PRD is complete

    <The final sweep. The loop outputs the completion sigil after this.>
