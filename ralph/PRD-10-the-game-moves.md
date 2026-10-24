# PRD 10: The game moves, and the iron knows before a player does

CS2 1.41.9.2 shipped on 2026-10-23 at 00:54 CEST and nobody here learned it until players
did at 21:47: every Dathost server crashed on boot one second after MultiAddonManager woke
the Steam API, and with the loader gone, on the first human `SIGNONSTATE_SPAWN`. The
orchestrator said "no server_ready on de_dust2 within 180 s; dathost reports the server
stopped" and the platform aborted the match. Upstream had shipped the fixes ten hours
earlier (CounterStrikeSharp 1.0.378, MultiAddonManager 1.7). The owner fixed the template
by hand at the table ([#13](https://github.com/ezpug/ezpug-iron/issues/13)), and the repo
is now *behind the server it describes*: `pnpm dathost:image` would put the crash back.
This round makes a CS2 update a **version fact with exactly two outcomes** — a loud, named
refusal before any player sees it, or a verified pass — and it starts by paying what #13
owes. The design brief is the owner's (2026-10-24, "The game moves"): a watcher with no
human in detection, a canary that spends cents before players do, and updates as data,
not edits. The platform's PRD-24 consumes this round's health fields; `/root/ezpug-video`'s
PRD-05 does the same for the render nodes in its own repo.

**Branch:** `main`. **Surface:** the whole repo. **Model:** `claude-opus-5-5`; T2 and T5 are
`(fable)` (the contract shapes and the follow policy are decided once); effort as tagged.
**Order:** T1 first and alone — until it lands **nobody runs `pnpm dathost:image`** (the
template is hand-patched and ahead of the repo; the script would upload 1.0.376 / git1469
over 1.0.378 / git1483). Then T2 → T3 → T4 → T5 → T6 → T7 → T8 → T9.

**Budgets:**
- **Money.** Everything that rents is a Dathost clone for minutes. The round's ceiling is
  **150 ¢** across every task; a canary run is **≤ 10 ¢** (a 12-slot pay-as-you-go clone for
  under ten minutes, a `maxServerLifetimeMinutes` of 10 on its own key, so a canary that
  hangs is cut by the budget, not by luck), a build's full proof **≤ 30 ¢** (plain + loader +
  one retry; the owner's number). Every progress line that rented names the cents.
- **Contract: additive only**, one release (`0.35.0`) from T7 and nowhere else, with a
  changelog naming the platform's PRD-24. The platform must learn only "game build X,
  canary green/red/unproven since T, because Y": `grep -rni "dathost\|matchzy\|counterstrikesharp"
  /root/ezpug/apps /root/ezpug/packages` must stay spec text and badge strings after the
  platform's bump.
- **Pins move in their own commits** (`docs/pins.md` → Bumping one): a bump is
  `chore(pins): …` with the homes and the table together, never folded into a feature.
- **The lane lock first, always** (`docs/operations.md` → The lane lock). The platform's
  loops share the CS2 container. Give it back only after the server has left the fleet.
- **Nothing here touches `.env.production` except T6**, which turns the HUD addon back on
  after its proof, through `./scripts/deploy.sh up`, with the backup `#13` left
  (`.env.production.bak-hud-*`).

## Findings

Traced 2026-10-24 at `8dd8d82`. Trust the file over this note.

- **The pins and their homes.** `docker/cs2/Dockerfile:81-90` (`METAMOD_VERSION=2.0.0-git1469`,
  `COUNTER_STRIKE_SHARP_VERSION=1.0.376`, `MULTIADDONMANAGER_VERSION=1.6.2`, each with a
  `_SHA256`), `plugins/Directory.Build.props` `<CounterStrikeSharpApiVersion>1.0.376`,
  `docs/pins.md` → The server side. `scripts/check-pins.mjs:34-47` reads the props,
  `:66-85` the Dockerfile `ARG`s, and the one cross-home rule at the bottom holds the API
  version and the release equal (`compiledAgainst !== shippedInTheImage`). `EZPug.Sdk.Tests`
  asserts the restored assembly's number. The production template `6a9fe695318688300691c7fb`
  carries 1.0.378's `addons/counterstrikesharp/{bin,api,gamedata}` and git1483's two
  `linuxsteamrt64` libs (50 files, then `sync-files`) and **still the 1.6.2 MultiAddonManager
  binary, asleep**; its `ezpug-image.json` manifest says 1.0.376, so `pnpm dathost:image
  --check` is red today by construction (`scripts/dathost-image.mjs:902-943` compares the
  manifest's pins, its revision and the listing).
- **What `dathost:image` would do today.** `scripts/dathost-image.mjs:716-740` reads the pins
  out of the Dockerfile, `:721` refuses an image whose `build.json` names another
  CounterStrikeSharp than the tree, `:835-845` moves every file whose hash or listing
  disagrees with the manifest. From this tree it would re-upload 1.0.376 and git1469. T1's
  first commit must land before the script is touched.
- **The upstream fixes.** CounterStrikeSharp v1.0.378 (2026-10-23 14:22 UTC, "fix: Game Update
  1.41.9.2") builds against metamod-source `170058a2` = `2.0.0-git1483`
  (`https://mms.alliedmods.net/mmsdrop/2.0/mmsource-2.0.0-git1483-linux.tar.gz`);
  MultiAddonManager v1.7 (10:55 UTC, Source2ZE, the `steamrt3` build is the one the image
  takes, `Dockerfile` → MultiAddonManager). `hud-addon.ts:40-45` holds 1.6.2's loader `.vdf`
  **byte for byte** (`HUD_ADDON_LOADER`), and `dathost-image.mjs:146` refuses the same path on
  the template (`ASLEEP_PLUGIN_LOADER`); a 1.7 that ships a different `.vdf` is a change in
  both and a test holds them equal.
- **The git1468 lesson** (`docs/pins.md` → Metamod:Source): git1468 hung in 6 of 9 boots on
  the dev node; git1469 booted 12 of 12 in 4–8 s. "Boot a bump several times before you
  trust it" is a sentence today and a verb after T4.
- **Where the orchestrator already ticks.** The probe loop (`apps/orchestrator/src/providers/probes.ts`,
  `PROBE_INTERVAL_MS = 30_000`, `:75`) asks every provider its cheapest question on the
  injected clock and writes `healthy`/`lastError` into the registry, which
  `GET /v1/fleet/providers` serves (`providerHealthSchema`,
  `packages/match-api/src/resources/fleet.ts:137-147`: `id, healthy, drained, lastCheckedAt,
  lastError, servers`). One fact per incident (`fleet.provider_unreachable`). The other loops:
  the reaper (`providers/reaper.ts`), the budget sweep (`budget/service.ts`), the GSLT pool's
  sweep (`gslt/pool.ts`), the webhook worker — all composed in `orchestrator.ts:195-240`. The
  watcher is one more of these, on the same clock, with a `fetch` it takes from outside the
  way the GSLT pool takes its Steam (`createFakeSteam`, `orchestrator.ts:208-215`).
- **The fleet facts are envelopes a strict client parses.** `orchestrationFactSchema` is a
  `discriminatedUnion` (`packages/match-api/src/webhooks/envelope.ts:286-316`), fanned out
  into every open match of the key (`:208-214`). A new `type` there is **not additive for a
  consumer that verifies strictly** — `docs/pins.md` records 0.16.0's `team: "unrostered"`
  breaking every ≤ 0.15.0 client, and the platform's highlights pipeline lost clips to the
  same skew in October (video-api). So a build fact is **state a client reads**, never an
  envelope it must parse: T2 puts it on the health route, not in the union.
- **The boot deadline and what it says.** `match/machine.ts:815` — `no server_ready on ${map}
  within ${bootMs/1000} s; ${lastSeen}`; `lastSeen` (`:827-855`) reads the provider's
  `status()` (`providers/dathost/provider.ts:705-722`: off is `stopped`) and the link's last
  word. The Dathost console door (`provider.ts:826`, `console(serverId)`) is where the crash
  line (`Engine2PreBreakpadDumpFunction`, `SERVER EXITED`, the `[MultiAddonManager] Steam API
  Activated` before it) can be read for a verdict's `reason`.
- **A server already tells its versions.** `serverVersionsSchema`
  (`packages/protocol/src/server-link.ts:131-143`: `plugin, sdk, counterStrikeSharp,
  matchzy?, metamod?`) rides the `hello` and lands in `servers.versions`
  (`db/schema/servers.ts:78`). It has no game build. `steam.inf`'s `PatchVersion` is read by
  `scripts/cs2-env.sh:145` (`pnpm cs2:status`) and by nothing at runtime;
  `appmanifest_730.acf` carries the `buildid` Steam's API speaks. **Which number is which is
  written nowhere**: the brief names "build 11162119 server / 26144732 client" and
  `api.steamcmd.net`'s `public.buildid` is one of them. T2's first finding relates the three
  (Steam's buildid, the volume's `appmanifest_730.acf` buildid, `steam.inf`'s PatchVersion) in
  one note, read off the dev node.
- **The platform's hand-run canary.** `/root/ezpug/apps/api/src/fleet/test-match.ts:25-28`:
  bots are rules, not vocabulary (`bot_quota` and friends, `warmup.minPlayersToReady: 0`,
  "the shape the iron's own bots runs use"); 4 bots, 2 rounds proved the hand fix on
  2026-10-23. The orchestrator's canary is that request, composed here, on a key of its own.
- **The dev node's update and the HUD's drill.** `docs/operations.md:169-190`: Dathost updates
  its servers' CS2 itself, the `cs2-data` volume moves only with `pnpm cs2:install` (with the
  lane free and no container running), and "Steam will not serve a delta" to a volume that
  fell far behind. `docs/hud.md:89-116` is the six-step drill after an update, by hand. The
  lane's `retakes` row is named there as "the canary for a CS2 update that outran
  CounterStrikeSharp (exit 139)".
- **Nodes.** `apps/node/src/version.ts` (`NODE_AGENT_VERSION = '0.1.0'`), the `hello` carries
  `imageDigest` (`packages/protocol/src/node-link.ts:91-94`), the agent pulls the server
  image when absent (`docs/nodes.md:181-188`) and reports its digest. Nothing reads the
  volume's game build. `node@0.1.0` and `cs2@0.1.0` are the only published tags
  (`docs/pins.md` → The images we publish); production and the dev node both run local
  `:dev` builds.
- **Scopes** (`packages/match-api/src/scopes.ts:40`): `matches, fleet, admin, simulation`.
  `admin` implies the rest. A canary route is `fleet` (the drain's scope).
- **Decisions** end at 36 (`docs/decisions.md:789`); this round writes 37–41.
- **Open issues**: #13 (closed by T1 and T6), #6, #7, #9, #10, #11, #12 — none of the others
  is this round's work; they stay open.

## Attitude

- **Every process that launches CS2 states which build it is for, and refuses or alerts, by
  name, when the build it meets differs.** The orchestrator for its providers, the node for
  its volume, the follow verb for the image. A mismatch that surfaces as something else (a
  dead server, a bad host, a 180 s deadline) is the bug this round exists to end.
- **Facts, not edits.** A build move is a fact with a time; a canary verdict is a fact per
  build; a pin bump is a verb that writes the homes and the table together. Nobody edits a
  Dockerfile by hand on a Saturday again, and nobody reads a release page to learn the game
  moved.
- **Keep serving, say so loudly.** A red or unproven build never refuses a match: there is
  no safe alternative to a match, and a LAN with no internet has only the server it has. The
  loudness is the health read the platform already renders, one GitHub issue per build, and
  the one thing that *is* refused automatically: the HUD's addon loader on a red build,
  because that loader has killed every server twice and a match without it loses nothing.
- **The platform learns a build and a verdict, never a plugin's name.** The health fields
  are a build id, a state, a time, a reason sentence and one opaque revision. The vocabulary
  of Metamod, CounterStrikeSharp and MultiAddonManager stays in `docs/pins.md`, which is
  public and the right place for it.

## Tasks

- [x] **T1 (effort: high): The pin bump #13 owes.** Three commits, in this order, nothing else
  in them. **(a)** `chore(pins): CounterStrikeSharp 1.0.378, Metamod 2.0.0-git1483` —
  `docker/cs2/Dockerfile` (`COUNTER_STRIKE_SHARP_VERSION`/`_SHA256`, `METAMOD_VERSION`/`_SHA256`,
  each sha from `curl -fsSL <url> | sha256sum`), `plugins/Directory.Build.props`
  `<CounterStrikeSharpApiVersion>1.0.378`, and the two `docs/pins.md` rows rewritten in the
  table's voice (why: "fix: Game Update 1.41.9.2", builds against metamod `170058a2`; what
  1.41.9.2 did to 1.0.376 on 2026-10-23, both crash lines). `pnpm verify` green —
  `check-pins`, `EZPug.Sdk.Tests`' assembly assertion, the vendored WeaponPaints fork and
  retakes compiling against the new API. **(b)** `chore(pins): MultiAddonManager 1.7` — the
  `steamrt3` artifact, its sha, the row (upstream's release notes for 1.41.9.2 in one line),
  and `HUD_ADDON_LOADER` in `apps/orchestrator/src/providers/hud-addon.ts` held to the 1.7
  release's `.vdf` byte for byte (a test reads it out of the built image or the unpacked
  release, and `dathost-image.test.ts` keeps `ASLEEP_PLUGIN_LOADER` equal). **(c)** the proof:
  `pnpm cs2:build` inside a hand hold of the lane; **boot the image at least eight times** on
  the dev node (the git1468 lesson), each boot timed to CounterStrikeSharp's first line and
  to `server_ready`, no hang, no `Failed to find signature`; the lane's `retakes` and
  `pug-2v1` rows green; `pnpm cs2:install` first if the volume is behind 1.41.9.2 (the lane
  held, no container running, `docs/operations.md:169-190`). Then `pnpm dathost:image`
  (which now uploads 1.0.378 / git1483 / MAM 1.7 over the hand patch — the first write the
  template has had since #13, and it must be byte-equal on the 50 hand-patched files, so
  the script's own diff printout goes in the progress line), `pnpm dathost:image --check`
  green, the template's manifest reading the new pins, `./scripts/deploy.sh all` with the
  orchestrator on `8dd8d82`+ (no orchestrator change in T1 beyond the loader constant),
  smoke green, one Dathost match through `pnpm dathost:smoke` reaching `ready` (the one
  rental, ≤ 10 ¢, named). Comment on #13 with the three shas and tick its first two boxes;
  the issue closes in T6. The progress line records the boot count, each boot's seconds,
  and the diff of what `dathost:image` moved.
  > was blocked: (2026-10-24, on the owner; answered below) (a) `bf02096` and (b) `a815c09` are committed and
  > `ghcr.io/ezpug/ezpug-iron/cs2:dev` is built from `a815c09`. **(c) cannot boot anything on
  > the dev node: the `ezpug-iron-cs2_cs2-data` volume no longer exists.** On 2026-10-19 the owner
  > approved deleting it in a box-wide disk cleanup (a `/root/signotec-prepare` session), along
  > with the old `cs2:dev` image. Putting the game back is a ~67 GB `pnpm cs2:install` that
  > reverses that decision. 132 GB are free after today's tidy, but that same disk hit 0 bytes
  > this afternoon when this build and the platform's deploy build ran at once. So the owner
  > picks one: **(1)** `pnpm cs2:install` (lane held, no container), then (c) as written; or
  > **(2)** (c) proven on Dathost alone (`dathost:image`, then several `dathost:smoke` boots at
  > ≤ 2 ¢ each instead of the eight dev-node boots). Under (2) the image stays unproven for LAN
  > nodes until the dev node returns, and T4 and T8 need the volume anyway. Nothing was written
  > to the template. A read-only probe (dry run plus a hash of each candidate file downloaded
  > from the template) found the hand-patched files byte-equal to the image. Those are the 5
  > CounterStrikeSharp `api/bin/gamedata` files that changed and Metamod's
  > `linuxsteamrt64/{libserver,metamod.2.cs2}.so`; the other hand-patched files are already
  > unchanged against the manifest. The 40 files that really differ are our plugins at
  > `a815c09` (including PRD-09 T8's `104ed0e`, which the template, still at `ded8c12`, does not
  > carry yet), Metamod's binaries for other games, and MultiAddonManager 1.7's `.so`, asleep.
  > decided (2026-10-24 14:55, the orchestrating session for the owner): **(2) now, (1) at T4.**
  > Prove (c) on Dathost alone: `dathost:image`, then several `dathost:smoke` boots (≤ 2 ¢ each)
  > and one bots test match through the platform's fleet door; the template is what players sit
  > on tonight and the hand-patched files are already byte-equal to the image, so the push is a
  > no-op the repo now owns. The image stays **unproven for LAN nodes** and the pins.md row says
  > so. The volume comes back as **T4's first step**: `pnpm cs2:install` with the lane held,
  > `nice`, only while no deploy build runs on this box (check `pgrep -fa deploy.sh` first; 67 GB
  > against 132 GB free), because T4 and T8 need it anyway. Not a reversal of the 2026-10-19
  > cleanup: the volume is a build artefact and comes back when a round needs it.
- [x] **T2 (fable) (effort: high): The build watcher, and what a client reads of it.** One more
  loop in the orchestrator, on the clock, beside the probes: **why the orchestrator and not
  a cron** — it is the one process that is always up, holds the store, the clock, the
  registry and the health route the platform polls every 30 s, and a scheduled script on the
  box would be a second writer with no door and no fake; the decision (37) says so. Every
  `EZPUG_IRON_GAME_WATCH_INTERVAL_MS` (default 15 min; a build is hours apart and Valve's
  endpoints are not ours to hammer) it reads **Steam's public build** — Valve's own
  `ISteamApps/UpToDateCheck/v1?appid=730&version=0` (`required_version`) first, no key,
  and `https://api.steamcmd.net/v1/info/730` (`data.730.depots.branches.public.{buildid,timeupdated}`)
  as the second reading when the first is silent; the task's first finding, read off the dev
  node, relates `buildid`, `appmanifest_730.acf` and `steam.inf`'s `PatchVersion` in one note
  in `docs/operations.md`, and the watcher stores whichever one a *server* can be asked for
  — and **the upstream releases of every pinned plugin** (GitHub releases API for
  `roflmuffin/CounterStrikeSharp`, `alliedmodders/metamod-source` via the mmsdrop listing
  or its tags, `Source2ZE/MultiAddonManager`, `ezpug/MatchZy-Enhanced`; anonymous with the
  60/h ceiling respected by backoff, or `EZPUG_IRON_GITHUB_TOKEN` when set). **The facts**,
  append-only in a new `game_facts` table (additive migration): `game.build_moved {from, to,
  observedAt, pins}` once per build, `game.upstream_released {repo, version, publishedAt,
  pinned}` once per release; and the current picture in one row per provider. **One GitHub
  issue per build**, titled `CS2 build <id> (<PatchVersion if known>)`, created on
  `build_moved` and *updated* (a comment, never a second issue) on every verdict and every
  upstream release it is waiting for; filed through the REST API with the token, and when the
  token is unset the fact and the health still move and the log says `no issue filed: no
  EZPUG_IRON_GITHUB_TOKEN` — a dev box files nothing. **The contract, Unreleased** (0.35.0 is
  T7's): `providerHealthSchema` gains an optional `game` block —
  `{ build: { id, since } | null, stack: string | null, canary: { state: 'green' | 'red' |
  'unproven', build, since, reason: string | null }, hud: the same shape }` where `stack` is
  the one opaque revision the image/template was built from (`ezpug-image.json`'s
  `revision`, `build.json`'s sha) and nothing else names a plugin; plus `GET /v1/fleet/game`
  (`fleet` scope) answering `{ build, upstream: [{ repo, pinned, latest, publishedAt }],
  providers: [{ id, game }], recent: gameFact[] }` with `gameFactSchema` its own small union,
  **never a member of `orchestrationFactSchema`** (the 0.16.0 lesson in Findings; decision
  37's second paragraph). The fake answers both with a `faults.gameBuild` knob the way it
  answers `providerDown`, so the conformance suite walks a build move against the fake and
  the real orchestrator alike; the watcher takes its `fetch` from outside and the test feeds
  it a scripted Steam and GitHub. Red first: a test that a build move writes one fact, one
  issue call, and flips `game.canary.state` to `unproven` for every provider that runs CS2;
  a second that the same build seen again writes nothing. `docs/match-api.md` gets the block
  and the route; `docs/operations.md` → Health gets the loop beside the probes.
- [x] **T3 (effort: high): The Dathost canary.** On `game.build_moved` for a provider whose
  servers Dathost updates itself, and on demand through `POST /v1/fleet/game/canary
  { provider, hud?: boolean }` (`fleet` scope, Unreleased in the contract until T7), the
  orchestrator plays **the match the owner ran by hand**: `pug`, `de_dust2`, 4 bots as rules
  (`bot_quota`, `warmup.minPlayersToReady: 0`, the platform's `test-match.ts` shape, composed
  here and never copied from there), 2 rounds, `requirements.provider: dathost`, on a key the
  orchestrator mints for itself at boot (`canary`, scopes `matches`, `maxConcurrentServers 1`,
  `maxServerLifetimeMinutes 10`, `monthlyCents` from `EZPUG_IRON_CANARY_MONTHLY_CENTS`,
  default 200) so the money has a wall that is not the task's good behaviour. **The verdict
  is per build**: `green` when `server_ready` came, the match went live and a `round_end` was
  heard; `red` with the reason sentence when the boot deadline fired or the server was lost
  — the reason is the last console lines through the provider's console door, the crash
  pattern named (`Engine2PreBreakpadDumpFunction`, `SIGNONSTATE_SPAWN`, `Failed to find
  signature`, `cs2_update_required`), never the whole log; `unproven` until one of those.
  **One canary per (build, hud) at a time**, a second trigger while one runs is answered
  with the running one; a red may be re-run on demand and the fact says which attempt. A
  red canary makes `healthy: false` with `lastError` naming the build and the reason, so the
  platform's existing tile goes red without learning a word of this round. **While a build
  is unproven or red the orchestrator keeps serving** (decision 38: there is no safe
  alternative to a match) **and refuses the HUD addon loader on its own** — `configure`
  writes no `HUD_ADDON_LOADER` and no `hudAddon` while the build's `hud` canary is not green,
  and `match.server_ready`'s `hello` then truthfully lacks `hud` — the T6 gate's first half.
  Red first on the fake Dathost: a build move → a canary match on the ledger → green; a boot
  that the fake fails → red with the reason → a request's `configure` carries no loader; the
  budget wall cutting a hanging canary. Then one real one: `POST …/canary` against
  production for build 11162119 (≤ 10 ¢, named), green in the health read on gs.ezpug.com,
  the issue from T2 commented. Puppets stay out of it: a canary is bots and rules, so the
  production key's `simulation` scope is not what guards it.
- [x] **T4 (effort: medium): The dev-node canary, for the image.** `pnpm cs2:canary [--boots 8]
  [--rows retakes,pug-2v1]`: takes the lane lock (the protocol in `docs/operations.md`, a
  ticket like every row), refuses while a container runs, brings the volume to Steam's
  public build if it trails (`cs2:install`, the "no delta" failure named by its cause, not
  retried), boots `ghcr.io/ezpug/ezpug-iron/cs2:dev` N times measuring time to
  CounterStrikeSharp's first line and to `server_ready`, fails on a hang past 60 s or any
  `Failed to find signature`, then plays the named lane rows through `iron-match.mjs` inside
  the same hold (`--lock-token`), and writes one verdict `{ build, image: build.json's sha,
  pins, boots: [...ms], rows: {...}, state }` to `.verify/cs2-canary-<build>.json` and one
  line to stdout. It is the verb T5 calls and the verb the HUD drill's steps 2–3 become;
  `docs/hud.md` → The drill after a CS2 update shrinks to pointing at it. Red first where
  behaviour exists to test (the verdict file's shape, the refusal while a container runs,
  the lock inheritance) on the fake; the real run is T1(c)'s eight boots done again by the
  verb, named in the progress line with its seconds.
- [ ] **T5 (fable) (effort: high): `pnpm game:follow`, and the policy of a patch.**
  `scripts/game-follow.mjs`: `pnpm game:follow css@1.0.378 metamod@1483 [mam@1.7]` is one
  idempotent verb — bump the homes (Dockerfile `ARG`s and shas fetched and verified,
  `Directory.Build.props`, the `docs/pins.md` rows rewritten from a template with the
  release's title and date) → `node scripts/check-pins.mjs` → `pnpm verify` → `pnpm cs2:build`
  → `pnpm cs2:canary` → `pnpm dathost:image` + `--check` → `POST /v1/fleet/game/canary` on
  the orchestrator it is pointed at and wait for the verdict → commit `chore(pins): …` (never
  push; the loop or a human pushes) → comment on the build's issue. Every step is a named
  phase printed as it runs, **`--dry-run` prints the plan and the diff and touches nothing**,
  a tree that is dirty, a lane that is held past `--lock-wait`, a sha that does not match
  the release page, a verify that is red, a canary that is red, or a template whose
  `--check` was red *before* the push (somebody else's hand on it, like #13) each stop the
  verb **by name** and leave the tree at the last green commit. Metamod is never followed
  alone: `metamod@NNNN` must be the build the named CounterStrikeSharp release builds
  against (its `libraries/metamod-source` submodule commit, read off the release's tag), and
  the verb refuses a pair that disagrees. **The policy** (decision 39, the owner's of
  2026-10-24): `EZPUG_IRON_GAME_FOLLOW=off|patch` (default `off`; `patch` lets the watcher's
  `upstream_released` be acted on unattended through `pnpm game:follow --auto`, which runs
  under the box's timer — a `systemd` user timer or a root cron line every 30 min, written
  into `docs/operations.md`, idempotent so a second run is a no-op). **"Patch" is decided
  exactly so:** for CounterStrikeSharp, the first two numbers unchanged and the third moved
  (`1.0.376 → 1.0.378`; every CounterStrikeSharp release is one of these, which is why the
  rule has a second clause), its release title or notes naming the CS2 version it fixes or
  containing "fix", and no "breaking", no "migration" and no API removal in the notes; for
  MultiAddonManager, the third number alone (`1.6.1 → 1.6.2` is a patch, `1.6.2 → 1.7` is a
  minor and waits); Metamod only as the build CounterStrikeSharp names; **MatchZy-Enhanced
  never** (a fork rebase is PRD-09 T6's kind of work). A minor or major, a MatchZy release,
  or any refusal above leaves the issue commented "waiting for a human: <why>" and the
  health unchanged. Unattended follows **only when both canaries are green**, the dev node's
  and Dathost's; a dev node that cannot be brought to the build stops the follow and says so
  (the open question below). Red first: the parser of versions and notes against a fixture
  of real release JSON (1.0.375, 1.0.376, 1.0.378, MAM 1.6.1/1.6.2/1.7, a MatchZy tag), the
  refusals by name, the plan of a dry run byte-stable. The real run: `pnpm game:follow
  css@1.0.378 metamod@1483 mam@1.7 --dry-run` on the T1 tree says "nothing to do" for every
  home and prints the plan it would have run; if upstream has shipped anything newer by
  then, one assisted run follows it for real (≤ 30 ¢, named) and that is the proof;
  otherwise the proof is the dry run plus the fake-release test, written plainly.
- [ ] **T6 (effort: medium): The HUD addon gate, and the switch back on.**
  `EZPUG_IRON_HUD_ADDON` is honoured only while the current build's **`hud` canary** is green
  — a second canary row per build, the same match with `hud: true`, which means the loader
  file *is* uploaded for that one match and the verdict reads MultiAddonManager's own lines
  (`[MultiAddonManager] Steam API Activated` and then a `server_ready`, not a breakpad) — so a
  build that kills servers with the loader never reaches a player with it, and a build no
  canary has seen with the loader is served **without** it (T3's refusal, now the whole
  gate; decision 40). On `build_moved` the `hud` canary runs after the plain one passes;
  `POST …/canary { hud: true }` runs it on demand. `GET /v1/fleet/providers` says it in
  `game.hud`; `docs/hud.md` → The three switches gains the fourth, the one nobody's hand is
  on. Red first on the fake: an addon id set, the hud canary red → `configure` writes no
  loader and the hello lacks `hud`; green → both present. The proof is the production
  switch: `EZPUG_IRON_HUD_ADDON` restored in `.env.production` from the `#13` backup,
  `./scripts/deploy.sh up`, the `hud` canary green on 11162119 (≤ 10 ¢, named), the lane's
  `hud-on` row green on the dev node inside a hold, and one Dathost match's hello carrying
  `hud`. Close #13 with the commit shas. A client's picture stays the owner's look
  (`docs/hud.md`, the look list).
  > from T3: the gate is `GameCanaries.hudAllowed`, asked by Dathost's `configure` only
  > (`hudGate`). The nodes provider still hands `EZPUG_HUD_ADDON` to every container, so
  > the dev node's `hud-on` row keeps working while a node's build has no canary (T4/T8).
  > Making the gate whole means deciding what a node's `hud` verdict is.
- [ ] **T7 (effort: medium): `@ezpug/match-api` 0.35.0, and what the platform takes.** One
  additive release: `providerHealth.game`, `GET /v1/fleet/game`, `POST /v1/fleet/game/canary`,
  `gameFactSchema`, the fake's knob, the conformance flow (`game-build-moves`), the JSON
  schemas and fixtures. `node scripts/release.mjs version 0.35.0`, `publish` to the box's
  Verdaccio (it runs `verify:extended` first), `smoke` reads 0.35.0, the tag cut and held
  like the others; `node /root/ezpug/scripts/packages-mirror.mjs` is **the platform's**
  step and runs over there in its bump commit, never here. The changelog section names the
  platform's PRD-24 and says in one paragraph what a 0.34.0 client sees against a 0.35.0
  server (everything it saw, plus a block it ignores). `docs/pins.md` → The images we
  publish quotes 0.35.0; `docs/match-api.md` carries the block and both routes with the
  words the platform may use (`build`, `canary`, `since`, `reason`, `stack`). **What the
  platform takes** (its PRD-24, written here so the two rounds agree on names): the pin bump
  as its own `chore(deps): match-api 0.35.0` commit after the mirror; the fleet tile and the
  console tile red on `game.canary.state !== 'green'` with the build id and the reason; an
  owner notification through its catalog on a red verdict and on `unproven` older than N
  hours (N is the platform's setting); `GET /v1/fleet/game` behind its admin door for the
  history; nothing else — no Steam, no GitHub, no plugin name over there.
- [ ] **T8 (effort: medium): The LAN node states its build.** The node agent reads the
  volume's `appmanifest_730.acf` `buildid` and `steam.inf`'s `PatchVersion` at boot and before
  every `start`, and the image's `build.json` (the pins it was built with, the sha), and says
  all three in its `hello` (`packages/protocol` additive: `hello.game { build, patchVersion }`,
  `hello.image { revision, pins: opaque }`, the C# untouched because the node speaks for the
  server here). The orchestrator folds it: a node whose game build is **not** the build the
  image's pins have a green dev-node canary for (T4's verdict, carried into the orchestrator
  by `game:follow` through `POST …/canary`'s sibling for nodes, or read off the image's label
  when the loop has none) is served — a venue has only the server it has — and the
  `nodes` provider's `game.canary` says `unproven` with the node and both builds in the
  reason; a node whose build is *older* than the image's pins were proven on (the volume
  fell behind) is `unproven` too, with "run `cs2:install` on <node>" as the reason. The
  agent itself logs the comparison at boot by name (decision 41: a node compares and tells,
  never refuses to start, never downloads). Rebuild and publish `node@0.2.0` and `cs2@0.2.0`
  through `release-image.mjs`'s tags (the first release since 0.1.0; `docs/pins.md` → The
  images we publish moves both rows), and `docs/nodes.md` gets "when the game updates": pull
  the new `cs2` tag, `cs2:install` on the node, what the hello says before and after. Red
  first on the fake node and the fake server: a hello with a newer build than the pins'
  proof → `unproven` with the reason; a matching one → green. The dev node on this box is
  the real one: its hello in the progress line.
- [ ] **T9 (effort: medium): The books, and the move rehearsed end to end.** `docs/pins.md`:
  the rows T1 wrote re-read once more, "Bumping one" rewritten as `pnpm game:follow` with the
  hand steps kept as what the verb does; `docs/operations.md`: a new section **"CS2 update
  day"** — what is now automatic (detection within 15 min, the issue, the two canaries, the
  loader gate, the patch follow when `EZPUG_IRON_GAME_FOLLOW=patch`) and the three things
  that still take a hand (a minor/major bump, a MatchZy rebase, a look at a client), with
  the dev-node section (`:169-190`) and the HUD drill (`docs/hud.md:89-116`) pointing at the
  verbs instead of repeating them; decisions 37–41 numbered and in the shape of 36;
  `docs/match-api.md` and `docs/nodes.md` as T7 and T8 left them; `ralph/OPEN-POINTS.md` §14:
  what no canary can see (a *human* `SIGNONSTATE_SPAWN` — bots spawn differently, and the
  2026-10-23 second crash was a human's; a client's addon download), honestly. **The closing
  checkpoint** is one scripted rehearsal, `pnpm game:rehearse` or the extended test
  `game.extended.test.ts`, against the dev world: a scripted Steam answers a new build →
  within one watcher tick the fact is written, the fake GitHub sees one issue, every CS2
  provider reads `unproven` in `GET /v1/fleet/providers` → the sim provider's canary plays
  and reads `green`, the `hud` canary follows → the fake GitHub sees two comments → a
  scripted release feed offers `css@1.0.379` (fictional) with a "Game Update" title →
  `game:follow --auto --dry-run` prints the plan it would run and names the policy that
  allowed it, and a `1.1.0` or `mam@1.8` prints "waiting for a human" — all on the fake
  clock, no rental, green in `verify:extended`. Then `./scripts/deploy.sh all`, smoke green,
  and `GET /v1/fleet/game` on gs.ezpug.com reading build 11162119 green on both canaries in
  the closing note.

## Working rules

- **Production is `./scripts/deploy.sh` and nothing else.** Never `docker compose -p <prod
  project>` and never `-f compose.prod.yaml` by hand, not even for `ps`: the dev world is
  plain `docker compose` in the repo. The box's `docker` shim refuses both with exit 125 —
  if you meet that refusal, you were about to touch production; use the deploy script's
  verb or leave it alone.
- **`pnpm dathost:image` is forbidden until T1(a) and T1(b) are committed**, and from then
  on runs only from a tree whose `check-pins` is green. The template is production; a wrong
  upload is every match dead for three minutes each.
- **The lane lock first, always** (`docs/operations.md`); the platform's loops share the CS2
  container. `cs2:install` only with the lane held and no container running. Give the lock
  back only after the server has left the fleet.
- **Money is named in every progress line that rented**, in cents, with the Dathost server
  id. A canary that left a server running is a P1 written before the next task, as always.
- **Never patch a vendor to make a canary green.** A plugin that does not load on a build is
  a pin to move or an upstream issue to file, never an edit under `plugins/vendor/` (the
  WeaponPaints data layer stays the one exception).
- **Secrets stay in the process.** The GitHub token, the Dathost password and the canary
  key's secret appear in no log line, fixture, issue body or progress note.
- **Nothing here edits a schema the platform owns**; a platform shape this round needs is a
  line in PRD-24, never a patch there. **Commit only your own paths; never `git add -A`.**

## Open questions (the owner's)

Answered 2026-10-24 by the orchestrating session, as the owner asked ("use your own judgement,
be ambitious"); each is a decision for T9's decisions log, not a question for the loop.

1. **A token for the container: yes, a fine-grained PAT, and the box's `gh` until it exists.**
   `EZPUG_IRON_GITHUB_TOKEN` is read by the orchestrator; T2 ships with the box's `gh auth token`
   written into `.env.production` by the deploy's preflight when the variable is unset (announced,
   never printed), so detection files its issue from day one. The owner mints a fine-grained PAT
   (`issues: write` on `ezpug/ezpug-iron` only) when convenient and replaces the line; the token
   is in no log, no fact and no health read.
2. **One canary is enough for the template, never for the image.** A Dathost-green patch may
   follow unattended onto the **template** when the dev node cannot reach the build within an
   hour (lane busy, "no delta"): that is what players sit on tonight. The CS2 **image** (LAN
   nodes) waits for the dev-node canary and a human, and the issue says so. T5 encodes the two
   gates separately (`--target template|image|both`); `--auto` is `template` alone when the dev
   node is unreachable, and says so in the issue.
3. **`off` until the rehearsal is green, then `patch`.** T5 ships `EZPUG_IRON_GAME_FOLLOW=off`;
   T9's rehearsal (a fictional release walked end to end) is the watched run, and flipping the
   production value to `patch` is part of T9's definition of done, recorded in its progress line.

## When the PRD is complete

0.35.0 is on Verdaccio; production runs this round with the template, the image and the
repo agreeing on 1.0.378 / git1483 / MAM 1.7 and `#13` closed; `GET /v1/fleet/game` on
gs.ezpug.com reads build 11162119 with both canaries green and the HUD addon honoured again;
the watcher ticks every 15 minutes with an issue it would file; `pnpm game:follow --dry-run`
says "nothing to do"; the dev node's hello states its build; `pnpm game:rehearse` walks a
fictional build move end to end on the fake clock inside `verify:extended`. The closing note
names the cents the round spent, what the platform's PRD-24 takes by field name, the three
answered questions as decisions, and what no canary can see (OPEN-POINTS §14).
