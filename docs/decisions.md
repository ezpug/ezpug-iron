# Decisions

The record of what the owner decided on 2026-09-05 when EZPug's gameserver side became
its own repo. This file wins every conflict inside this repo (the platform's
`specs-and-more/Project.md` still wins for the platform). A PRD task that finds a decision
wrong does not quietly work around it: it writes `> blocked:` and the next author revisits
it here.

## The shape

1. **Two repos, one contract.** `ezpug` (private) is the platform: people, queue, matches,
   stats, pages. `ezpug-iron` (this repo, public) is everything that touches a
   Counter-Strike server: the **orchestrator**, the **plugin SDK** and plugins, the
   **gamemodes**, the **node agent**, the **server image**, the **Dathost** adapter. The
   platform never speaks to a server, a provider or a plugin; it speaks the **Match API**
   the orchestrator serves, and nothing else. One contract crosses the repo boundary.
2. **The orchestrator is a separate service**, in this repo, in **TypeScript** (Hono +
   Postgres + Redis, the platform's idioms). The node agent is TypeScript too. The plugins
   and the SDK are **C#** on CounterStrikeSharp. The plugin↔orchestrator wire protocol is
   *internal* to this repo and may evolve freely; its C# types are generated from the Zod
   schemas so the two languages cannot drift.
3. **The contract is a published package.** `@ezpug/match-api` on public npm: the Zod
   schemas (the gameserver event vocabulary, the Match API resources and routes, the
   webhook envelope, the stream frames, the gamemode manifest), a typed client, the
   webhook verifier, the conformance fixtures, and an in-process **fake orchestrator**
   the platform's tests and seed run on. A contract change is a semver release both repos
   test against; the platform pins a version.
   *Amended by PRD-02 T38a, recorded here by T39: public npm is still the destination and
   `.github/workflows/release.yml` still publishes there off a `match-api@` tag, but no
   npm login exists on the box the loops run on — so a release goes to the box's own
   Verdaccio (`http://172.17.0.1:4873/`) the day it is cut, which is what the platform's
   pin resolves against, and to npmjs the day the owner logs in. The registry is a flag
   (`release.mjs publish --registry`), never a second package.*
4. **The gameserver vocabulary lives here now.** Match.md §5's normalized event union
   (`packages/contracts/src/gameserver.ts` in the platform at the time of the split) is
   copied verbatim as v1 of the vocabulary in `@ezpug/match-api`; the platform re-exports
   it from the package. Same JSON, one source. The orchestrator relays that union; the
   plugin speaks it natively; MatchZy is translated into it once, at the edge.
5. **Every server dials out.** The EZPug core plugin opens one persistent outbound
   WebSocket to the orchestrator on boot — Dathost servers, node-hosted servers and the
   dev container alike — and carries everything both ways: events, heartbeats, commands,
   assignments, player commands, profile pushes. No inbound port anywhere, NAT-proof, one
   protocol. RCON exists only as an operator fallback.
6. **Events reach the platform two ways.** Durable events (round end, map result, deaths,
   chat, bomb, demo uploaded, orchestration facts like allocated, ready, recovering,
   failed, ended) are **signed webhooks** with retries, a per-match sequence number and an
   idempotency key, replayable from `GET /v1/matches/:id/events?cursor=`. Ephemeral ticks
   (positions, bomb carrier) go over **one stream** per match the platform subscribes to
   and may miss without harm. Mirrors the platform's ephemeral switch.
7. **The orchestrator enforces money.** Every API key has a maximum of concurrent servers,
   a maximum server lifetime and a monthly euro ceiling the orchestrator refuses past,
   independent of Dathost's own account cap. Every allocation is a ledger row it closes; a
   reaper ends anything past its lifetime whether or not the client ever says stop.
8. **The orchestrator is the platform's only provider.** The platform's own provider layer
   (selection tiers, reaper, registry, in-process simulator provider) collapses; what stays
   platform-side is what is genuinely platform: match config decisions, the artifact
   producer, the translation of Match API facts into machine events. Nothing in the
   platform knows Dathost exists.
9. **The simulator ships here as the `sim` provider.** The platform's simulator engine
   (story, assignment, record, scenarios) ports into this repo. The real orchestrator runs
   in the platform's dev world in sim mode (a pinned image in its compose), so every
   platform loop exercises the real Match API. The in-process fake in `@ezpug/match-api`
   embeds the same engine on an injected clock for unit tests and the history seed.
10. **Demos land in the platform's storage.** A match request carries a presigned PUT into
    the platform's `demos` bucket; the core plugin uploads straight there (MatchZy's own
    uploader posts a form, so the plugin owns the upload) and the orchestrator relays a
    `demo.uploaded` fact with size and hash. The orchestrator never stores a demo byte.
    Backups are small and live in the orchestrator's own database.
11. **Deployed on the same box, its own compose project, its own Traefik file.**
    `gs.ezpug.com`, its own Postgres and Redis, its own `deploy.sh` with backup, migrate,
    smoke. Everything reaches it over public TLS, the platform included: dev and prod paths
    are identical and nothing couples through docker networks.
12. **API only; the platform's admin console is the face.** Fleet, ledger, budgets,
    nodes, live console: all read and driven through the Match API by the ezpug admin
    console. A CLI (`ezpug-iron`) serves operators at a terminal. No UI in this repo
    beyond gamemode widgets.
13. **Public repo, public npm, public ghcr.** Written as if strangers read it, which they
    can. Secrets live only in env, the token store and process memory.

## Gamemodes

14. **A gamemode is a manifest served by the orchestrator.** `gamemodes/<id>/manifest`
    declares: `game`, the tier, plugins to enable, cfg to exec, allowed maps (catalog ids
    or workshop ids), player slots and team shape, who owns match flow
    (`matchzy | plugin | none`), what it records (`demo | events | none`), its capabilities
    (positions, chat, player commands, widget), DE+EN title and description.
    `GET /v1/gamemodes` publishes the catalog; the platform caches it and shows it. The
    platform's reference data names only the queue's default gamemode (`pug`).
15. **Three tiers, each proved by a real mode this round.** *Config only* — `flying-scoutsman`
    (stock CS2 mode by cfg on the normal maps, no plugin at all). *Community plugin* —
    `retakes` (B3none/cs2-retakes under the SDK: its own flow, its own map pool, one group
    of ten rather than two teams since decision 27, events without a demo). *Custom SDK mode* — `powerup-dm` (an original deathmatch where a phone
    button grants one power-up per life), exercising player-scoped commands, per-player
    state and a widget end to end. `pug` (5v5, MatchZy-driven) is the default and the
    queue's only mode.
16. **One image, the manifest toggles plugins.** Every plugin is baked into the single
    server image and the single Dathost template; on assignment the core plugin enables
    exactly what the manifest names (CounterStrikeSharp hot-loads), execs its cfg and
    changes to its map. Gamemode bundles fetched at boot and per-mode images were both
    rejected.
17. **A custom gamemode ships a web component the platform embeds.** The gamemode bundle
    includes a built widget (Vue `defineCustomElement`, built by this repo's
    `gamemode-kit`); the orchestrator serves it; the platform mounts it in a sandboxed
    frame and injects the design tokens as CSS custom properties, the locale and a player
    token. The widget opens **its own socket to the orchestrator** with that token
    (scoped to one match and one SteamID); taps become player-scoped commands relayed to
    the plugin. Gameplay traffic never touches the platform; the platform still receives
    every durable fact by webhook.
18. **`game` is first-class, CS:GO is refused at runtime this round.** `cs2 | csgo` flows
    through the Match API, manifests and capability matching; no provider advertises
    `csgo` yet, so a request gets a clean no-capable-server refusal. CounterStrikeSharp is
    CS2-only; CS:GO would be SourceMod + Get5 and is a later round.

## Inside the server

19. **Stock MatchZy, pinned; the core plugin beside it; fork the day a hook is missing.**
    *(Since PRD-03 T2 the pinned MatchZy is MatchZy-Enhanced, upstream's release, uncustomised.)*
    MatchZy owns match flow for `pug` (`going_live`, `round_end`, `map_end`, `series_end`);
    the core plugin owns what MatchZy cannot see (players, deaths, bomb, positions, chat,
    heartbeat, backups, the gamemode loader, the link). Neither double-speaks the other's
    events. MatchZy's events reach the orchestrator over its **HTTP remote log**, which
    points at the orchestrator and is translated into the vocabulary once, at the edge.
    *Amended by PRD-02 T9, recorded here by T39: the original sentence read "prefer
    MatchZy's in-process forwards over its HTTP remote log where they cover an event".
    Reading the pinned MatchZy (0.8.15) settled that there are no in-process forwards to
    prefer — `events_and_forwards.md` documents the remote log and nothing else, and
    `PublishEvents.cs` is one POST per event with one custom header, a 15 s timeout, no
    retry and no dedup. The fallback branch is the whole path: the plugin subscribes to
    nothing of MatchZy's, and the orchestrator owns the retries and the dedup MatchZy
    does not have.*
    *Amended by PRD-03 T2, 2026-09-19: **the day came, and the fork is somebody else's.**
    The image ships [MatchZy-Enhanced](https://github.com/sivert-io/MatchZy-Enhanced)
    (MIT, a fork of MatchZy; `docs/pins.md` holds the release and its sha256) where it
    shipped stock 0.8.15. Three reasons, each one a hook stock does not have: the
    2026-09-18 stall showed that ready-up had never run outside production, and only a
    **simulation mode** — bots as rostered players that ready up through MatchZy's own
    ready system — lets a test take the path a human takes; the **ready events**
    (`player_ready`, `team_ready`, …) are what a client needs to draw who is ready; and
    the **side-pick timer** ends a knife round nobody answers. Owner decision the same
    day: **we pin upstream's release binary and do not customise it** — one maintainer
    shipped five releases on 2026-09-16, so the checksum is the point and nothing
    unpinned reaches a server. A fork of our own stays the escape hatch for a task that
    cannot be done without a patch; that task records why and files the change upstream
    first. "One MatchZy, everywhere": the build a test proves is the build production
    runs, and simulation is a per-match switch, never a second binary.
    What reading it against 0.8.15 changed in the paragraph above: **the fork retries.**
    A remote-log POST that is not answered 2xx is queued in the plugin's own SQLite file
    and re-sent for up to twenty attempts over hours, byte-identical and out of order, to
    whatever URL and header are current *then* — so the orchestrator's dedup stays, and a
    refusal from the door is no longer the end of an event. **It also reaches out by
    itself**, which stock never did: a Steam update check that is on by default, a
    heartbeat, a bootstrap fetch that executes the console commands it is sent, an admin
    list, a match report. The end of the shipped `cfg/MatchZy/config.cfg` is ours
    (`docker/cs2/cfg/MatchZy/ezpug.cfg`) and keeps each one off;
    `docker/cs2/matchzy-cfg-check.sh` is the list, the image build fails over the file as
    it ships, and `cs2-image.test.ts` fails over ours. **And it waits for the roster**: a
    loaded match does not start until every rostered SteamID is connected and on its
    side, `.forceready` included, so the platform's join deadline is the only thing that
    gives up on a missing player. Map veto is gone from the fork; the platform runs the
    veto (`skip_veto`), so nothing of ours used it.*
    *Amended by PRD-03 T3, 2026-09-20: **the fork's twenty-six new events, classified
    once.** "Neither double-speaks" needed an answer per name, and the arbiter was what a
    real `pug` put on both wires at once — `real-pug-matchzy.json` beside
    `real-pug-link.json`. Three answers, all in
    `apps/orchestrator/src/matchzy/translate.ts`. **Vocabulary**, because nobody else says
    it: the ready gate (`player_ready`, `player_unready`, `team_ready`,
    `all_players_ready`) and the knife pair, added to `@ezpug/match-api` 0.12.0 as six
    types — the gate is the match plugin's own judgement and a client must draw it rather
    than recompute it, which is the lesson of the 2026-09-18 stall. **`round_started`
    too**, and finding out why was the task's one product bug: `MatchZyFlow` emits only
    what MatchZy cannot see (pauses, `side_swap`, backups) and `GenericFlow` — the plugin
    flows — was the only thing that ever emitted `round_start`, so a `pug` had no round
    start in its durable log at all. **Dropped because the core plugin already says it**:
    `player_connect`, `player_disconnect`, `side_swap`, the pause pair and the two
    `*_requested`. **Read for the log and never a fact**: `server_configured`,
    `server_health`, `test_event`, `cs2_update_required` — server-level, and the last two
    worth a warning, because T2's cfg check exists to make them impossible. And
    **`warmup_ended` is not vocabulary** though it looked like a candidate: the fork sends
    it from two places and both are immediately followed by the event that says the moment
    better (`knife_round_started`, `going_live`), and the durable log must not hold two
    facts a millisecond apart for one moment. A test reads the pinned clone's own
    serialisers, when it is on the box, and fails if the fork ever adds a name nobody
    classified.*
    *Amended by PRD-03 T3a, 2026-09-20 (owner decision, 2026-09-19): **what a real match
    turns on.** The fork has player features stock never had, and the question each one
    asks is who owns it — the box or the request. Two are the **box's**, because no match a
    client can build may hold a server until a human notices or end in a way its client
    cannot record: the **side-pick timer** (`matchzy_side_selection_enabled`, 60 s) ends a
    knife round whose winner never answers by picking a side at random, and **`.gg` and
    forfeit-on-disconnect stay off** (`matchzy_gg_enabled`, `matchzy_ffw_enabled`) until
    the Match API has a forfeit result to record them with. One is the **match's**:
    `rules.warmup.autoReady` (additive, `@ezpug/match-api` 0.13.0, default **on**) becomes
    `matchzy_autoready_enabled` in the match config, which MatchZy applies before warmup
    and puts back at series end — a LAN admin who wants the room to type `.ready` asks per
    match, and the server between matches readies nobody. `docker/cs2/matchzy-cfg-check.sh`
    grew the second half it needed for this: a switch that has to be **on** fails the same
    way as one that has to be off. And the reading that decided the default: **auto-ready
    decides who has said yes, never whether the match may start.**
    `CheckAndAutoReadyPlayers` only simulates the command a couple of seconds after a
    player picks a side; `IsLiveRequirementSatisfied` still wants every rostered SteamID
    connected and on its configured side and still wants `min_players_to_ready` — so the
    platform's join deadline remains the only thing that gives up on a missing player,
    `.unready` opts a player out until they type `.ready` again, and turning auto-ready on
    loosened no gate.*
    *Amended by PRD-03 T7a, 2026-09-20: **the fork's own console is a read channel, and
    the only one it has.** "Neither double-speaks" has a second half nobody had needed yet:
    neither may hold a *second opinion* about a fact the other owns. Simulation mode decides
    which bot plays which roster entry and keeps it in a private dictionary
    (`simulationPlayersByUserId`); its `player_connect` payloads carry the rostered SteamID
    but not the body, and its remote log leaves the process over HTTP. So the core plugin
    saw plain bots for a whole `pug`: nothing announced, an empty presence map, `kick` and a
    widget tap refused `player_not_in_match`, deaths crossing the link under synthetic ids
    while MatchZy's stats carried the rostered ones. **Inferring the mapping from arrival
    order was the tempting fix and is exactly the forbidden one** — two plugins holding two
    opinions about who is on the server, which is the 2026-09-18 stall's shape.
    CounterStrikeSharp runs both in one process and therefore one `Console.Out`, and the
    fork says every decision on it, so the plugin reads it there: `ConsoleTap` passes the
    console through untouched, `SimulationLog` transcribes the three lines that announce or
    free a mapping, and `MatchZyPuppets` casts the body each one names
    (`IGameWorld.Recast`, a cast that arrives after the body did). A test renders those
    format strings out of the pinned clone and parses them, so a release that rewords one is
    a red test rather than a silent room of anonymous bots, and `matchzy_debug_console` is an
    invariant of the image with a line in the cfg check. A SteamID the request never rostered
    is refused rather than invented.*
    *Amended by PRD-04 T2b, 2026-09-23 (owner decision the same day): **we carry our own
    fork after all.** Seating a person beside puppets in a `pug` (decision 28) cannot be done
    without a patch: upstream's simulation mode spawns a bot for every configured player,
    readies both teams on everybody's behalf and force-starts from its watchdog. So the
    escape hatch this decision kept open is taken, and taken narrowly.
    [`ezpug/MatchZy-Enhanced`](https://github.com/ezpug/MatchZy-Enhanced) is a fork of
    upstream (now `Auto-Tournament/cs2-plugin`): one upstream release tag and a short series
    of `ezpug:` commits on its `ezpug` branch, and nothing else. The series is the smallest
    patch that does the job. A roster entry may say `{ "name", "simulated": false }`, and
    such a seat gets no bot. With such a seat nothing marks a team ready on anybody's behalf,
    so the ordinary gate in `IsTeamReady` waits for the person's body. And the watchdog never
    force-starts such a match. The fork's own workflow releases a zip in upstream's layout
    from a `v<upstream>-ezpug.<n>` tag, and the image pins it by sha256 as it pinned
    upstream's binary. The rest still holds. It is the same binary for a test and for
    production, simulation is still a per-match switch, and nothing unpinned reaches a
    server. `docs/operations.md` ("MatchZy-Enhanced, our fork") says how the series is
    rebased onto a new upstream release. Not chosen: a PR upstream first and a wait for it
    (the maintainer's release pace is not ours, and the platform's PRD-11 T23 was waiting);
    a copy of the source vendored into this repo like WeaponPaints (the fork is a binary
    with its own tests and release, and a patch series on a tag is what makes a rebase
    cheap). The series sits on a public branch of a public fork, so upstream can take it
    whenever it likes. It has not been offered as a PR yet.*
20. **Skins travel over the link, no exposed MySQL.** The platform owns loadouts; a match
    request's roster entries carry them; a **data-layer fork of cs2-WeaponPaints** takes
    the in-memory loadout the core plugin hands it instead of querying MySQL. No public
    database, and a LAN with no internet still has skins. The platform's Skins.md is
    amended accordingly.
21. **EZ Rating shows on the scoreboard, Premier-style.** The core plugin sets
    `CompetitiveRanking` / `CompetitiveRankType` from the roster's rating so the scoreboard
    shows EZ Rating where Premier shows its number. Clan tags, chat lines and HUD cards were
    considered and not chosen.
22. **Branding this round is hostname and chat.** Branded hostname per gamemode and event,
    coloured chat prefix and team names, a connect card. In-world banners need a Steam
    Workshop addon players download and are a later round.
23. **Self-hosted capacity is a node agent with a warm pool.** `ezpug-node` on any docker
    host enrols with a one-time token, reports capacity, starts and stops server containers
    from the one image on demand and keeps N idle warm instances. The orchestrator treats a
    node exactly like Dathost: a provider with capacity and a price of zero. During a live
    event the platform asks for `lan` and nodes win.
25. **Puppets are a per-match switch behind a scope, and every fact of theirs says so.**
    (PRD-03 T4, 2026-09-20.) A match request may carry `simulation: { scenario?, timeScale? }`
    and the server plays it with simulated players in every roster entry's seat — bodies
    that carry the rostered SteamIDs, connect, ready up through the match plugin's own
    ready system, play and leave by the doors a human takes — so the path the owner's
    bugs sat on is the path a test takes. Five rules: **who may ask is a key scope**,
    `simulation`, that no route requires and `POST /v1/matches` checks against the body
    before anything else about it; a production platform key never holds it, so a real
    match cannot become a simulated one by accident, and asking without it is `forbidden`
    with the scope named. **Whether a mode can is a manifest capability**,
    `capabilities.simulation`, refused `validation_failed` at the door rather than a server
    waiting in warmup for people who are never coming; `pug` claims it because
    MatchZy-Enhanced reads the switch from the match file (decision 19: one binary, a
    per-match switch), the SDK modes claim it when the SDK seats a puppet (T7). **A
    simulated match is still money**: the same ledger row, budget check and reaper as a
    real one, on Dathost as on a node. **Every fact says so**: `Match.simulated` and
    `source.simulated: true` on every gameserver event, stamped by the orchestrator at its
    one ingest funnel whatever the server said, so a consumer reads one field and never
    the request; a `sim`-provider match that did not ask carries neither — its players are
    the simulator's inventions and its `provider` has always said so. **One scenario
    language**: `simulation.scenario` names a story from the same catalog the simulator
    plays, so a scenario is one thing with one name on the sim and on a real server, and a
    knob a real server cannot execute is listed as sim-only rather than ignored. What was
    not chosen: a list of the humans among the puppets — the fork fills every seat or none,
    and a contract field a server cannot honour is a lie; a separate scenario catalog for
    real servers — two names for one story is how the two drift; marking every
    `sim`-provider match `simulated` — the platform's dev world plays its boards on those,
    and a flag that changed what they count would be this repo deciding the platform's
    bookkeeping.
    **Amended by PRD-03 T7, 2026-09-20: outside MatchZy the SDK seats the puppets, and a
    team is the roster's word.** For every flow but `matchzy` the runtime's puppeteer asks
    the engine for one bot per roster entry and casts each *before* the SDK first names it
    (`IGameWorld.Casting`), because a player's identity is fixed at its first hook; the bot
    then is that roster entry on the wire — SteamID64, name, team, announced, kickable,
    tappable. A plain bot is never rostered and never announced, and the two are never
    converted into each other. The capability is therefore any flow's to claim
    (all four bundled modes do, `retakes` since decision 27). With it, `ServerSlot`
    gained `unrostered`: `team_a`/`team_b` are the roster's word, a body the request never
    named is `unrostered` on a side and `spec` on none. Not chosen: keeping the guess by side
    (it put a stranger on a team's sheet, and in a one-team mode called everybody `team_a`);
    a boolean beside `team` (two fields that can disagree); casting under MatchZy as well —
    the fork keeps a private map of which bot is who, and a second opinion about it would
    be two names for one body (T7a asks how to read theirs instead).
    **Amended by PRD-03 T7a, 2026-09-20: under MatchZy the fork seats them and the plugin
    reads its mapping.** The answer T7 left open is not a second opinion but the fork's own
    words off the shared `Console.Out` (decision 19's last amendment), applied with
    `IGameWorld.Recast` — a cast that arrives after the body did, because the fork decides
    seconds after the bot spawns. So a puppet is a rostered player on every flow now: the
    `drop` row of the CS2 matrix takes a `kick` for the rostered SteamID and no row of it
    types anything at a match.
    **Amended by PRD-04 T3, 2026-09-22 (owner decision, 2026-09-21): production's platform
    key does hold `simulation`.** The original sentence read "a production platform key
    never holds it". The owner pressed the admin console's "test match with puppets"
    against production — the whole point of its fleet door — and got `forbidden`, and the
    scope was appended to the live key by one `UPDATE`, because no route and no CLI verb
    could do it. Both now exist (`PATCH /v1/keys/:keyId/scopes`, `ezpug-iron keys scopes`)
    and the key table is never edited by hand again. The rule the sentence was protecting
    survives in the two places that actually carry it: the block is never implied, so a
    request is a rehearsal only by carrying `simulation` explicitly, and every fact of such
    a match says `source.simulated` — the scope says who may *ask*, and the platform's own
    `puppets` flag decides what counts.

26. **A mode with nothing to win declares a length, and the SDK ends the match.** (PRD-03
    T9, 2026-09-20; `OPEN-POINTS` §1.) Production's first seven `powerup-dm` rooms never
    finished: a free-for-all has no condition that ends it, so a rented box billed until a
    human released it and the mode read as "the match never started" while working
    perfectly. The manifest's `length` — `durationSeconds`, `fragLimit`,
    `idleTimeoutSeconds`, whichever first — is a vocabulary every such mode inherits, and
    the SDK enforces it (`MatchLength`) rather than each mode or an engine cvar, because
    only the SDK can say *why* it ended: `map_end` and `series_end` carry `reason`
    (`time_limit`, `frag_limit`, `idle`), `going_live.length` carries what is in force for
    a client to count, and the machine ends the match `completed` and releases the server
    as after any series — from `ready` too, when nobody ever came. Three rules under it:
    **no server timestamp travels** (the countdown is seconds from the fact's arrival, with
    a simulated match's time scale already divided out); **a plain bot is nobody** for the
    idle clock, a puppet is somebody; and **a one-team mode names no winner**, whoever
    ended it. It is never MatchZy's match to end (a `matchzy` manifest with a `length` does
    not parse), and `ttlMinutes` stays the backstop it always was, no longer the design.

27. **`retakes` is one team of ten, and every bundled mode seats puppets.** (PRD-03 T10,
    owner decision 2026-09-19.) The manifest said `teams: 2, teamSize: 5`, which was a
    guess copied from `pug` and wrong about the mode: cs2-retakes builds an attacking and
    a defending side out of one pool every round by its own ratio, so no EZPug team
    survives a round, and the win panel's leading *side* was being reported as the winner
    of the map — `open-join`'s recorded golden named `team_a` the winner of a retake for
    as long as it existed. `slots.teams: 1, teamSize: 10` says what the mode is, keeps
    `openJoin`, and costs the plugin's own head count nothing (`MaxPlayers` is
    `teamSize × teams`, ten either way, `match-config/retakes.ts`). `GenericFlow.Winner`
    already named nobody for one team (decision 26), so the manifest was the whole change
    — a one-team mode is **not** a synonym for a free-for-all, it is "EZPug has one group
    here and the sides are somebody else's to arrange". With it the mode claims
    `capabilities.simulation`, the last of the four to do so: the doubt was cs2-retakes
    keeping bots out of its *queue* (`QueueManager.AddConnectingPlayer` returns at
    `IsBot`), and the answer is that nothing seats a puppet through that door — the SDK's
    puppeteer asks the engine, and the plugin's team hook, which has no bot filter, takes
    the body into its active players like anybody else. Measured, not reasoned: the CS2
    matrix's `retakes` row is three puppets playing a match out and ending it on
    `mp_maxrounds`. Not chosen: leaving the shape and special-casing the winner in the
    flow (two opinions about one mode); `teams: 1, teamSize: 5` (it would have halved the
    server's head count through `MaxPlayers`).

28. **A mixed roster names its puppets, and a mode claims the capability only when a real
    server seats it.** (PRD-04 T2, 2026-09-22; for the platform's PRD-11 T23, "the owner in
    the chair".) Decision 25 filled every seat or none, so the owner could rehearse the
    queue with ten puppets and could never be the tenth player. `simulation.puppets?:
    SteamID64[]` names the roster entries that are puppets, and the rest of the roster are
    people who come in through the mode's ordinary door. Unsaid means everybody, which is
    what every request written before the field meant. A second manifest capability,
    `capabilities.mixedRoster`, says which modes can seat such a room, and the door decides
    it once for the fake and the orchestrator (`matchSimulationProblem`): a name the roster
    does not hold, or a partial list to a mode without the capability, is
    `validation_failed` on `simulation.puppets`. The three modes the SDK seats claim it,
    because the puppeteer casts only the named entries and never casts a bot that turns up
    later as the person. On the simulator the person's chair stays empty. The match is
    simulated however many people play in it: `source.simulated` is on every fact, the
    human's included, because the scope and the request decided what the match is, not who
    turned up. **`pug` does not claim it.** MatchZy-Enhanced at the pin is a boolean switch.
    It spawns one bot per configured player, kicks a bot it did not map outside simulation
    mode, and force-starts from its own watchdog whether anybody came or not. Decision 19
    never patches it, so the half the platform wants most (the 5v5 queue) waits on an
    owner call (`OPEN-POINTS` §7, PRD-04 T2b). Not chosen: a `'all' | steamId[]` union (the
    C# codegen has no anonymous unions, and an absent field says "all" without a second
    spelling); seating our own puppets beside a plain MatchZy match (the fork kicks them as
    "not a player in this game"); claiming the capability for `pug` because the schema
    parses (a contract field a server cannot honour is a lie, as decision 25 said of the
    same list).
    *Amended by PRD-04 T2b, 2026-09-23: **`pug` claims it.** The owner chose a fork of our
    own (decision 19 as amended). With the fork's patch series a `pug` seats a bot only for
    the entries `simulation.puppets` names. The orchestrator writes the rest into MatchZy's
    match file as `{ "name", "simulated": false }`. The fork holds the warmup until the
    person's body is on their side and ready, and the watchdog never starts without them.
    The lane proves the half a box without a CS2 client can (`mixed-pug`). Nine puppets
    ready up, and the warmup holds through every watchdog pass, past the point where
    upstream would have force-started. Then the row cancels it, as a client does for a
    no-show. The other half, a person taking the tenth seat and the match going live, is
    upstream's ordinary path for a human (connect, team, auto-ready, `IsTeamReady`), which
    the series only stops skipping. Nothing on the lane can walk it: a plain bot is never
    counted at MatchZy's gate, by the engine (no `player_connect_full`) and by the fork
    (its team hook skips bots). So that half is the first thing a person proves, and the
    platform's PRD-11 T23, the owner in the chair, is that person (`ralph/OPEN-POINTS.md`).
    Not chosen: patching the fork to count a plain bot at the gate so that the lane could
    stand one in (any `bot_quota` bot could then take a person's seat). On the simulator
    the person's chair stays empty and a `matchzy` match is held at the gate, as before. Every catalog mode that seats puppets now seats a
    mixed roster, so the refusal of a partial list stands in the contract for a mode that
    cannot, and no mode we ship is one.*

29. **A command's answer is the match software's, not the relay's.** (PRD-04 T4 and T8,
    2026-09-22/23; `OPEN-POINTS` §6.) `css_forcepause` ran, MatchZy returned early at
    halftime and said so only in chat, and the core plugin answered `applied` because the
    command had run. The platform's admin console builds its receipts on that answer, so
    it showed a match as paused when it never was. Now `applied` means the match software
    did it. The plugin relays the verb, holds the answer (`CommandAnswer.Deferred`, well
    inside the orchestrator's fifteen-second deadline, so the client's HTTP call is still
    open) and watches the engine for a beat. It answers `applied` once the gamerules turned
    over, and `invalid_state` otherwise, with a reason word in front of the message (a
    closed, documented set: `halftime`, `post_game`, `timeout_active`, `round_over`, …).
    `restore` on a live match (T8) is the second verb with this answer. It is `applied` once
    a round has started again at the backup's rounds played, never when the rounds-played
    count moved, because on hardware the engine took the rounds back and then sat in
    RoundOver for good. Three rules under it. **The reason is a diagnosis, never the
    verdict**: an unknown engine phase reads `unknown`, not "not halftime". **A state
    observation cannot judge is refused up front** without sending the verb (a pause of a
    match that is already standing, a restore in the gap after a round), because watching
    cannot tell "it was already so" from "it became so", and a restore in that gap does
    harm. **The fact still follows**: the server emits it before it answers, and it
    reaches the stream moments after the answer, never before. Not chosen: new error codes
    (the error vocabulary is closed and a code is a schema change, while a word in
    `message` is not); answering `accepted` and settling it later on the stream (the beat fits inside the
    call, and a client with `applied` in hand needs no second read).

30. **An SDK timer keeps its grid, and a stall skips.** (PRD-04 T5, 2026-09-22;
    `OPEN-POINTS` §4.) `GameThreadClock.Every` re-armed at `now + interval` on the frame
    that fired it, so every beat carried a frame of overshoot, and the position stream's
    100 ms was 108 ms at 128 fps. A repeating timer now re-arms at the first point
    `due + interval·k` after the firing frame. A beat is up to a frame late, never early,
    and the lateness never adds up. A frame that arrives a whole period or more late fires
    the timer once and drops the beats it swallowed. It never fires a burst to catch up.
    The price
    is written down in `docs/sdk.md` ("Timers"): the beat after a late one can come less
    than a period after it, because the grid is kept, not the gap. `FakeClock` keeps
    visiting every due instant, so the harness has no stalls and a test's arithmetic stays
    exact. Measured on the dev node: 97.2 ms against a 7.8 ms frame. Not chosen: catching
    up beat by beat after a stall (a burst of beats owed to nobody).

32. **A workshop map is hosted by its id, and a client hears the name it sent.** (PRD-05
    T1 and T2, 2026-09-24/25; [#3](https://github.com/ezpug/ezpug-iron/issues/3).) The
    platform names a workshop map `workshop/<id>/<name>`, and that grammar stays. The
    orchestrator passed the string on as it was, and the engine hosts a workshop map only
    by its bare published-file id. The loader ran `changelevel workshop/…` and MatchZy
    fell back to `changelevel` behind `IsMapValid`, so a node never loaded AIM Map. The
    match sat silent until the platform's own five-minute cancel. Now the wire keeps the
    platform's string, and the server side translates it **once per language, at the edge
    that speaks to the engine**: `MapIdentifier` in the SDK for the loader
    (`host_workshop_map <id>`), and the orchestrator's MatchZy config builder for
    `maplist` (the bare id, which is what MatchZy's `long.TryParse` hosts). The engine
    then names the map itself (`aim_map`), never by the id, so before `matchzy_loadmatch`
    the loader writes that name into `maplist[0]` when the entry is the id it just hosted.
    A series' later maps keep their ids. What a client reads follows one rule: **a fact
    about the plan names the map the way the plan did**. `going_live.map` and `map_end.map`
    are `maps[mapNumber - 1].map` on every flow (the MatchZy translator and the SDK's
    generic flow alike). **A fact about the server names what the engine loaded**:
    `server_ready.map` says `aim_map`. For an official map the two are the same string.
    The hostname shows the plan's `<name>`. Three rules under it. **A test on each side
    feeds the wire's own spelling**, never a hand-shortened id, because the old tests fed
    `3070923343` and agreed with the bug. **A workshop map runs with the console filter
    off**: CS2 refuses most commands on a workshop map ("DISALLOWED WORKSHOP CONVAR"),
    which dropped MatchZy's `live.cfg` and `tv_enable`, so the image starts with
    `-disable_workshop_command_filtering` and the Dathost provider sets the same switch.
    **A server that never gets ready says why** (T2): `SERVER_READY_DEADLINE_MS`, three
    minutes from `configuring`, fails the match `provider_error` with the map and what
    the provider and the link last saw. The deadline is shorter than the platform's cancel
    and about 18 times AIM Map's cold download on the dev node (112 MB in about 9 s).
    Not chosen: the engine's name in `going_live.map` (the wire cannot know it before the
    download, and the platform would have to learn a second name for a map it picked); a
    workshop spelling of its own on the wire, such as a bare id (a contract change with no
    gain, since the platform's grammar was already right).

## How the rounds run

24. **Spine first, then two loops in parallel.** `ralph/PRD-01-spine.md` (this repo, ~10
    tasks, about half on Fable) settles the contracts, the fake, the fixtures and the first
    publish, alone. Then `ralph/PRD-02-iron.md` here (~40 tasks, ~30% Fable) and the
    platform's `ralph/PRD-09-iron-platform.md` (~32 tasks, ~15% Fable) run at the same
    time, one screen session each, in two repos. Contracts are frozen after the spine; a
    contract change during the parallel rounds is a **release from this repo** with a
    changelog line, and the platform loop picks it up by bumping the pin — never by
    editing a schema on its side.

31. **The CS2 lane is a queue: whoever asked first goes first.** (PRD-04 T1, 2026-09-22;
    [#1](https://github.com/ezpug/ezpug-iron/issues/1).) The two loops share one dev CS2
    install under one lock file, and the lock had no fairness. On 2026-09-21 the platform's
    lane waited 1,902 s across six handovers, because each row of our matrix is a new
    process born the moment its predecessor lets go, and it won the race every time. A
    waiter now drops a ticket `<sinceMs>-<token>.json` into `<lock>.queue/`, and nobody
    creates the lock while a living ticket older than theirs exists. The page both sides
    implement is `docs/operations.md`, "The lane lock". Four rules under it. **A ticket
    dies by the lock's own corpse rules** (a dead pid on this host, older than 90 minutes,
    or not this JSON), so there is one definition of "gone". **A wait stays below that
    TTL**, because a ticket ages from the moment it is dropped. **The directory is never
    removed**, so no ticket can lose a race with an `rmdir`. **There is no handover
    interval**: a released lane may idle for one 5 s poll, and nobody can take it in that
    gap. The lock file is unchanged, so a side that knows no queue still waits and is
    still waited for. It just gets no fairness. The platform's PRD-11 T21 implements the
    same page. Not chosen: a handover pause after every release (the PRD asked for one to be
    decided; the ticket already keeps a newcomer out of the gap, so a pause would only
    cost every row time).
