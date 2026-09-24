# PRD 05: Workshop maps go live

The platform's PRD-12 ships a real community map (AIM Map, published file 3084291314) as a
room preset, and its T6a is blocked on
[#3](https://github.com/ezpug/ezpug-iron/issues/3): a `workshop/<id>/<name>` plan reaches
the engine verbatim, so a node never hosts it and the match sits silent until the platform
cancels at five minutes. This round makes every workshop plan hosted by id on every flow,
proves it on the dev node, releases it, and turns a node that never becomes ready into a
failure that says why.

Runs in parallel with `/root/ezpug/ralph/PRD-12-showtime.md`. Its T6a waits for T1 here
(the `chore(deps): match-api x.y.z` bump, then its `EZPUG_CS2_ROWS=workshop` row).

**Branch:** `main`. **Surface:** the whole repo. **Model:** `claude-opus-5-5`.

**Budgets:**
- **The dev CS2 lane** is the proving ground (`EZPUG_CS2_TESTS`, the dev node, the lane
  lock). The platform loop shares it.
- **Dathost:** none. Nothing in this round allocates a Dathost server.
- **Contract:** additive only; every change is a release to the box's Verdaccio with a
  changelog line naming the platform task it serves.

## Findings

From the issue, verified against the tree on 2026-09-24 (match-api `0.22.0`).

- `apps/orchestrator/src/link/assign.ts:126`: `maps: request.maps` goes into the `assign`
  frame as-is.
- `plugins/EZPug.Core/Loader/GamemodeLoader.cs:139`: `WorkshopId` is `^[0-9]{6,20}$`, so
  the wire's `workshop/3084291314/aim_map` is not recognised and the loader runs
  `changelevel workshop/3084291314/aim_map`.
  `GamemodeLoaderTests.AWorkshopMapIsHostedByIdAndTheHostnameKeepsTheId` feeds a bare
  `3070923343`, which the wire never sends.
- `apps/orchestrator/src/match-config/matchzy.ts:323`: `maplist: request.maps.map(plan =>
  plan.map)`. MatchZy (`references/MatchZy-Enhanced/src/Utility.cs`, `ChangeMap` /
  `HandleMapChangeCommand`) calls `host_workshop_map` only when `long.TryParse(mapName)`
  succeeds, else `changelevel` behind `Server.IsMapValid`, so a `workshop/…` entry is never
  hosted. `matchzy.test.ts:85` and `fixtures/matchzy-knife-bo3.json` pin
  `workshop/3070288000/de_cache` into `maplist` verbatim, so the tests agree with the bug.
- `apps/orchestrator/src/providers/dathost/provider.ts:559`: Dathost claims `workshopMaps`
  through `cs2_settings.workshop_*` and the plugin's `host_workshop_map`. Whether the node
  provider claims the same capability, and whether it should until T1 lands, is part of T1.
- The grammar itself (`packages/match-api/src/vocabulary/maps.ts`, `mapIdentifierSchema`)
  is right and stays: the platform names a workshop map `workshop/<id>/<name>`.
- The platform's evidence: iron match `057f847e-bb7d-4b92-9398-f8dfd87c69d2` on the dev
  world (3430) held `match.allocated` and then `match.ended {cancelled}` and nothing else.
  The official-map row a minute earlier was ready in ~12 s on the same container.

## Attitude

- **One translation, at the edge that speaks to the engine.** The wire keeps
  `workshop/<id>/<name>`; the server side turns it into a bare id in one place per
  language (the orchestrator's config builders, the loader), and a test on each side holds
  the wire's own spelling, not a hand-shortened one.
- **Silence is a bug.** A match that cannot reach `server_ready` says so with a reason a
  person can act on; the platform should never have to learn it from its own five-minute
  cancel.

## Tasks

- [x] **T1: a workshop plan is hosted by id, everywhere.** The loader's first map, MatchZy's
  `maplist` (the bare id MatchZy expects), and a series' later maps all end in
  `host_workshop_map <id>` for a `workshop/<id>/<name>` plan. Decide what `going_live.map`
  reports for one (the wire's `workshop/<id>/<name>` is the platform's preference, since it
  is what it sent; the engine's name is acceptable if the wire cannot know it), and say so
  in the CHANGELOG and `docs/match-api.md`. Fix the fixtures that pinned the bug. Add a
  package fixture "a workshop map goes live on a node". Prove it on the dev node behind the
  lane lock: a puppeted 1v1 on `workshop/3084291314/aim_map` reaches `going_live`, and its
  map is named as decided. Roll the plugin out to the dev node the way PRD-04 T11 did
  (`docs/nodes.md`, `docs/operations.md`). Release to the box's Verdaccio (`docs/match-api.md`
  "Cutting one", `node scripts/release.mjs publish --registry http://172.17.0.1:4873/`), with
  the changelog line naming the platform's PRD-12 T6a. Comment on #3 with the version, the
  `going_live.map` decision and the proving run's iron match id, and leave it open for the
  platform to close from its lane.
- [ ] **T1a (effort: medium): a restart after `series_end` still ends the match.** Found by
  T1's first proving run on 2026-09-24 (iron `c5dd5a9a`). The dev orchestrator restarted
  (`tsx watch`) between `series_end` and `demo_available`. `awaitingDemo` lives only in the
  machine's in-memory runtime, so the demo arrived, was uploaded, and ended nothing. The
  match sat `live` until the lane forced it to end twelve minutes later. A restart in that
  window, which a deploy can cause, must still end the match `completed` once the demo is
  in, or at the demo deadline. Prove it with a machine test that restarts between the two.
- [ ] **T2 (effort: medium): a node that never gets ready says why.** A node whose server
  does not reach `server_ready` within a ready deadline fails the match (`match.failed`, or
  the vocabulary's nearest existing fact, additive only) with a reason that names the map
  and what the node saw last, and the server leaves the fleet. The deadline is a named
  constant with its reason, shorter than the platform's five-minute handoff cancel, and
  tolerant of a first-time workshop download (measure AIM Map's cold download on the dev
  node and write the number down). Released like T1, changelog naming PRD-12 T6a's
  follow-up.
- [ ] **T3 (effort: medium): the docs and the sweep.** A decision in `docs/decisions.md` for
  how a workshop plan is hosted and what `going_live.map` says. `ralph/OPEN-POINTS.md`
  updated. The completion list below.

## Working rules

- **Production is `./scripts/deploy.sh` and nothing else**: the box's `docker` shim
  refuses `-p ezpug-iron` and `-f compose.prod.yaml` outside it with exit 125.
- **No Dathost.** Nothing in this round rents a server.
- **The CS2 lane is shared with the platform loop**: the lane lock as the page says,
  release after the server has left the fleet, never across a task boundary.
- **Additive contract, released with a changelog line**, never a service tag.
- **Commit only your own paths.** Never `git add -A`.
- **Secrets**: RCON and join passwords, GSLTs and tokens live only in gitignored env
  files, the token store, process memory or `~/.npmrc`; fixtures are scrubbed; nothing is
  ever pasted into a log line or a progress line.

## When the PRD is complete

- One green `EZPUG_CS2_TESTS=required` extended run after T2.
- Every contract change released to the box's Verdaccio.
- Closing note: the release versions, the `going_live.map` decision, AIM Map's cold
  download time, and what the platform needs to do (bump, run its workshop row, close #3).
