# @ezpug/sim

The simulator engine of EZPug Iron (decision 9): the platform's seeded, clock-driven match
story, ported on 2026-09-05 and decoupled from the platform's provider interface. It is
what the orchestrator's `sim` provider runs and what the fake orchestrator in
`@ezpug/match-api/fake` embeds, so every test in both repos plays real matches without a
Counter-Strike server.

- `scenario.ts` — the named scenarios (`happy-path`, `overtime`, `pauses`, `comeback`,
  `no-show`, `server-crash`, `never-ready`), as data.
- `assignment.ts` — what a server is told to play, read from a MatchZy/Get5 config the way
  a plugin would (`readMatchAssignment`) or derived from a Match API request
  (`assignmentFromMatchRequest`).
- `story.ts` — one PRNG + one assignment + one scenario → the whole match as timed events,
  plus `resumeStory`: what a replacement server plays after loading a round backup.
- `server.ts` — `createSimulatedServer({clock, serverId})`: `assign`, `start`, `stop`,
  `step`, `setMode`, `setSpeed`, `setChaos`, `kill`, `restore`, `announce`, `status`, an
  `events` subscription yielding `seq`-stamped union events, `record()` for the simulated
  demo bytes, `backups()`.
- `record.ts` — the recording a simulated match leaves behind instead of a `.dem`.
- `fixtures/radar/` — Valve's overview calibration for the Active Duty maps, so position
  ticks land on real minimap coordinates; `fixtures/configs/` — the platform's config
  goldens the assignment reader is proven against.

Everything is deterministic: the injected `Clock` and the seeded `Prng` from `@ezpug/core`,
chaos composed at the delivery seam via `@ezpug/core/chaos`. The determinism test
(`determinism.test.ts`) is the extended tier's second suite (`pnpm verify:extended`).

Not published. `@ezpug/match-api` is a peer dependency (the vocabulary), never a graph
edge, so the published package can bundle this engine without a cycle.
