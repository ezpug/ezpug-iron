# EZPug Iron

The gameserver side of [EZPug](https://ezpug.com), the SaarLAN community's competitive
CS2 platform: an orchestrator that turns "we need a server for these ten people, this
gamemode, this region" into a running Counter-Strike server on Dathost or on a
self-hosted node, the CounterStrikeSharp plugin SDK and plugins that run on it, the
gamemodes, the node agent and the server image.

- `packages/match-api` — `@ezpug/match-api`, the published contract: schemas, typed
  client, webhook verifier, conformance fixtures and an in-process fake orchestrator.
- `apps/orchestrator` — the service behind `gs.ezpug.com`.
- `apps/node` — `ezpug-node`, turns a docker host into capacity.
- `plugins/` — `EZPug.Sdk`, the core plugin, gamemodes and pinned vendored plugins.
- `gamemode-kit/` — the toolchain for a gamemode's phone widget.
- `docs/decisions.md` — why things are the way they are. Start there.

Status: the spine round (`ralph/PRD-01-spine.md`) is being built.
