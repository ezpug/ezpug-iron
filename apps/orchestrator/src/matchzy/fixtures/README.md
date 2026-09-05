# MatchZy translation fixtures

One file per MatchZy remote-log event: the payload as MatchZy POSTs it and the vocabulary
events the translator turns it into (`translate.test.ts` plays every file). `source` says
where the payload came from:

- `schema` — written from `references/MatchZy/documentation/docs/event_schema.yml` (0.8.15)
  and the code where the two disagree (`winner.side` is an engine team number, `round_number`
  is the post-round score sum, a drawn map names team2). A placeholder until a real server
  spoke.
- `recorded` — captured from a real MatchZy on the dev node by `scripts/iron-match.mjs`
  (PRD-02 T13), scrubbed.

`fixtures.test.ts` fails once PRD-02 T13 is ticked and a `schema`-sourced file is still here:
the recordings replace them, they do not sit beside them.

The match in every file is `FIXTURE_MATCH_ID` from `@ezpug/match-api/fixtures`, the serial
MatchZy knows it by is `matchzySerial(FIXTURE_MATCH_ID)`, the server is `nodes/devbox-1`,
and the plan is one map, `de_mirage`, team A starting CT.
