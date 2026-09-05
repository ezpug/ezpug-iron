Fetch the complete documentation index at: https://dathost.readme.io/llms.txt. Use this file to discover all available pages before exploring further. Append .md to any documentation page URL to get its markdown version.

# CS2 Match-API Update: Event-Driven Webhooks

**Changelog:**

* Added support for event-driven webhooks via the new setting: `webhooks.event_url`
* Added a new parameter: `webhooks.enabled_events` (array of strings).

<p>&nbsp;</p>

**Details:**

We’ve added event-driven webhooks to give you more control over match event notifications. By setting an `webhooks.event_url`, you can receive webhooks for specific events through the `webhooks.enabled_events` array. Each event will include a UNIX timestamp to provide precise timing information. Use `["*"]` to subscribe to all events or select from the following list:

* `booting_server`
* `loading_map`
* `server_ready_for_players`
* `all_players_connected`
* `match_started`
* `match_ended`
* `players_exited`
* `gotv_stopped`
* `player_connected`
* `player_disconnected`
* `player_votekicked`
* `round_end`
* `match_canceled`

For example, you can set `webhooks.enabled_events: ["match_started", "match_ended"]` to only receive notifications for the start and end of a match.

**The existing webhook URLs will continue to work the same way**, but this feature offers greater flexibility for those wanting more granular control.

<p>&nbsp;</p>

Check out all these new options in the API reference here: [POST /api/0.1/cs2-matches](https://dathost.net/reference/post_api-0-1-cs2-matches)