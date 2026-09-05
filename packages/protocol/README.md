# `@ezpug/protocol`

The wire protocols inside EZPug Iron (decision 2): internal, never published, free to
change — with the C# regenerated in the same commit.

Two links, both outbound WebSockets to the orchestrator, both one JSON text message per
frame with a `type` from a closed set:

- **The server link** (`src/server-link.ts`, `/link`) — every server's EZPug core plugin.
  Server → orchestrator: `hello`, `heartbeat`, `state`, `events`, `command_result`,
  `backup`, `console`, `player_command_result`. Orchestrator → server: `welcome`, `assign`,
  `command`, `player_command`, `profile`, `release`, `drain`, `ack`. The first exchange is
  always `hello` → `welcome`; events carry a per-server `seq` and every one is acked.
- **The node link** (`src/node-link.ts`, `/node`) — an `ezpug-node` agent. Node →
  orchestrator: `hello`, `heartbeat`, `instances`. Orchestrator → node: `welcome`, `start`,
  `stop`, `drain`, `undrain`. Nothing is acked: `instances` is a snapshot.

`src/constants.ts` holds the version, the paths (the two upgrades and the MatchZy door's `POST /matchzy/log` with its token header), the limits and the close codes.

## From Zod to C#

```
src/*.ts  ──tsdown──▶  dist/index.mjs
          ──scripts/protocol-schema.mjs──▶  schema/server-link.schema.json, node-link.schema.json
          ──scripts/protocol-codegen.mjs──▶  plugins/EZPug.Sdk/Generated/ServerLink.g.cs
```

`pnpm build` runs the chain; the three outputs are committed. `pnpm lint` runs the
generator in `--check` mode and fails when the C# is stale; `src/schema.test.ts` fails when
the JSON Schema is. The names a C# type gets are decided in `src/schema.ts` and nowhere
else. Only the server link has a C# side — the node agent is TypeScript.

The generator is our own (`scripts/protocol-codegen.mjs`, its header says why NJsonSchema
and quicktype were tried and rejected): records with `required`/`init` properties in schema
order, enums by wire name, an abstract record plus a dispatching converter per discriminated
union, doubles printed the way JavaScript prints them. `ProtocolJson.Options` is the one set
of serializer options the plugin uses.

## The fixtures

`fixtures/frames/*.json` hold one frame per type of every union (and every link command),
written from the tables in `src/fixtures.ts` through the schemas, so the bytes are the
canonical parse order. `src/fixtures.test.ts` asserts them byte for byte on the TypeScript
side; `plugins/EZPug.Sdk.Tests/ProtocolRoundTripTests.cs` reads each frame into its C# twin,
writes it back and asserts the same bytes — and does the same for every vocabulary event in
`packages/match-api/fixtures/recorded/*.json`. Re-record with
`pnpm --filter @ezpug/protocol record` and read the diff.

Nothing in a fixture is a secret; every token carries `not-a-secret` and a test checks it.

## The fake server, and the recorded link exchanges

`src/fake-server.ts` (`@ezpug/protocol/fake-server`) is a server that speaks the link from
TypeScript: it says `hello` first, sequences and buffers its events until an `ack` names
them, resends past `welcome.ackedSeq` on reconnect, answers `command` and `player_command`
by `correlationId`, and reports `state` after `assign`, `release` and `drain` — exactly what
the C# link client must do. The orchestrator's link tests connect it in place of a plugin
and record what crossed the socket, scrubbed, into `fixtures/link/*.json` (`{ schema:
"LinkExchange", exchange: [{ from, frame } | { from, close }] }`). Those files are proven
on both sides: `src/fixtures.test.ts` parses every frame with its direction's schema and
asserts the bytes, and `ProtocolRoundTripTests.cs` reads each into its C# twin and writes it
back. Re-record with `EZPUG_IRON_RECORD=1 pnpm --filter @ezpug/orchestrator test src/link`.
