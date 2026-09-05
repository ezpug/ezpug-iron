# EZPug Iron

The gameserver side of [EZPug](https://ezpug.com), the SaarLAN community's competitive
CS2 platform: an orchestrator that turns "we need a server for these ten people, this
gamemode, this region" into a running Counter-Strike server on Dathost or on a
self-hosted node, the CounterStrikeSharp plugin SDK and plugins that run on it, the
gamemodes, the node agent and the server image.

- `packages/match-api` — `@ezpug/match-api`, the published contract: schemas, typed
  client, webhook verifier, conformance fixtures and an in-process fake orchestrator.
- `packages/core` — the injected clock, the seeded PRNG, chaos toggles and `eventually()`:
  the determinism primitives everything reproducible is built on.
- `apps/orchestrator` — the service behind `gs.ezpug.com`.
- `apps/node` — `ezpug-node`, turns a docker host into capacity.
- `plugins/` — `EZPug.Sdk`, the core plugin, gamemodes and pinned vendored plugins.
- `gamemode-kit/` — the toolchain for a gamemode's phone widget.
- `docs/decisions.md` — why things are the way they are. Start there.

Status: the spine round (`ralph/PRD-01-spine.md`) is being built.

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
Dathost.

## Releasing `@ezpug/match-api`

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
