# MatchZy translation fixtures

One file per MatchZy remote-log event: the payload as MatchZy POSTs it and the vocabulary
events the translator turns it into (`translate.test.ts` plays every file, in filename
order). They are written by `pnpm --filter @ezpug/orchestrator fixtures:matchzy`, which
runs the translator and records what it said — so the `expect` block is never typed by
hand and a rule that moves shows up here as a diff a reader can argue with.

`source` says where the payload came from, and `from` says exactly where (PRD-02 T13,
re-planned for MatchZy-Enhanced by PRD-03 T3):

- **`recorded`** — bytes a real MatchZy sent to the door during `scripts/iron-match.mjs`:
  a `pug` with ten bots on the dev node, three rounds, one map, re-recorded on
  MatchZy-Enhanced 1.4.32 in T2. The whole exchange is kept in
  `packages/protocol/fixtures/recorded/real-pug-matchzy.json`. These carry the story's
  state from one file to the next, because the round winner is a score delta. The
  generator picks them **by name and occurrence, never by index** — the re-record moved
  every position in the file.
- **`derived`** — one of those payloads, edited to make a case one bots match on one map
  cannot produce: a draw, a lost POST, an unreadable side, a foreign `matchid`, a backup
  restore. `from` names the recorded file it was edited from, so the diff between the two
  is the whole of what was invented, and `state` says what score it starts from.
- **`upstream`** — an event the recorded run never produced at all. Its shape is read off
  MatchZy's own serialisers and `from` names the file under `references/`. Two kinds live
  here, and the `expect` block says which is which:
  - **dropped**, and nothing a payload holds can change that: the veto trio (the platform
    vetoes), the demo events (the core plugin owns the demo, decision 10), the pause pair
    and `player_connect` / `side_swap` (the core plugin speaks them from the engine), and
    the server-level `server_health` / `server_configured`;
  - **translated**, because the dev lane force-starts and so no run has ever readied up or
    knifed: `player_ready`, `player_unready`, `team_ready`, `all_players_ready` and the two
    knife events. **These are owed a recording** — PRD-03 T5 plays a pug whose puppets
    ready up through MatchZy's own ready system, and they become `recorded` there.

`fixtures.test.ts` holds every one of those rules, including that no `schema`-sourced
placeholder survives now that PRD-02 T13 is ticked.

The match in every file is `FIXTURE_MATCH_ID` from `@ezpug/match-api/fixtures`, the serial
MatchZy knows it by is `matchzySerial(FIXTURE_MATCH_ID)`, the server is `nodes/devbox-1`,
and the plan is one map, `de_dust2` — the map the recording was played on — with team A
starting CT. The roster is one player a side, `tk` on team A and `maex` on team B, so a
ready event's team comes from the SteamID the request named rather than from the free team
name MatchZy echoes beside it.
