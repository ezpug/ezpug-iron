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
    `retakes` (B3none/cs2-retakes under the SDK: its own flow, its own map pool, events
    without a demo). *Custom SDK mode* — `powerup-dm` (an original deathmatch where a phone
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
    MatchZy owns match flow for `pug` (`going_live`, `round_end`, `map_end`, `series_end`);
    the core plugin owns what MatchZy cannot see (players, deaths, bomb, positions, chat,
    heartbeat, backups, the gamemode loader, the link). Neither double-speaks the other's
    events. Prefer MatchZy's in-process forwards over its HTTP remote log where they cover
    an event; where they do not, the remote log points at the orchestrator.
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

## How the rounds run

24. **Spine first, then two loops in parallel.** `ralph/PRD-01-spine.md` (this repo, ~10
    tasks, about half on Fable) settles the contracts, the fake, the fixtures and the first
    publish, alone. Then `ralph/PRD-02-iron.md` here (~40 tasks, ~30% Fable) and the
    platform's `ralph/PRD-09-iron-platform.md` (~32 tasks, ~15% Fable) run at the same
    time, one screen session each, in two repos. Contracts are frozen after the spine; a
    contract change during the parallel rounds is a **release from this repo** with a
    changelog line, and the platform loop picks it up by bumping the pin — never by
    editing a schema on its side.
