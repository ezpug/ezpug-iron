---
updatedAt: 2025-01-27T12:41:29.000Z
---

Fetch the complete documentation index at: https://dathost.readme.io/llms.txt. Use this file to discover all available pages before exploring further. Append .md to any documentation page URL to get its markdown version.

# Cancel Reasons

Below are all the possible reasons a match may be canceled, along with brief explanations.

`MISSING_PLAYERS:76561790470051450,76561703394109822`\
This reason is used when players are missing. A webhook is sent immediately after the specified connect\_time has expired, containing a comma-separated list of SteamID64s of the players who were not active on the server.

`NEW_MATCH_STARTED_ON_SERVER`\
If a new match is initiated on a server (identified by game\_server\_id) that already has an ongoing match, the ongoing match will be canceled in favor of the new one.

`USER_API_CANCEL`\
This reason is used when a cancellation is manually triggered via the API endpoint [POST /api/0.1/cs2-matches/\{match\_id}/cancel](https://dathost.net/reference/post_api-0-1-cs2-matches-match-id-cancel)

`TIMED_OUT`\
This reason is mainly used internally when a match has not received any updates for 6 hours, such as in cases of server crashes. Note that this cancel reason does not trigger a webhook to be sent.