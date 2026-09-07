# EZPug Iron

The gameserver side of [EZPug](https://ezpug.com), the SaarLAN community's competitive
CS2 platform: an orchestrator that turns "we need a server for these ten people, this
gamemode, this region" into a running Counter-Strike server on Dathost or on a
self-hosted node, the CounterStrikeSharp plugin SDK and plugins that run on it, the
gamemodes, the node agent and the server image.

- `packages/match-api` — `@ezpug/match-api`, the published contract: schemas, typed
  client, webhook verifier, conformance fixtures and an in-process fake orchestrator.
- `packages/protocol` — the wire protocols inside the repo: the server link a plugin dials
  the orchestrator on and the node link an `ezpug-node` dials it on, Zod first, exported as
  JSON Schema, the C# twins generated from that into `plugins/EZPug.Sdk/Generated/`.
- `packages/sim` — the simulator engine: a seeded, clock-driven CS2 match with rounds,
  deaths, bomb, chat and positions, and no game anywhere near it.
- `packages/core` — the injected clock, the seeded PRNG, chaos toggles and `eventually()`:
  the determinism primitives everything reproducible is built on.
- `gamemodes/` — the gamemode manifests as data (`pug`, `flying-scoutsman`, `retakes`,
  `powerup-dm`); the package bundles them, the orchestrator and the plugin read them.
- `apps/orchestrator` — the service behind `gs.ezpug.com`.
- `apps/node` — `ezpug-node`, turns a docker host into capacity.
- `plugins/` — `EZPug.Sdk`, the core plugin, gamemodes and pinned vendored plugins.
- `gamemode-kit/` — the toolchain for a gamemode's phone widget: the runtime a widget is written on, the Vite preset that builds `gamemodes/<id>/widget/` into one bundle, and a dev harness against the fake (`pnpm --filter @ezpug/gamemodes exec ezpug-widget dev powerup-dm`; `docs/gamemodes.md` "Building a widget").
- `docs/decisions.md` — why things are the way they are. Start there.
- `docs/match-api.md` — the contract, written to be read instead of the code.
  `docs/gamemodes.md` is the manifest, `docs/pins.md` every version we are fixed to.

Status: **the spine round (`ralph/PRD-01-spine.md`) is done.** `@ezpug/match-api` 0.1.0 —
the vocabulary, the Match API, the webhooks, the stream, the manifests, a typed client, a
webhook verifier, an in-process fake orchestrator that plays real matches on the simulator
engine, and a conformance suite with recorded golden files — is built, verified and tagged
`match-api@0.1.0`; publishing it to npm is waiting on an `npm login` (see the `> blocked:`
note under T9 in the PRD). Everything named above that does not exist yet — the
orchestrator, the node agent, the SDK, the plugins, the image — is `ralph/PRD-02-iron.md`.

## Running it

You need Node 22 (`>=22.19 <23`), pnpm 10 (`corepack enable` reads the version from
`package.json`) and the .NET SDK named in `plugins/global.json`. The
[dotnet-install script](https://learn.microsoft.com/dotnet/core/tools/dotnet-install-script)
puts it beside any other SDK without touching the system:

```sh
curl -sSL https://dot.net/v1/dotnet-install.sh | bash -s -- --channel 10.0 --install-dir ~/.dotnet
```

Then:

```sh
pnpm install
pnpm verify            # typecheck + lint + test over TS and C#, then turbo boundaries
pnpm verify:extended   # the same, plus the suites that need a running world
```

`pnpm verify` is the definition of green: the published package's build (`tsdown`), strict `tsc` per package, one Biome run over the
repo with the lint guards in `scripts/lint/` (the determinism guard makes a bare
`Date.now()`, `new Date()`, `Math.random()` or `setTimeout` an error outside
`packages/core`; the waiting-budget guard refuses `vi.waitFor` in tests), Vitest per
package, `dotnet build -warnaserror` and `dotnet test` over `plugins/EZPug.sln`, and
`turbo boundaries` over the package tags declared in `turbo.json`. The same command runs
in GitHub Actions on every push and pull request (`.github/workflows/verify.yml`).

Useful pieces of it:

```sh
pnpm lint:fix                                   # let Biome rewrite formatting and imports
pnpm exec turbo run test --filter=@ezpug/core   # one package
pnpm --filter @ezpug/plugins typecheck          # just the C# build
```

Ports and every other setting the repo reads are decided in `.env.example`; copy it to
`.env` for local overrides. Nothing in `pnpm verify` needs a database, a CS2 server or
Dathost — the orchestrator's database suites skip with a printed reason when the dev
world is down, and `pnpm verify:extended` boots it and makes them required.

## The dev world

```sh
pnpm dev:up      # Postgres (5443) and Redis (6383) from compose.yaml, migrated; creates .env
pnpm dev         # the orchestrator on http://localhost:3430, restarting on change
pnpm dev:status  # a real query against each service, and whether the orchestrator answers
pnpm dev:down    # stop, keep the data
```

The first API key comes from the box: `pnpm --filter @ezpug/orchestrator keys:mint --
--name root --scopes admin` prints it once. `docs/operations.md` is the operator's
reference — the environment, the schema, migrations, keys, what is and is not stored.

A real CS2 server on this box is one lane further, and opt-in because the game is tens of
gigabytes:

```sh
pnpm cs2:build     # the server image: Metamod, CounterStrikeSharp, MatchZy, EZPug.Core, the cfg set
pnpm cs2:install   # the game itself, once, into a docker volume — never into the checkout
pnpm cs2:up        # a dedicated server on 27415 (GOTV 27420), dialling the orchestrator
pnpm cs2:console   # attach to its console (detach: Ctrl-P Ctrl-Q)
```

A venue box runs that same image under **`ezpug-node`** (`apps/node`), the agent that
enrols against an orchestrator and starts server containers when it is told to; the
orchestrator sees every enrolled node as one free, LAN-capable provider, so a match asking
for `requirements.lan` lands there first. `docs/nodes.md` installs one in five commands.
This box can be one too:

```sh
# with `EZPUG_IRON_PROVIDERS=sim,nodes` in .env and `pnpm dev` running
pnpm dev:node up      # mint a key, enrol, run the agent in the background
pnpm dev:node status  # what it is, what docker says, when it last dialled
pnpm dev:node down    # stop the agent — its containers keep running
```

`pnpm dev:up` does that for you when both conditions hold, and prints why it did not
otherwise. Adding `nodes` is opt-in because registering a *real* provider takes the
simulator out of selection for every request that did not ask for it — right at a venue,
wrong on an offline afternoon.

With a node up, one command plays a whole match on it and writes down everything it said:

```sh
pnpm iron:match                  # a pug with bots, four rounds, through the Match API
pnpm iron:match --write-fixtures # …and update the recorded fixtures from this run
```

It is a client and nothing more — it holds an API key, POSTs a match, listens on a webhook
endpoint of its own and on the match's stream, forces the start (a bot never types
`.ready`), and releases its server in a `finally` and on a Ctrl-C. Roughly ten minutes and
one CS2 container; `docs/operations.md`, "One real match, recorded", is the long version,
and `EZPUG_CS2_TESTS=required` turns it into a test.

## `ezpug-iron`, the command

`pnpm iron` is the operator's terminal over the same Match API the platform speaks — every
verb one call on the typed client, `--json` on every one of them:

```sh
export EZPUG_IRON_API_KEY=$(pnpm --filter @ezpug/orchestrator keys:mint -- \
  --name me --scopes admin | tail -1)     # the first key of a fresh database

pnpm iron --help                          # the map
pnpm iron keys create --name platform --scopes matches \
  --webhook-secret whsec-2026-09          # a key that can create matches; both secrets, once
pnpm iron gamemodes list                  # what this orchestrator will play
pnpm iron matches create --file req.json  # a Match API request document
pnpm iron matches watch <matchId>         # the live stream until it closes
pnpm iron servers list                    # the ledger: what is running, what it cost
pnpm iron budget                          # this key's ceilings and this month
```

The key is read from the environment and never from a flag (a flag lands in the shell's
history and in `/proc`); `EZPUG_IRON_CLI_URL` or `--url` points it somewhere other than
this box. A relative `--file` resolves where you typed it, not where pnpm ran the command
(`INIT_CWD`). `pnpm --silent iron … --json | jq` when you mean to pipe it. The long version,
including the exit codes a script branches on, is `docs/operations.md`.

## Releasing

### `@ezpug/match-api`

The package is the contract, so a schema change is a release with a changelog line, never
a silent edit (`docs/decisions.md` 24). `scripts/release.mjs` is the whole path:

```sh
pnpm release version 0.2.0   # bump packages/match-api, roll its CHANGELOG, print the tag
pnpm verify:extended         # the conformance suite is the gate
git commit -am 'chore(match-api): 0.2.0'
git tag match-api@0.2.0 && git push origin match-api@0.2.0
```

The tag fires `.github/workflows/release.yml`, which re-verifies, packs, audits the tarball
(`publint`, `arethetypeswrong`) and runs `npm publish --access public --provenance` with the
`NPM_TOKEN` repository secret. `pnpm release publish` is the same path locally for an owner
who is `npm login`ed, and `pnpm release check` is the audit alone — it also runs inside
`pnpm verify:extended`, so a tarball that would break on install goes red long before a
release. Packing goes through pnpm on purpose: `npm pack` resolves neither the workspace's
`catalog:` versions nor `publishConfig.exports`. The reference for what is in the package is
`docs/match-api.md`.

### The images, and the plugin zip

The other artifacts are tags too, and each one runs `pnpm verify` on the tagged commit
before it publishes anything:

```sh
git tag orchestrator@0.1.0 && git push origin orchestrator@0.1.0  # ghcr.io/ezpug/ezpug-iron/…
git tag node@0.1.0         && git push origin node@0.1.0
git tag cs2@0.1.0          && git push origin cs2@0.1.0
git tag plugins@0.1.0      && git push origin plugins@0.1.0       # the zip on the release
```

`pnpm release:image plan <tag>` prints what a tag would publish — the Dockerfile, the
platforms (amd64 and arm64 for the two JavaScript images, amd64 only for the CS2 one), the
registry tags — and `.github/workflows/images.yml` publishes nothing the script did not
say. The plugin zip is `plugins/publish.sh`'s tree, for a server whose image this repo
does not build; the version in the tag has to be the one `plugins/EZPug.Core` carries. `docs/pins.md` records which image tags exist and who pins
them, and `docs/operations.md` ("Releasing: CI and the tags") is the long version.
