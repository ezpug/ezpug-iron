# MatchZy translation fixtures

One file per MatchZy remote-log event: the payload as MatchZy POSTs it and the vocabulary
events the translator turns it into (`translate.test.ts` plays every file, in filename
order). They are written by `pnpm --filter @ezpug/orchestrator fixtures:matchzy`, which
runs the translator and records what it said — so the `expect` block is never typed by
hand and a rule that moves shows up here as a diff a reader can argue with.

`source` says where the payload came from, and `from` says exactly where (PRD-02 T13):

- **`recorded`** — bytes a real MatchZy 0.8.15 sent to the door during
  `scripts/iron-match.mjs`: a `pug` with ten bots on the dev node, four rounds, one map.
  The whole exchange is kept in `packages/protocol/fixtures/recorded/real-pug-matchzy.json`.
  These carry the story's state from one file to the next, because the round winner is a
  score delta.
- **`derived`** — one of those payloads, edited to make a case one bots match on one map
  cannot produce: a draw, a lost POST, an unreadable side, a foreign `matchid`. `from`
  names the recorded file it was edited from, so the diff between the two is the whole of
  what was invented, and `state` says what score it starts from.
- **`upstream`** — an event our flow never produces at all: the veto trio (the platform
  vetoes), `demo_upload_ended` (the core plugin owns the upload, decision 10) and
  `player_disconnect` (the plugin speaks it from the engine). Their shape is read off
  MatchZy's own source, `from` names the file, and the only thing asserted about them is
  that the door **drops** them — which no payload detail can change.

`fixtures.test.ts` holds every one of those rules, including that no `schema`-sourced
placeholder survives now that T13 is ticked.

The match in every file is `FIXTURE_MATCH_ID` from `@ezpug/match-api/fixtures`, the serial
MatchZy knows it by is `matchzySerial(FIXTURE_MATCH_ID)`, the server is `nodes/devbox-1`,
and the plan is one map, `de_dust2` — the map the recording was played on — with team A
starting CT.
