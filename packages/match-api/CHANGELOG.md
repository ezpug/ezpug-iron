# @ezpug/match-api

A change to a schema is a release with a line here (decisions 3, 24).

## Unreleased

- The vocabulary: the platform's gameserver event union (22 types, contract version 1)
  copied verbatim, the SteamID64 grammar, `game`, `locale`, `mapRadar`.
- The Match API resources — `MatchRequest`, `Match`, `MatchCommand`,
  `MatchCommandResult`, `PlayerToken`, `Gamemode` (read side), `Capacity`, the fleet
  family, `ApiKey` — the `/v1` route table, the three scopes and the error vocabulary.
- `@ezpug/match-api/client`: the table-driven typed client.
- `@ezpug/match-api/fixtures`: one valid event per type.
