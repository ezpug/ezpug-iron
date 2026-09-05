# EZPug Iron

The gameserver side of EZPug, the competitive CS2 platform of the SaarLAN community: the
**orchestrator** (a Match API over Dathost, self-hosted nodes and a simulator), the
**plugin SDK** and the EZPug core plugin on CounterStrikeSharp, the **gamemodes**, the
**node agent**, the **server image**. `docs/decisions.md` is the constitution — it wins
every conflict. The platform (`ezpug`, private, at `/root/ezpug` on this box) is our one
client and speaks only `@ezpug/match-api`; it must never need to know a server exists.

Public repo. Write everything as if strangers read it; they can.

## Layout

pnpm + Turborepo for TypeScript, one `plugins/EZPug.sln` for C#, one `pnpm verify` over
both. `packages/match-api` (published), `packages/protocol` (plugin↔orchestrator, internal,
C# generated from it), `packages/core` (clock, prng, chaos, `eventually` — a port of the
platform's, kept structurally identical), `packages/sim` (the simulator engine),
`apps/orchestrator`, `apps/node`, `apps/cli`, `plugins/` (SDK, core plugin, gamemodes,
vendored forks), `gamemodes/` (`@ezpug/gamemodes`: the manifests as data, bundled into the
published package and read by the apps and the plugin), `gamemode-kit/` (widget toolchain),
`docker/`, `scripts/`, `references/` (reference material, never imported), `ralph/` (the
loop).

## Invariants (the ones you can't infer from code)

- **The Match API is the only door.** Every capability a client needs — create a match,
  read it, command it, mint a player token, read the fleet, drain a provider, enrol a
  node — is a route in `@ezpug/match-api` first, as a Zod schema, before anything serves
  or consumes it. The platform's admin console is the operator UI; this repo ships none.
  A change to the package is a semver release with a changelog line, never a silent edit;
  the conformance suite (`@ezpug/match-api/fixtures`) passes against the fake **and** the
  real orchestrator on every verify.
- **One vocabulary.** The gameserver event union in `@ezpug/match-api` is the only
  language a server speaks to anyone. The core plugin emits it natively; MatchZy, retakes
  and any community plugin are translated into it once, inside the plugin or the
  orchestrator, never downstream. Position ticks are ephemeral: stream only, never stored,
  never replayed.
- **Every server dials out, every server is a ledger row.** A server's link to the
  orchestrator is one outbound WebSocket with a per-server token; nothing listens for
  inbound traffic except the orchestrator itself. An allocation writes a ledger row before
  the provider returns, deallocation closes it, and the reaper reconciles provider truth
  against *rows*. Budgets are enforced per API key here, not trusted to the caller. A live
  test that leaves a server running is a P1 written in the progress file before the next
  task.
- **Offline-first.** `pnpm dev:up` gives a full orchestrator on this box with the `sim`
  provider and a fake Dathost validated against the vendor's own OpenAPI; the SDK has a
  test harness that plays a gamemode without CS2. No test needs Dathost, Steam or a real
  server. The dev CS2 container (`pnpm cs2:up`) and Dathost are opt-in lanes behind
  `EZPUG_CS2_TESTS=required` / `EZPUG_DATHOST_TESTS=required`, skipped with a printed reason
  otherwise.
- **The plugin is thin, the SDK is the product.** `EZPug.Sdk` owns the link, the event
  model, timers, per-player state, player commands, i18n and the test harness; a gamemode
  is a class over it and a manifest beside it. CounterStrikeSharp types stay behind the
  SDK's seams so a gamemode test never needs the game. Vendored community plugins
  (MatchZy, retakes, the WeaponPaints fork) are pinned in `docs/pins.md` and never patched
  except the WeaponPaints data layer.
- **Determinism.** The injected clock and seeded PRNG from `packages/core` in anything
  that must reproduce; no bare `Date.now()`, `new Date()`, `Math.random()`, `setTimeout`
  outside it (the Biome plugin in `scripts/lint/` makes them errors); C# uses an injected
  `IClock`. `vi.waitFor` is an error; `eventually()` from `@ezpug/core/testing` is the wait.
- **Secrets stay in the process.** Dathost credentials, API keys, GSLTs, RCON passwords,
  node and server tokens, player tokens: env, the database's token tables (hashed) and
  memory only. A node token and an API key are shown once at mint. Never in a log line, a
  fixture, a webhook body, a widget bundle or a progress note; recorded fixtures are
  scrubbed before commit and a test greps them for the fakes' known secrets.
- **Bilingual where a human reads it.** Manifest titles and descriptions, in-game lines
  the plugin prints, widget copy: DE + EN, German default, the player's locale from the
  roster profile. Nothing the orchestrator says to a machine is translated.
- **Migrations are additive-safe** (Drizzle; expand → migrate → contract; a lint guard
  fails destructive SQL). `main` stays deployable; `./scripts/deploy.sh` is the whole
  deploy and its smoke step is what "deployed" means.

## Verify

`pnpm verify` = strict typecheck + Biome + Vitest across the TS workspace via Turbo, plus
`dotnet build -warnaserror` and `dotnet test` over `plugins/EZPug.sln` wrapped as Turbo
tasks (net10.0 on the .NET SDK `plugins/global.json` pins — CounterStrikeSharp moved to
.NET 10 with 1.0.369; `docs/pins.md` holds every pin and a lint check keeps it honest).
Green means commit, red means fix; a flaky test is a P1 against the spine.
`pnpm verify:extended` adds the live world: compose up (Postgres, Redis), the orchestrator
in sim mode driven through the real HTTP surface, the conformance suite against it, the
fault-injection suite, the dev CS2 lane when its container is up, the Dathost smoke when
demanded. Deploying is pre-authorized on this box (`./scripts/deploy.sh`, any verb);
destroying a volume, dropping a database or editing another project's Traefik file still
needs a human.

## The box

Ports were chosen against `ss -tlnp` on a machine full of other projects and are decided
only in `.env.example`: orchestrator **3430** (dev), Postgres **5443**, Redis **6383**, the
dev CS2 server **27415** (game) and **27420** (GOTV), production orchestrator bound to
`172.17.0.1:3431` behind `gs.ezpug.com` (`docker/traefik/ezpug-iron.yml`, the one file in
`/opt/traefik/routes/` this repo owns). The platform's dev world lives at `/root/ezpug`
on the same box and pulls this repo's orchestrator image; when you change the Match API,
the platform's pin is where it learns.

## Ralph

`ralph/` holds the loop scripts, PRD conventions (`PRD-TEMPLATE.md`) and the per-round PRDs
with their progress files. One task per iteration. Tasks tagged `(fable)` run on Claude
Fable 5.1 (architecture, contracts, the SDK's core); everything else on Opus 5.
`/next-task` and `/finish-task` bracket an iteration.
